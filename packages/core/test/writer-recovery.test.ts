import { mkdtemp, readdir, realpath, readFile, rm, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TraceReader } from '../src/reader.js';
import { TraceWriter } from '../src/writer.js';

it('rolls back a partial failed event write and retries close publication without a duplicate end', async () => {
  const root = await realpath(await mkdtemp('/tmp/ar-writer-retry-'));
  const writer = await TraceWriter.create(root, {
    cwd: root,
    argv: [],
    envAllowlist: [],
    adapter: { id: 'codex-desktop-api' },
    agenticreplayVersion: 'test',
    sessionTitle: 'Codex turn',
  });
  const handle = await open(root + '/probe', 'w');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = prototype.writeFile;
  let failed = false;
  let closeFailed = false;
  const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
    this: any,
    data: any,
    ...rest: any[]
  ) {
    if (!failed && typeof data === 'string' && data.includes('"type":"run.end"')) {
      failed = true;
      await original.call(this, data.slice(0, 20), ...rest);
      throw Object.assign(new Error('full disk'), { code: 'ENOSPC' });
    }
    if (failed && !closeFailed && typeof data === 'string' && data.includes('"ended_at"')) {
      closeFailed = true;
      throw Object.assign(new Error('full disk'), { code: 'ENOSPC' });
    }
    return original.call(this, data, ...rest);
  });
  try {
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    await expect(writer.append({ type: 'run.end', actor: 'agenticreplay' })).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    await expect(writer.close()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(
      JSON.parse(await readFile(writer.runDir + '/manifest.json', 'utf8')).capture.status,
    ).toBe('unverified');
    const manifest = await writer.close();
    expect(manifest.capture?.status).toBe('incomplete');
    const events = (await readFile(writer.runDir + '/events.jsonl', 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((e) => e.type)).toEqual(['run.start', 'run.end']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('resumes creation after manifest publication but before the empty event file exists', async () => {
  const root = await realpath(await mkdtemp('/tmp/ar-create-gap-'));
  const init = {
    runId: 'run_123456abcdef',
    sessionStartedAt: new Date('2026-11-07T00:00:00Z'),
    sessionTitle: 'Codex turn',
    cwd: root,
    argv: [],
    envAllowlist: [],
    adapter: { id: 'codex-desktop-api' },
    agenticreplayVersion: 'test',
  };
  let writer = await TraceWriter.create(root, init);
  try {
    await writer.suspend();
    await rm(writer.runDir + '/events.jsonl');
    const before = await readFile(writer.runDir + '/manifest.json', 'utf8');
    writer = await TraceWriter.create(root, init, {});
    expect(await readFile(writer.runDir + '/manifest.json', 'utf8')).toBe(before);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    expect((await writer.close()).capture?.status).toBe('incomplete');
  } finally {
    await writer.suspend();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A rotation interrupted at each of its three dangerous instants (spec §1.1).
 *
 * The cases are staged directly on disk rather than by killing a process, because what matters is
 * the STATE each crash leaves, and each one is reproduced exactly: a new file created with nothing
 * in it, a new file holding its first event, and a live file whose first event is in place while
 * the manifest still describes the older layout. What the writer must do with each is the same as
 * what it must do with the real crash: continue the run, never write an event twice, and refuse a
 * log that is genuinely torn.
 */
async function stageRotation(): Promise<{
  dir: string;
  writer: TraceWriter;
  first: string;
  second: string;
}> {
  const root = await realpath(await mkdtemp('/tmp/ar-rotate-recovery-'));
  const writer = await TraceWriter.create(root, {
    runId: 'run_abcdef123456',
    cwd: root,
    argv: [],
    envAllowlist: [],
    adapter: { id: 'test' },
    agenticreplayVersion: 'test',
    storageLimits: { eventBytes: 700, runEventBytes: 64 * 1024 },
  });
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  for (let i = 0; i < 8; i++) {
    await writer.append({ type: 'note', actor: 'agenticreplay', attrs: { pad: 'r'.repeat(120) } });
  }
  await writer.suspend();
  const names = (await readdir(writer.runDir))
    .filter((name) => /^events(\.\d{6})?\.jsonl$/.test(name))
    .sort((a, b) => ((/(\d{6})/.exec(a)?.[1] ?? '1') > (/(\d{6})/.exec(b)?.[1] ?? '1') ? 1 : -1));
  return {
    dir: writer.runDir,
    writer,
    first: names[0]!,
    second: names[1]!,
  };
}

it('reuses an empty next file left by a crash between creating it and writing to it', async () => {
  const { dir, writer, second } = await stageRotation();
  try {
    // Stage the crash: the segment after the live one exists and holds nothing.
    const nextIndex = Number(/(\d{6})/.exec(second)?.[1] ?? '1') + 1;
    const target = join(dir, `events.${String(nextIndex).padStart(6, '0')}.jsonl`);
    await writeFile(target, '');
    const resumed = await TraceWriter.resume(dir, writer.runId);
    const before = resumed.seq;
    const event = await resumed.append({ type: 'note', actor: 'agenticreplay', attrs: { x: 1 } });
    // The run continues at the next seq: nothing was written twice, and the empty file was reused
    // rather than treated as a second writer's.
    expect(event.seq).toBe(before);
    await resumed.append({ type: 'run.end', actor: 'agenticreplay' });
    await resumed.close(0);
    const reader = await TraceReader.open(resumed.runDir);
    const events = await reader.events();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(reader.problems()).toEqual([]);
  } finally {
    await writer.suspend().catch(() => undefined);
    await rm(dir.slice(0, dir.lastIndexOf('/runs/')), { recursive: true, force: true });
  }
});

it('refuses to append behind a torn line in a segment it did not write last', async () => {
  const { dir, writer, first } = await stageRotation();
  try {
    // A partial line in a file the run had already moved past is corruption, not a tolerated tail.
    const path = join(dir, first);
    const text = await readFile(path, 'utf8');
    await writeFile(path, `${text}{"seq":`);
    await expect(TraceWriter.resume(dir, writer.runId)).rejects.toThrow(/partial recovery event/);
  } finally {
    await rm(dir.slice(0, dir.lastIndexOf('/runs/')), { recursive: true, force: true });
  }
});

it('reports a segment a sealed run names and the directory lacks instead of reading it as complete', async () => {
  const { dir, writer } = await stageRotation();
  try {
    const resumed = await TraceWriter.resume(dir, writer.runId);
    await resumed.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await resumed.close(0);
    const recorded = manifest.integrity?.segments ?? [];
    expect(recorded.length).toBeGreaterThan(1);
    // `close` renames the directory to its final title, so the sealed run is at `resumed.runDir`.
    const sealed = resumed.runDir;
    const victim = recorded[1]!.name;
    await rm(join(sealed, victim));

    const reader = await TraceReader.open(sealed);
    const events = await reader.events();
    // What is left is still readable, and the gap is named rather than silently skipped.
    expect(events.length).toBeGreaterThan(0);
    expect(reader.problems().some((problem) => problem.reason.includes('missing'))).toBe(true);
    expect(await reader.verifyIntegrity().then((result) => result.ok)).toBe(false);
  } finally {
    await rm(dir.slice(0, dir.lastIndexOf('/runs/')), { recursive: true, force: true });
  }
});
