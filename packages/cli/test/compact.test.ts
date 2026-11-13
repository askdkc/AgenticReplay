import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { compactRun, TraceReader, TraceWriter } from '@agenticreplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { compactCommand } from '../src/commands/compact.js';
import { main } from '../src/main.js';

let cwd: string;
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
async function fixture(sealed = true) {
  cwd = await mkdtemp(join(tmpdir(), 'ar-compact-'));
  const writer = await TraceWriter.create(join(cwd, '.agenticreplay', 'runs'), {
    adapter: { id: 'test' },
    argv: [],
    cwd,
    agenticreplayVersion: 'test',
  });
  const payload = 'legacy conversation '.repeat(1000);
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  const event = await writer.append({ type: 'note', actor: 'agenticreplay', payload });
  if (sealed) {
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    await writer.close(0);
  } else await writer.suspend();
  const ref = event.payload as { $blob: string };
  const digest = ref.$blob.slice(7);
  const raw = join(writer.runDir, 'blobs', digest.slice(0, 2), digest);
  const packed = await readFile(`${raw}.gz`);
  await writeFile(raw, gunzipSync(packed), { mode: 0o600 });
  await rm(`${raw}.gz`);
  return { dir: writer.runDir, raw, packed, payload, event };
}

it('dry-run changes nothing; conversion preserves references and can be repeated', async () => {
  const f = await fixture();
  const before = await readFile(f.raw);
  const events = await readFile(join(f.dir, 'events.jsonl'));
  const manifest = await readFile(join(f.dir, 'manifest.json'));
  const out = new Output({ write: () => {}, isTTY: false });
  const dry = await compactCommand(parseArgs(['compact', '--dry-run']), out, cwd);
  expect(dry[0]!.converted).toBe(1);
  expect(await readFile(f.raw)).toEqual(before);
  await expect(stat(`${f.raw}.gz`)).rejects.toThrow();
  expect(await main(['compact'], cwd)).toBe(0);
  expect(await readFile(join(f.dir, 'events.jsonl'))).toEqual(events);
  expect(await readFile(join(f.dir, 'manifest.json'))).toEqual(manifest);
  await expect(stat(f.raw)).rejects.toThrow();
  expect(gunzipSync(await readFile(`${f.raw}.gz`))).toEqual(before);
  expect(await (await TraceReader.open(f.dir)).resolvePayload(f.event)).toBe(f.payload);
  expect((await compactRun(f.dir)).converted).toBe(0);
});
it('leaves an unfinished run untouched', async () => {
  const f = await fixture(false);
  expect((await compactRun(f.dir)).reason).toBe('run is not sealed');
  expect(await stat(f.raw)).toBeDefined();
});
it('resumes after publication when both representations exist', async () => {
  const f = await fixture();
  await writeFile(`${f.raw}.gz`, f.packed);
  const size = (await stat(f.raw)).size;
  const result = await compactRun(f.dir);
  expect(result.savedBytes).toBe(size);
  expect(result.converted).toBe(1);
  await expect(stat(f.raw)).rejects.toThrow();
});
it('never deletes the original when an existing gzip file is corrupt or mismatched', async () => {
  const f = await fixture();
  for (const packed of [Buffer.from('corrupt'), gzipSync('different content')]) {
    await writeFile(`${f.raw}.gz`, packed);
    await expect(compactRun(f.dir)).rejects.toThrow();
    expect(await stat(f.raw)).toBeDefined();
  }
});
it('rejects corrupted source bytes and event integrity', async () => {
  const f = await fixture();
  const raw = await readFile(f.raw);
  await writeFile(f.raw, Buffer.alloc(raw.length, 65));
  await expect(compactRun(f.dir)).rejects.toThrow(/blob integrity/);
  expect(await stat(f.raw)).toBeDefined();
  await writeFile(f.raw, raw);
  await writeFile(join(f.dir, 'events.jsonl'), '{}\n');
  await expect(compactRun(f.dir)).rejects.toThrow(/event integrity/);
});
it.skipIf(process.platform === 'win32')(
  'rejects a symlinked blob and leaves the target alone',
  async () => {
    const f = await fixture();
    const content = await readFile(f.raw);
    const outside = join(cwd, 'outside');
    await writeFile(outside, content);
    await rm(f.raw);
    await symlink(outside, f.raw);
    await expect(compactRun(f.dir)).rejects.toThrow(/unsafe/);
    expect(await readFile(outside)).toEqual(content);
  },
);
it('demonstrates the current Kiokuko direct-path incompatibility', async () => {
  const f = await fixture();
  // Both downstream readers currently use the bare digest path, not TraceReader.blob().
  const legacyRead = () => readFile(f.raw);
  expect(
    createHash('sha256')
      .update(await legacyRead())
      .digest('hex'),
  ).toBe(f.raw.split('/').at(-1));
  await compactRun(f.dir);
  await expect(legacyRead()).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await (await TraceReader.open(f.dir)).resolvePayload(f.event)).toBe(f.payload);
});

