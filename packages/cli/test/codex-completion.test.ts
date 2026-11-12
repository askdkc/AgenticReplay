import { createConnection } from 'node:net';
import { mkdtemp, realpath, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { NetRequest, NetExchange, RecordedExchange } from '@agenticreplay/proxy';
import { TraceWriter } from '@agenticreplay/core';
import { openCodexWorktreeCapture } from '../src/codex-turn-capture.js';

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/ar-finish-'));
  const socket = join(root, 'turn.sock');
  const capture = await openCodexWorktreeCapture(socket, new Map([[root, root]]));
  const request: NetRequest = {
    requestId: 'req-1',
    requestStartedAt: Date.now(),
    host: 'chatgpt.com',
    port: 443,
    method: 'POST',
    path: '/responses',
    requestHeaders: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'chat',
        turn_id: 'turn',
        workspaces: { [root]: {} },
      }),
    },
    requestBytes: Buffer.from('{}'),
    requestTruncated: false,
  };
  const model: RecordedExchange = {
    seq: 1,
    requestId: request.requestId,
    dialect: 'codex',
    path: '/responses',
    rawRequest: '{}',
    rawResponse: '{}',
    status: 200,
    streamed: true,
    canonicalRequest: { model: 'test', messages: [] },
    canonicalResponse: {
      id: 'resp-test',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'test',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    },
  };
  const net: NetExchange = {
    ...request,
    requestBytes: 2,
    requestBody: '{}',
    responseBody: '{}',
    responseBytes: 2,
    responseHeaders: {},
    status: 200,
    responseComplete: true,
    responseTruncated: false,
    modelDialect: 'codex',
    durationMs: 1,
  };
  const notify = (extra: Record<string, unknown> = {}) =>
    new Promise<{ status: string }>((resolve, reject) => {
      const client = createConnection(socket);
      let response = '';
      client.on('error', reject);
      client.on('data', (data) => {
        response += data;
      });
      client.on('end', () => resolve(JSON.parse(response)));
      client.on('connect', () =>
        client.write(
          JSON.stringify({
            action: 'finish',
            outcome: 'completed',
            cwd: root,
            sessionId: 'chat',
            turnId: 'turn',
            ...extra,
          }) + '\n',
        ),
      );
    });
  const read = async () => {
    const dirs = (await readdir(root, { withFileTypes: true })).filter(
      (e) => e.isDirectory() && !e.name.startsWith('.'),
    );
    expect(dirs).toHaveLength(1);
    const dir = join(root, dirs[0]!.name);
    return {
      manifest: JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
      events: (await readFile(join(dir, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    };
  };
  return {
    root,
    capture,
    request,
    model,
    net,
    notify,
    read,
    close: async () => {
      await capture.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each(['before-response', 'after-response', 'network-before-model'])(
  'automatically finalizes after host notification: %s, with exact duplicate replay',
  async (order) => {
    const f = await fixture();
    try {
      f.capture.start(f.request);
      if (order !== 'after-response') expect(await f.notify()).toMatchObject({ status: 'pending' });
      if (order === 'network-before-model') {
        f.capture.finish(f.net);
        f.capture.model(f.model);
      } else {
        f.capture.model(f.model);
        f.capture.finish(f.net);
      }
      if (order === 'after-response')
        expect(await f.notify()).toMatchObject({ status: 'finalized' });
      await vi.waitFor(async () => {
        const r = await f.read();
        expect(r.manifest.capture.status).toBe('complete');
        expect(r.events.filter((e) => e.type === 'run.end')).toHaveLength(1);
      });
      expect(await f.notify()).toMatchObject({ status: 'finalized' });
      expect(await f.notify({ outcome: 'interrupted' })).toEqual({ status: 'unavailable' });
      expect((await f.read()).events.at(-1).type).toBe('run.end');
    } finally {
      await f.close();
    }
  },
);

it.each(['interrupted', 'transport-failure', 'tool-pending'])(
  'finalizes incomplete instead of success: %s',
  async (kind) => {
    const f = await fixture();
    try {
      f.capture.start(f.request);
      expect(
        await f.notify({ outcome: kind === 'interrupted' ? 'interrupted' : 'completed' }),
      ).toMatchObject({ status: 'pending' });
      f.capture.model({
        ...f.model,
        canonicalResponse: {
          ...f.model.canonicalResponse!,
          stop_reason: kind === 'tool-pending' ? 'tool_use' : 'end_turn',
        },
      });
      f.capture.finish({ ...f.net, responseComplete: kind !== 'transport-failure' });
      await vi.waitFor(async () => {
        const r = await f.read();
        expect(r.manifest.capture.status).toBe('incomplete');
        expect(r.events.filter((e) => e.type === 'run.end')).toHaveLength(1);
      });
    } finally {
      await f.close();
    }
  },
);

it('does not finalize on end_turn alone, foreign identity, or invalid notifications; interruption wins before draining', async () => {
  const f = await fixture();
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    for (const extra of [
      { cwd: '/foreign' },
      { sessionId: 'other' },
      { outcome: 'invalid' },
      { action: 'unknown' },
    ])
      expect((await f.notify(extra)).status).not.toBe('finalized');
    await vi.waitFor(async () =>
      expect((await f.read()).events.some((e) => e.type === 'model.response')).toBe(true),
    );
    expect((await f.read()).events.some((e) => e.type === 'run.end')).toBe(false);
    expect(await f.notify()).toMatchObject({ status: 'pending' });
    expect(await f.notify({ outcome: 'interrupted' })).toMatchObject({ status: 'pending' });
    f.capture.finish(f.net);
    await vi.waitFor(async () =>
      expect((await f.read()).manifest.capture.status).toBe('incomplete'),
    );
  } finally {
    await f.close();
  }
});

it('never reports complete at shutdown without host proof, resumes the same run, and remembers finalization across restart', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    await f.capture.close();
    const first = await f.read();
    expect(first.manifest.capture.status).toBe('incomplete');
    expect(first.events.filter((e) => e.type === 'run.end')).toHaveLength(0);
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    reopened.start({ ...f.request, requestId: 'second' });
    reopened.model({ ...f.model, requestId: 'second' });
    reopened.finish({ ...f.net, requestId: 'second' });
    expect(await f.notify()).toMatchObject({ status: 'finalized', capture: 'incomplete' });
    const resumed = await f.read();
    expect(resumed.events.filter((e) => e.type === 'model.response')).toHaveLength(2);
    expect(resumed.events.filter((e) => e.type === 'run.start')).toHaveLength(1);
    expect(resumed.events.filter((e) => e.type === 'run.end')).toHaveLength(1);
    await reopened.close();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    reopened.start(f.request);
    reopened.model(f.model);
    reopened.finish(f.net);
    expect(await f.notify()).toMatchObject({ status: 'finalized', capture: 'incomplete' });
    expect((await f.read()).events).toEqual(resumed.events);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

it.each(['append', 'close'] as const)(
  'retries a failed %s without acknowledging success or duplicating run.end',
  async (method) => {
    const f = await fixture();
    const original = TraceWriter.prototype[method];
    let failed = false;
    const spy = vi.spyOn(TraceWriter.prototype, method).mockImplementation(async function (
      this: TraceWriter,
      ...args: any[]
    ) {
      if (!failed && (method === 'close' || args[0]?.type === 'run.end')) {
        failed = true;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return (original as Function).apply(this, args);
    } as any);
    try {
      f.capture.start(f.request);
      f.capture.model(f.model);
      f.capture.finish(f.net);
      expect(await f.notify()).toMatchObject({ status: 'pending' });
      expect(failed).toBe(true);
      expect(await f.notify()).toMatchObject({ status: 'finalized' });
      expect((await f.read()).events.filter((e) => e.type === 'run.end')).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await f.close();
    }
  },
);

it('recovers the same unfinished run after an actual process crash', async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const root = await realpath(await mkdtemp('/tmp/ar-crash-'));
  const child = fork(new URL('./fixtures/codex-recovery-child.mjs', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let capture: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    expect(await once(child, 'message')).toEqual(['recorded', undefined]);
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    await rm(join(root, 'turn.sock'), { force: true });
    capture = await openCodexWorktreeCapture(join(root, 'turn.sock'), new Map([[root, root]]));
    const reply = await new Promise<any>((resolve, reject) => {
      const c = createConnection(join(root, 'turn.sock'));
      let text = '';
      c.on('error', reject);
      c.on('data', (d) => (text += d));
      c.on('end', () => resolve(JSON.parse(text)));
      c.on('connect', () =>
        c.write(
          JSON.stringify({
            action: 'finish',
            outcome: 'completed',
            cwd: root,
            sessionId: 'chat',
            turnId: 'turn',
          }) + '\n',
        ),
      );
    });
    expect(reply).toMatchObject({ status: 'finalized', capture: 'incomplete' });
    const dirs = (await readdir(root, { withFileTypes: true })).filter(
      (d) => d.isDirectory() && !d.name.startsWith('.'),
    );
    expect(dirs).toHaveLength(1);
    const events = (await readFile(join(root, dirs[0]!.name, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.type === 'model.response')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.end')).toHaveLength(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await capture?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps interrupted intent across restart and concurrent duplicate notifications', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    const pending = await Promise.all(
      Array.from({ length: 8 }, () => f.notify({ outcome: 'interrupted' })),
    );
    expect(pending.every((r) => r.status === 'pending')).toBe(true);
    await f.capture.close();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    expect(await f.notify()).toEqual({ status: 'unavailable' });
    const final = await Promise.all(
      Array.from({ length: 8 }, () => f.notify({ outcome: 'interrupted' })),
    );
    expect(final.every((r) => r.status === 'finalized')).toBe(true);
    const r = await f.read();
    expect(r.manifest.capture.status).toBe('incomplete');
    expect(r.events.filter((e) => e.type === 'run.end').map((e) => e.attrs.outcome)).toEqual([
      'interrupted',
    ]);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

it('retries receipt publication after restart without changing an already durable trace', async () => {
  const { open } = await import('node:fs/promises');
  const f = await fixture();
  const handle = await open(join(f.root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = prototype.writeFile;
  let failed = false;
  const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
    this: any,
    data: any,
    ...rest: any[]
  ) {
    if (typeof data === 'string' && data.includes('"state":"finalized"')) {
      failed = true;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return original.call(this, data, ...rest);
  });
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify()).toEqual({ status: 'pending' });
    expect(failed).toBe(true);
    const before = await f.read();
    await f.capture.close();
    spy.mockRestore();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    expect(await f.notify()).toMatchObject({ status: 'finalized', capture: 'complete' });
    expect(await f.read()).toEqual(before);
  } finally {
    spy.mockRestore();
    await reopened?.close();
    await f.close();
  }
});

it('recovers a durable identity claim if creation failed before any run directory existed', async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(TraceWriter, 'create')
    .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify()).toEqual({ status: 'pending' });
    await f.capture.close();
    spy.mockRestore();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    expect(await f.notify()).toMatchObject({ status: 'finalized', capture: 'incomplete' });
    const r = await f.read();
    expect(r.manifest.capture.issues).toContain('recorder_restarted_before_capture');
    expect(r.events.map((e) => e.type)).toEqual(['run.start', 'run.end']);
  } finally {
    spy.mockRestore();
    await reopened?.close();
    await f.close();
  }
});

it('retries initialization after disk recovery without restarting the recorder', async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(TraceWriter, 'create')
    .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify()).toEqual({ status: 'pending' });
    spy.mockRestore();
    expect(await f.notify()).toMatchObject({ status: 'finalized', capture: 'incomplete' });
    expect((await f.read()).events.filter((e) => e.type === 'run.end')).toHaveLength(1);
  } finally {
    spy.mockRestore();
    await f.close();
  }
});

it.each(['same-process', 'restart'])(
  'recovers a partially initialized directory: %s',
  async (mode) => {
    const f = await fixture();
    const { mkdir } = await import('node:fs/promises');
    const { captureDirectoryName } = await import('@agenticreplay/core');
    const spy = vi.spyOn(TraceWriter, 'create').mockImplementationOnce(async (runs, init) => {
      await mkdir(
        join(
          runs,
          captureDirectoryName(
            init.sessionStartedAt!.toISOString(),
            'codex-desktop-api',
            'Codex turn',
            init.runId!,
          ),
        ),
        { mode: 0o700 },
      );
      throw Object.assign(new Error('disk full during manifest creation'), { code: 'ENOSPC' });
    });
    let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
    try {
      f.capture.start(f.request);
      f.capture.model(f.model);
      f.capture.finish(f.net);
      expect(await f.notify()).toEqual({ status: 'pending' });
      spy.mockRestore();
      if (mode === 'restart') {
        await f.capture.close();
        reopened = await openCodexWorktreeCapture(
          join(f.root, 'turn.sock'),
          new Map([[f.root, f.root]]),
        );
      }
      expect(await f.notify()).toMatchObject({ status: 'finalized', capture: 'incomplete' });
      const events = (await f.read()).events;
      expect(events.map((e) => e.type)).toEqual(
        mode === 'same-process' ? ['run.start', 'note', 'run.end'] : ['run.start', 'run.end'],
      );
      if (mode === 'same-process') expect(events[1]?.attrs?.reason).toBe('save_failed');
    } finally {
      spy.mockRestore();
      await reopened?.close();
      await f.close();
    }
  },
);

it('automatically finishes persisted host intent after restarting with no notification sender', async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(TraceWriter.prototype, 'close')
    .mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify()).toEqual({ status: 'pending' });
    await f.capture.close();
    spy.mockRestore();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    // No finish call is sent after restart. The durable intent must own completion.
    await vi.waitFor(async () => {
      const r = await f.read();
      expect(r.manifest.capture.status).toBe('incomplete');
      expect(r.events.filter((e) => e.type === 'run.end')).toHaveLength(1);
    });
  } finally {
    spy.mockRestore();
    await reopened?.close();
    await f.close();
  }
});

it('leaves legacy active recordings unchanged on startup and notification', async () => {
  const f = await fixture();
  const { writeFile } = await import('node:fs/promises');
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    await f.capture.close();
    const store = join(f.root, '.codex-turns-turn.sock');
    const file = join(
      store,
      (await readdir(store)).find((n) => n.endsWith('.json'))!,
    );
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    receipt.version = 1;
    receipt.outcome = 'completed';
    await writeFile(file, JSON.stringify(receipt));
    const before = await f.read();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    expect(await f.notify()).toEqual({ status: 'unavailable' });
    reopened.start(f.request);
    reopened.model(f.model);
    reopened.finish(f.net);
    await reopened.close();
    expect(await f.read()).toEqual(before);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

it('retains host proof during initialization failure and completes without a sender after restart', async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(TraceWriter, 'create')
    .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify({ outcome: 'interrupted' })).toEqual({ status: 'pending' });
    await f.capture.close();
    spy.mockRestore();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    await vi.waitFor(async () => {
      const r = await f.read();
      expect(r.manifest.capture.status).toBe('incomplete');
      expect(r.events.filter((e) => e.type === 'run.end').map((e) => e.attrs.outcome)).toEqual([
        'interrupted',
      ]);
    });
  } finally {
    spy.mockRestore();
    await reopened?.close();
    await f.close();
  }
});

