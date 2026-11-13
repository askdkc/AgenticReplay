import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { BlobStore, TraceReader, TraceWriter } from '@agenticreplay/core';
import { exportTraceHtml, readTraceDir } from '@agenticreplay/viewer';
import { readViewerBlob } from '../../viewer/src/blob-file.js';
import { readArchive, writeArchive } from '../src/archive.js';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { scrubCommand } from '../src/commands/scrub.js';
import { gcCommand } from '../src/commands/gc.js';

let cwd: string;
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

it('records, reads, exports, scrubs and collects a compressed run without losing referenced blobs', async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ar-compressed-run-'));
  const writer = await TraceWriter.create(join(cwd, '.agenticreplay', 'runs'), {
    adapter: { id: 'test' },
    argv: [],
    cwd,
    agenticreplayVersion: 'test',
  });
  const body = 'NEEDLE conversation text. '.repeat(1000);
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  const event = await writer.append({
    type: 'net.response',
    actor: 'agenticreplay',
    payload: body,
  });
  await writer.append({ type: 'run.end', actor: 'agenticreplay' });
  await writer.close(0);
  const reader = await TraceReader.open(writer.runDir);
  expect(await reader.resolvePayload(event)).toBe(body);
  const ref = event.payload as { $blob: string; bytes: number };
  const hex = ref.$blob.slice(7);
  const path = join(writer.runDir, 'blobs', hex.slice(0, 2), hex);
  expect((await stat(`${path}.gz`)).size).toBeLessThan(ref.bytes / 10);
  // The download handler uses this same bounded decoder.
  expect(JSON.parse((await readViewerBlob(path)).toString())).toBe(body);
  await expect(readViewerBlob(path, ref.bytes - 1)).rejects.toThrow();
  expect((await readTraceDir(writer.runDir, { maxBlobBytes: ref.bytes - 1 })).omittedBlobs).toBe(1);
  expect((await readTraceDir(writer.runDir, { maxBlobBytes: ref.bytes })).blobs[ref.$blob]).toBe(
    JSON.stringify(body),
  );
  const html = join(cwd, 'export.html');
  await exportTraceHtml(writer.runDir, html);
  expect(await readFile(html, 'utf8')).toContain('NEEDLE conversation text.');

  const orphan = await new BlobStore(join(writer.runDir, 'blobs')).put('unused '.repeat(1000));
  const out = new Output({ write: () => {}, isTTY: false });
  expect((await gcCommand(parseArgs(['gc']), out, cwd)).blobsRemoved).toBe(1);
  expect(await new BlobStore(join(writer.runDir, 'blobs')).has(orphan)).toBe(false);
  expect(await reader.resolvePayload(event)).toBe(body);
  const original = await readFile(`${path}.gz`);
  const name = `run/blobs/${hex.slice(0, 2)}/${hex}.gz`;
  const archive = await readArchive(await writeArchive([{ name, bytes: original }]));
  expect(archive[0]!.name).toBe(name);
  expect(Buffer.from(archive[0]!.bytes)).toEqual(original);
  await scrubCommand(parseArgs(['scrub', 'last', '--match', 'NEEDLE', '--dry-run']), out, cwd);
  expect(await readFile(`${path}.gz`)).toEqual(original);
  // Crash debris is compressed too; scrub must not silently skip it as binary.
  const temporary = `${path}.gz.deadbeef.tmp`;
  await writeFile(temporary, gzipSync('NEEDLE in partial write'));
  await scrubCommand(parseArgs(['scrub', 'last', '--match', 'NEEDLE']), out, cwd);
  expect(gunzipSync(await readFile(temporary)).toString()).not.toContain('NEEDLE');
  await expect(stat(`${path}.gz`)).rejects.toThrow();
  const scrubbed = await TraceReader.open(writer.runDir);
  const events = await scrubbed.events();
  expect(await scrubbed.resolvePayload(events[1]!)).not.toContain('NEEDLE');
  expect((await scrubbed.verifyIntegrity()).ok).toBe(true);
  expect((await gcCommand(parseArgs(['gc']), out, cwd)).blobsRemoved).toBe(0);
});
