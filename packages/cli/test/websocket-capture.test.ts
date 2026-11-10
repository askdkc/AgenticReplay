import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TraceReader, TraceWriter } from '@agenticreplay/core';
import type { WebSocketObservation } from '@agenticreplay/proxy';
import { openWebSocketCapture } from '../src/websocket-capture.js';

afterEach(() => vi.restoreAllMocks());
const event = (
  connectionId: string,
  sequence: number,
  overrides: Partial<WebSocketObservation> = {},
): WebSocketObservation => ({
  connectionId,
  sequence,
  observedAt: 1794297600000,
  host: 'fixture.invalid',
  port: 443,
  path: '/responses',
  direction: 'client',
  kind: 'message',
  state: 'lost',
  lostAt: 1,
  bytes: 7,
  payload: 'fixture',
  representation: 'text',
  ...overrides,
});

it.each(['initialize', 'append'] as const)(
  'records %s save failure and continues after storage recovers',
  async (failure) => {
    const root = await mkdtemp('/tmp/ar-ws-store-');
    const store = openWebSocketCapture(root);
    const id = randomUUID();
    try {
      if (failure === 'initialize')
        vi.spyOn(TraceWriter, 'create').mockRejectedValueOnce(new Error('ENOSPC'));
      else {
        await store.write(event(id, 1, { kind: 'open', payload: undefined }));
        vi.spyOn(TraceWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC'));
      }
      await expect(store.write(event(id, 2))).rejects.toThrow('ENOSPC');
      await store.write(event(id, 3));
      await store.write(event(id, 4, { kind: 'close', state: 'closed', payload: undefined }));
      await store.close();
      const [dir] = await readdir(root);
      const reader = await TraceReader.open(join(root, dir!));
      const events = await reader.events();
      expect(events.filter((e) => e.type === 'run.start')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'run.end')).toHaveLength(1);
      expect(events.some((e) => e.attrs?.reason === 'save_failed')).toBe(true);
      expect(events.filter((e) => e.type === 'net.request').map((e) => e.payload)).toEqual([
        'fixture',
      ]);
      expect(reader.manifest().capture).toMatchObject({
        status: 'incomplete',
        issues: expect.arrayContaining(['save_failed']),
      });
      expect(reader.manifest().integrity?.events_sha256).toBe(
        createHash('sha256')
          .update(await readFile(join(root, dir!, 'events.jsonl')))
          .digest('hex'),
      );
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('keeps a previous connection incomplete across recorder restart and creates an independent next connection', async () => {
  const root = await mkdtemp('/tmp/ar-ws-restart-');
  try {
    const first = openWebSocketCapture(root);
    await first.write(event(randomUUID(), 1));
    await first.close();
    const [old] = await readdir(root);
    const oldBytes = await readFile(join(root, old!, 'events.jsonl'));
    const second = openWebSocketCapture(root);
    const id = randomUUID();
    await second.write(
      event(id, 1, { kind: 'open', state: 'ready', lostAt: undefined, recovery: 'new_connection' }),
    );
    await second.write(event(id, 2, { kind: 'close', state: 'closed', lostAt: undefined }));
    await second.close();
    expect(await readFile(join(root, old!, 'events.jsonl'))).toEqual(oldBytes);
    expect((await TraceReader.open(join(root, old!))).manifest().capture?.status).toBe(
      'incomplete',
    );
    const fresh = (await readdir(root)).find((dir) => dir !== old)!;
    expect((await TraceReader.open(join(root, fresh))).manifest().capture?.status).toBe('complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('redacts message secrets while preserving omission reasons and retained-body hashes', async () => {
  const root = await mkdtemp('/tmp/ar-ws-redact-');
  const store = openWebSocketCapture(root);
  const id = randomUUID();
  try {
    await store.write(
      event(id, 1, { payload: 'Authorization: Bearer sk-test-123456789012345678901234567890' }),
    );
    await store.write(event(id, 2, { payload: undefined, bytes: 200, omission: 'buffer_limit' }));
    await store.write(event(id, 3, { payload: undefined, kind: 'close', state: 'closed' }));
    const [dir] = await readdir(root);
    const reader = await TraceReader.open(join(root, dir!));
    const events = await reader.events();
    expect(JSON.stringify(events)).not.toContain('sk-test-123456789012345678901234567890');
    const body = events.find((e) => e.type === 'net.request')!;
    expect(body.attrs?.body_sha256).toBe(
      createHash('sha256')
        .update(body.payload as string)
        .digest('hex'),
    );
    expect(
      events.find((e) => e.attrs?.omission === 'buffer_limit')?.transformations,
    ).toContainEqual(expect.objectContaining({ rule: 'capture_limit', reason: 'buffer_limit' }));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