it('automatically compacts on ordinary CLI startup without a compact command', async () => {
  const f = await fixture();
  expect(await main(['list'], cwd)).toBe(0);
  await expect(stat(f.raw)).rejects.toThrow();
  expect(await (await TraceReader.open(f.dir)).resolvePayload(f.event)).toBe(f.payload);
  const marker = JSON.parse(await readFile(join(f.dir, '.blob-compaction-v1.json'), 'utf8'));
  expect(marker.complete).toBe(true);
});

it('does not migrate on help, version or explicit dry-run maintenance', async () => {
  const f = await fixture();
  for (const args of [['--version'], ['--help'], ['compact', '--dry-run'], ['gc', '--dry-run']]) {
    expect(await main(args, cwd)).toBe(0);
    expect(await stat(f.raw)).toBeDefined();
  }
});

it('checkpoints bounded work and continues on the next process startup', async () => {
  const f = await fixture();
  const paths: string[] = [f.raw];
  for (let i = 0; i < 12; i++) {
    const bytes = Buffer.from(`legacy ${i} ` + 'z'.repeat(10000));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const shard = join(f.dir, 'blobs', digest.slice(0, 2));
    await mkdir(shard, { recursive: true, mode: 0o700 });
    const path = join(shard, digest);
    await writeFile(path, bytes, { mode: 0o600 });
    paths.push(path);
  }
  let total = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    // Simulate a fresh process while retaining the on-disk checkpoint.
    vi.resetModules();
    const { autoCompact } = await import('../../core/src/auto-compact.js');
    const result = await autoCompact(cwd);
    expect(result.failed).toBe(0);
    expect(result.converted).toBeLessThanOrEqual(8);
    total += result.converted;
    const sameProcess = await autoCompact(cwd);
    expect(sameProcess).toBe(result);
    const marker = JSON.parse(await readFile(join(f.dir, '.blob-compaction-v1.json'), 'utf8'));
    if (attempt === 0) expect(marker.complete).toBe(false);
    if (marker.complete) break;
  }
  expect(total).toBe(paths.length);
  for (const path of paths) {
    await expect(stat(path)).rejects.toThrow();
    expect(await stat(`${path}.gz`)).toBeDefined();
  }
});

it('does not abort startup or remove original bytes when automatic conversion fails', async () => {
  const f = await fixture();
  await writeFile(`${f.raw}.gz`, 'bad gzip');
  expect(await main(['list'], cwd)).toBe(0);
  expect(await stat(f.raw)).toBeDefined();
  await expect(stat(join(f.dir, '.blob-compaction-v1.json'))).rejects.toThrow();
});

it('also migrates through the embedded recorder startup path', async () => {
  const f = await fixture();
  const { ensureRunsDir } = await import('@agenticreplay/core');
  await ensureRunsDir(cwd);
  await expect(stat(f.raw)).rejects.toThrow();
  expect(await (await TraceReader.open(f.dir)).resolvePayload(f.event)).toBe(f.payload);
});
