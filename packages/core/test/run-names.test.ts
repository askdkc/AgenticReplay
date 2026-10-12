import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from '../src/writer.js';
import { TraceReader } from '../src/reader.js';
import { listRuns, resolveRunSelector } from '../src/paths.js';
import { captureDirectoryName, firstUserPrompt } from '../src/run-names.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'agenticreplay-names-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const init = {
  adapter: { id: 'claude-code', version: '0.1.0' },
  argv: ['claude'],
  agenticreplayVersion: '0.1.0',
};
const runs = () => join(cwd, '.agenticreplay', 'runs');

describe('readable capture directories', () => {
  it.each([
    'さいたま',
    '中文会话',
    '한국어 제목',
    'Привет мир',
    'مرحبا',
    'Café',
    'CON',
    '..\\NUL. / : \u0000 \u202e',
  ])('creates an ASCII component for %s', (title) => {
    const name = captureDirectoryName(
      '2026-10-13T01:02:03Z',
      'agent',
      title.repeat(100),
      'run_0123456789abcdef0123456789abcdef',
    );
    expect(name).toMatch(/^20261013010203-agent-[a-z0-9-]+-0123456789abcdef0123456789abcdef$/);
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith('-')).toBe(false);
  });

  it('uses the first human message from chat and Responses bodies', () => {
    expect(
      firstUserPrompt({
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: [{ type: 'tool_result', content: 'tool' }] },
          { role: 'user', content: 'first ask' },
          { role: 'user', content: 'later ask' },
        ],
      }),
    ).toBe('first ask');
    expect(
      firstUserPrompt({
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Responses ask' }] }],
      }),
    ).toBe('Responses ask');
  });

  it('falls back to the first request when no host title is available', async () => {
    const w = await TraceWriter.create(runs(), { ...init, cwd });
    await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await w.append({
      type: 'model.request',
      actor: 'model',
      payload: { messages: [{ role: 'user', content: 'Fix login' }] },
    });
    await w.append({
      type: 'model.request',
      actor: 'model',
      payload: { messages: [{ role: 'user', content: 'Other task' }] },
    });
    await w.append({ type: 'run.end', actor: 'agenticreplay' });
    await w.close();
    expect(basename(w.runDir)).toMatch(/^\d{14}-claude-code-fix-login-[0-9a-f]{12}$/);
    expect((await resolveRunSelector(cwd, w.runId)).dir).toBe(w.runDir);
  });
  it('uses the session start and title while preserving the run identifier', async () => {
    const w = await TraceWriter.create(runs(), {
      ...init,
      cwd,
      sessionTitle: 'Fix Login Flow',
      sessionStartedAt: new Date('2026-10-13T01:02:03Z'),
    });
    try {
      expect(basename(w.runDir)).toBe(
        `20261013010203-claude-code-fix-login-flow-${w.runId.slice(4)}`,
      );
      expect((await TraceReader.open(w.runDir)).manifest().run_id).toBe(w.runId);
      expect((await resolveRunSelector(cwd, w.runId)).dir).toBe(w.runDir);
      expect((await resolveRunSelector(cwd, basename(w.runDir))).dir).toBe(w.runDir);
    } finally {
      await w.close();
    }
  });

  it('uses the first user request, then prefers a captured session title at close', async () => {
    const w = await TraceWriter.create(runs(), { ...init, cwd });
    const activeDir = w.runDir;
    await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await w.append({
      type: 'net.request',
      actor: 'gateway',
      payload: JSON.stringify({
        messages: [
          { role: 'system', content: 'Ignore this preamble' },
          { role: 'user', content: 'Fix login flow' },
        ],
      }),
    });
    await w.append({
      type: 'session.snapshot',
      actor: 'harness',
      attrs: { title: 'ログイン不具合の修正' },
      payload: { prompts: ['Fix login flow'], transcript: 't'.repeat(70_000) },
    });
    expect(w.runDir).toBe(activeDir);
    await w.append({ type: 'run.end', actor: 'agenticreplay' });
    await w.close(0);
    expect(basename(w.runDir)).toMatch(
      new RegExp(`^\\d{14}-claude-code-roguin[a-z0-9-]*-${w.runId.slice(4)}$`),
    );
    expect(basename(w.runDir)).toMatch(/^[a-z0-9-]+$/);
    expect(await readdir(runs())).toEqual([basename(w.runDir)]);
    expect((await resolveRunSelector(cwd, 'last')).dir).toBe(w.runDir);
    await expect((await TraceReader.open(w.runDir)).verifyIntegrity()).resolves.toMatchObject({
      ok: true,
    });
    const reader = await TraceReader.open(w.runDir);
    const snapshot = (await reader.events()).find((event) => event.type === 'session.snapshot')!;
    expect(snapshot.attrs?.title).toBe('ログイン不具合の修正');
    expect(((await reader.resolvePayload(snapshot)) as { transcript: string }).transcript).toBe(
      't'.repeat(70_000),
    );
  });

  it('redacts secrets and limits the entire ASCII name to 255 characters', async () => {
    const w = await TraceWriter.create(runs(), {
      ...init,
      cwd,
      sessionTitle: `../../Fix sk-abcdefghijklmnop0123456789 \\ : ${'日本語'.repeat(100)}`,
    });
    try {
      expect(basename(w.runDir)).not.toContain('sk-abcdefghijklmnop');
      expect(basename(w.runDir)).toMatch(/^[a-z0-9-]+$/);
      expect(basename(w.runDir).length).toBeLessThanOrEqual(255);
      expect(Buffer.byteLength(basename(w.runDir))).toBe(basename(w.runDir).length);
      expect(dirname(w.runDir)).toBe(runs());
      expect(await readdir(runs())).toEqual([basename(w.runDir)]);
    } finally {
      await w.close();
    }
  });

  it('keeps old directories and new directories visible together', async () => {
    const old = await TraceWriter.create(runs(), { ...init, cwd });
    await old.close();
    const legacy = join(runs(), old.runId);
    if (old.runDir !== legacy) await rename(old.runDir, legacy);
    const fresh = await TraceWriter.create(runs(), { ...init, cwd, sessionTitle: 'New session' });
    await fresh.close();
    expect((await listRuns(cwd)).map((r) => r.runId).sort()).toEqual(
      [old.runId, fresh.runId].sort(),
    );
    expect((await resolveRunSelector(cwd, old.runId)).dir).toBe(legacy);
    expect((await resolveRunSelector(cwd, fresh.runId)).dir).toBe(fresh.runDir);
    expect(JSON.parse(await readFile(join(fresh.runDir, 'manifest.json'), 'utf8')).run_id).toBe(
      fresh.runId,
    );
  });
});
