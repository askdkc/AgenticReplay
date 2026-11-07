import { mkdtemp, realpath, readFile, rm, open } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
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
