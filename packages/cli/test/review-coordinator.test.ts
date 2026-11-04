import { appendFile, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunsDir, TraceWriter } from '@agenticreplay/core';
import type { ReviewCandidate } from '@agenticreplay/plugin-api';
import { serveMemoryReview } from '@agenticreplay/viewer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewCoordinator } from '../src/review-coordinator.js';
import { RecordingReviewStore } from '../src/review-store.js';

const candidate: ReviewCandidate = {
  title: '<img src=x onerror=alert(1)>',
  body: 'Check the consumer after changing a recording contract.',
  evidence: [{ sequence: 1, kind: 'observed', description: 'The fixture started.' }],
};

let workspace: string;
let trace: TraceWriter;
let store: RecordingReviewStore;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'agenticreplay-review-coordinator-')));
  trace = await TraceWriter.create(await ensureRunsDir(workspace), {
    adapter: { id: 'exec', version: '1.0.0' },
    argv: [],
    cwd: workspace,
    agenticreplayVersion: '1.0.0',
  });
  await trace.append({ type: 'run.start', actor: 'agenticreplay', turn: 0 });
  await trace.append({ type: 'run.end', actor: 'agenticreplay', turn: 0 });
  await trace.close(0);
  store = await RecordingReviewStore.enqueue(workspace, trace.runId, trace.runDir, workspace);
});

afterEach(async () => rm(workspace, { recursive: true, force: true }));

it('deduplicates notifications and separates empty from a recoverable preparation failure', async () => {
  const duplicate = await RecordingReviewStore.enqueue(
    workspace,
    trace.runId,
    trace.runDir,
    workspace,
  );
  expect(await duplicate.current()).toEqual({ state: 'queued', revision: 0 });
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(new Error('provider offline'))
    .mockResolvedValue(null);
  const review = new ReviewCoordinator(store, { prepare });
  expect((await review.read()).state).toBe('preparation_failed');
  expect(await duplicate.current()).toEqual({ state: 'preparation_failed', revision: 1 });
  expect((await review.read()).state).toBe('empty');
  expect(await duplicate.current()).toEqual({ state: 'empty', revision: 2 });
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(prepare.mock.calls[0]![0].source).toMatchObject({
    runId: trace.runId,
    range: { kind: 'whole_run', events: 2 },
    hostSessionId: null,
  });
});

it('reissues changed proposals and retains only metadata across restarts', async () => {
  const initial = new ReviewCoordinator(store, { prepare: async () => candidate });
  const first = (await initial.read()).proposal!;
  const revised = (
    await initial.decide({
      kind: 'revise',
      revision: first.revision,
      digest: first.digest,
      body: 'Updated preview.',
    })
  ).proposal!;
  expect(revised.revision).toBe(first.revision + 1);
  expect(revised.digest).not.toBe(first.digest);
  expect((await initial.read()).proposal).toEqual(revised);
  const resumed = new ReviewCoordinator(store, { prepare: async () => candidate });
  const reconstructed = (await resumed.read()).proposal!;
  expect(reconstructed.revision).toBe(revised.revision + 1);
  expect(reconstructed.body).toBe(candidate.body);
  const queue = join(workspace, '.agenticreplay', 'reviews', trace.runId);
  for (const file of await readdir(queue)) {
    const stored = await readFile(join(queue, file), 'utf8');
    expect(stored).not.toContain(candidate.body);
    expect(stored).not.toContain(revised.body);
  }
});

it('keeps a decline terminal across duplicate notifications and stale windows', async () => {
  const prepare = vi.fn(async () => candidate);
  const first = new ReviewCoordinator(store, { prepare });
  const second = new ReviewCoordinator(store, { prepare });
  const { revision, digest } = (await first.read()).proposal!;
  await second.read();
  const results = await Promise.allSettled([
    first.decide({ kind: 'decline', revision, digest }),
    second.decide({ kind: 'decline', revision, digest }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  const duplicate = await RecordingReviewStore.enqueue(
    workspace,
    trace.runId,
    trace.runDir,
    workspace,
  );
  expect((await new ReviewCoordinator(duplicate, { prepare }).read()).state).toBe('declined');
  expect(prepare).toHaveBeenCalledTimes(2);
});

it('refuses a review decision after the trace changes', async () => {
  const review = new ReviewCoordinator(store, { prepare: async () => candidate });
  const { revision, digest } = (await review.read()).proposal!;
  await appendFile(join(trace.runDir, 'events.jsonl'), '\n');
  await expect(review.decide({ kind: 'decline', revision, digest })).rejects.toThrow('changed');
  expect(await review.read()).toMatchObject({
    state: 'preparation_failed',
    message: 'The source recording is missing or changed.',
  });
});

it('isolates review HTTP, escapes trace text and checks the exact displayed proposal', async () => {
  const server = await serveMemoryReview(
    new ReviewCoordinator(store, { prepare: async () => candidate }),
  );
  try {
    const page = await fetch(server.url);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('disabled aria-describedby="save-status"');
    expect((await fetch(new URL('/', server.url))).status).toBe(404);
    const fields = new URLSearchParams(
      [...html.matchAll(/type="hidden" name="([^"]+)" value="([^"]+)"/g)].map(([, key, value]) => [
        key!,
        value!,
      ]),
    );
    fields.set('action', 'revise');
    fields.set('body', 'A revised and reviewed statement.');
    const origin = new URL(server.url).origin;
    const post = (body: URLSearchParams, from = origin) =>
      fetch(server.url, { method: 'POST', body, headers: { origin: from } });
    expect((await post(fields, 'https://outside.example')).status).toBe(403);
    const forged = new URLSearchParams(fields);
    forged.set('csrf', 'invalid');
    expect((await post(forged)).status).toBe(400);
    const save = new URLSearchParams(fields);
    save.set('action', 'save');
    expect((await post(save)).status).toBe(400);
    const secret = new URLSearchParams(fields);
    secret.set('body', 'token=ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    expect((await post(secret)).status).toBe(409);
    const update = await post(fields);
    expect(update.status).toBe(200);
    expect(await update.text()).toContain('A revised and reviewed statement.');
    expect((await post(fields)).status).toBe(409);
  } finally {
    await server.close();
  }
});