it.each(['completed', 'interrupted', 'competing-interrupt'])(
  'retries unsaved host proof without the sender: %s',
  async (kind) => {
    const f = await fixture();
    const { open } = await import('node:fs/promises');
    const handle = await open(join(f.root, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const original = prototype.writeFile;
    let diskFull = true;
    let failed = 0;
    const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
      this: any,
      data: any,
      ...rest: any[]
    ) {
      if (
        diskFull &&
        typeof data === 'string' &&
        data.includes('"state":"active"') &&
        data.includes('"outcome":')
      ) {
        failed++;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return original.call(this, data, ...rest);
    });
    let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
    try {
      f.capture.start(f.request);
      f.capture.model(f.model);
      f.capture.finish(f.net);
      const outcome = kind === 'interrupted' ? 'interrupted' : 'completed';
      const replies = await Promise.all(Array.from({ length: 4 }, () => f.notify({ outcome })));
      expect(replies.every((r) => r.status === 'pending')).toBe(true);
      expect(failed).toBeGreaterThan(0);
      if (kind === 'competing-interrupt')
        expect(await f.notify({ outcome: 'interrupted' })).toEqual({ status: 'pending' });
      diskFull = false; // Sender is gone: there are no further notifications before completion.
      await vi.waitFor(
        async () => {
          const r = await f.read();
          expect(r.events.filter((e) => e.type === 'run.end')).toHaveLength(1);
          expect(r.manifest.capture.status).toBe(kind === 'completed' ? 'complete' : 'incomplete');
          expect(r.events.at(-1).attrs.outcome).toBe(
            kind === 'completed' ? 'completed' : 'interrupted',
          );
        },
        { timeout: 4000 },
      );
      const before = await f.read();
      await f.capture.close();
      spy.mockRestore();
      reopened = await openCodexWorktreeCapture(
        join(f.root, 'turn.sock'),
        new Map([[f.root, f.root]]),
      );
      expect(
        await f.notify({ outcome: kind === 'completed' ? 'completed' : 'interrupted' }),
      ).toMatchObject({ status: 'finalized' });
      expect(await f.read()).toEqual(before);
    } finally {
      diskFull = false;
      spy.mockRestore();
      await reopened?.close();
      await f.close();
    }
  },
);

it('exposes an immutable common receipt only after explicit host completion', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  try {
    f.capture.start(f.request);
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify({ action: 'receipt' })).toEqual({ status: 'pending' });
    expect(await f.notify({ sessionId: 'other' })).toEqual({ status: 'pending' });
    expect(await f.notify({ turnId: 'parallel' })).toEqual({ status: 'pending' });
    await f.notify();
    const first = await f.notify({ action: 'receipt' });
    expect(first).toMatchObject({
      status: 'finalized',
      receipt: {
        schemaVersion: 1,
        source: 'codex-runtime',
        sessionId: 'chat',
        turnId: 'turn',
        requestIds: ['req-1'],
        scope: 'unknown',
        branchId: null,
        identityComplete: false,
        outcome: 'completed',
        capture: 'complete',
      },
    });
    const { assertTurnReceipt, matchesUserTurn } = await import('@agenticreplay/schema');
    const receipt = (first as any).receipt;
    assertTurnReceipt(receipt);
    expect(
      matchesUserTurn(receipt, {
        source: 'codex-runtime',
        sessionId: 'chat',
        turnId: 'turn',
        branchId: null,
      }),
    ).toBe(false);
    const { createHash } = await import('node:crypto');
    expect(receipt.recording.eventsSha256).toBe(
      createHash('sha256')
        .update(await readFile(join(receipt.recording.directory, 'events.jsonl')))
        .digest('hex'),
    );
    expect(await f.notify({ action: 'receipt' })).toEqual(first);
    await f.capture.close();
    reopened = await openCodexWorktreeCapture(
      join(f.root, 'turn.sock'),
      new Map([[f.root, f.root]]),
    );
    expect(await f.notify({ action: 'receipt' })).toEqual(first);
    expect(await f.notify({ action: 'receipt', cwd: '/tmp/elsewhere' })).toEqual({
      status: 'unavailable',
    });
  } finally {
    await reopened?.close();
    await f.close();
  }
});

it.each(['failed', 'interrupted'])(
  'does not promote %s to completed, including after restart',
  async (outcome) => {
    const f = await fixture();
    let reopened: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
    try {
      f.capture.start(f.request);
      f.capture.model(f.model);
      f.capture.finish(f.net);
      expect(await f.notify({ outcome })).toEqual({ status: 'finalized', capture: 'incomplete' });
      const result = await f.notify({ action: 'receipt' });
      expect(result).toMatchObject({ receipt: { outcome, capture: 'incomplete' } });
      expect(await f.notify()).toEqual({ status: 'unavailable' });
      await f.capture.close();
      reopened = await openCodexWorktreeCapture(
        join(f.root, 'turn.sock'),
        new Map([[f.root, f.root]]),
      );
      expect(await f.notify({ action: 'receipt' })).toEqual(result);
      expect(await f.notify()).toEqual({ status: 'unavailable' });
    } finally {
      await reopened?.close();
      await f.close();
    }
  },
);

it('never accepts the private ChatGPT path as a Codex turn', async () => {
  const f = await fixture();
  try {
    f.capture.start({ ...f.request, path: '/f/conversation' });
    f.capture.model(f.model);
    f.capture.finish(f.net);
    expect(await f.notify()).toEqual({ status: 'pending' });
    expect(await f.notify({ action: 'receipt' })).toEqual({ status: 'pending' });
  } finally {
    await f.close();
  }
});
