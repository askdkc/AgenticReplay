import { once } from 'node:events';
import { createServer } from 'node:https';
import { createConnection, type AddressInfo, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TraceReader } from '@agenticreplay/core';
import { openCodexWorktreeCapture } from '../src/codex-turn-capture.js';
import { openWebSocketCapture } from '../src/websocket-capture.js';
import { codexServiceCaptureCallbacks } from '../src/codex-service.js';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createProxy, RunCa, type WebSocketObservation } from '@agenticreplay/proxy';

async function finishTurn(socketPath: string, cwd: string, turnId: string) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = '';
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({ cwd, sessionId: 'chat', turnId, action: 'finish', outcome: 'completed' }) +
          '\n',
      ),
    );
    socket.on('data', (bytes) => {
      data += bytes;
    });
    socket.on('end', () => resolve(JSON.parse(data)));
  });
}

it('keeps observed messages after correlation loss across 67 requests and 3 in the next turn', async () => {
  const root = await realpath(await mkdtemp('/tmp/ar-ws-loss-'));
  const ca = await RunCa.create({ runDir: root });
  const cert = ca.issue('127.0.0.1');
  const origin = createServer({ key: cert.keyPem, cert: cert.certPem });
  const upstream = new WebSocketServer({ server: origin });
  const received: string[] = [];
  upstream.on('connection', (socket) => {
    socket.on('message', (bytes) => {
      received.push(bytes.toString());
      const message = JSON.parse(bytes.toString());
      if (message.type === 'response.create')
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: `resp_${received.length}`,
              status: 'completed',
              output: [],
            },
          }),
        );
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const turns = await openCodexWorktreeCapture(
    join(root, 'review.sock'),
    new Map([[root, join(root, 'runs')]]),
  );
  const observations: WebSocketObservation[] = [];
  const models: unknown[] = [];
  const serviceCallbacks = codexServiceCaptureCallbacks(() => turns);
  const proxy = await createProxy({
    tls: {
      ca,
      hosts: ['127.0.0.1'],
      directCodexOrigin: { host: '127.0.0.1', port: (origin.address() as AddressInfo).port },
      trustedOriginCerts: [await readFile(ca.certPath, 'utf8')],
      ...serviceCallbacks,
      onWebSocketObservation: (event) => {
        observations.push(event);
        return serviceCallbacks.onWebSocketObservation!(event);
      },
    },
    onRequestStart: turns.start,
    onExchange: (exchange) => {
      models.push(exchange);
      turns.model(exchange);
    },
  });
  let closed = false;
  let client = new WebSocket(proxy.url.replace('http:', 'ws:') + '/responses');
  try {
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'response.cancel' }));
    const sent: string[] = [];
    for (let n = 0; n < 70; n++) {
      const body = JSON.stringify({
        type: 'response.create',
        model: 'gpt-test',
        input: [],
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({
            thread_id: 'chat',
            turn_id: n < 67 ? 'first' : 'second',
            workspaces: { [root]: {} },
          }),
        },
      });
      sent.push(body);
      const reply = once(client, 'message');
      client.send(body);
      await reply;
    }
    expect(received.slice(1)).toEqual(sent);
    expect(models).toHaveLength(0);
    await vi.waitFor(() => expect(observations.filter((event) => event.payload)).toHaveLength(141));
    expect(
      observations
        .filter((event) => event.payload?.includes('response.create'))
        .map((event) => event.payload),
    ).toEqual(sent);
    expect(new Set(observations.map((event) => event.connectionId)).size).toBe(1);
    client.terminate();
    await vi.waitFor(() => expect(observations.some((event) => event.kind === 'close')).toBe(true));
    client = new WebSocket(proxy.url.replace('http:', 'ws:') + '/responses');
    await once(client, 'open');
    const recovered = once(client, 'message');
    client.send(sent.at(-1)!);
    await recovered;
    await vi.waitFor(() => expect(models).toHaveLength(1));
    for (const turnId of ['first', 'second']) {
      await vi.waitFor(async () =>
        expect(await finishTurn(join(root, 'review.sock'), root, turnId)).toEqual({
          status: 'finalized',
          capture: 'incomplete',
        }),
      );
      expect(await finishTurn(join(root, 'review.sock'), root, turnId)).toEqual({
        status: 'finalized',
        capture: 'incomplete',
      });
    }
    client.terminate();
    await vi.waitFor(() =>
      expect(observations.filter((event) => event.kind === 'close')).toHaveLength(2),
    );
    await proxy.close();
    await turns.close();
    closed = true;
    const connectionDirs = await readdir(join(root, 'websocket-captures'));
    expect(connectionDirs).toHaveLength(2);
    const readers = await Promise.all(
      connectionDirs.map((dir) => TraceReader.open(join(root, 'websocket-captures', dir))),
    );
    const lost = readers.find((reader) =>
      reader.manifest().capture?.issues.includes('correlation_lost'),
    )!;
    const records = await lost.events();
    const requests = records.filter((e) => e.type === 'net.request');
    const responses = records.filter((e) => e.type === 'net.response');
    expect(requests).toHaveLength(71);
    expect(requests.slice(1).map((e) => e.payload)).toEqual(sent);
    expect(responses).toHaveLength(70);
    expect(responses.every((e) => e.attrs?.bytes && e.payload && !e.causes)).toBe(true);
    expect(records.some((e) => e.type.startsWith('model.') || e.type.startsWith('tool.'))).toBe(
      false,
    );
    expect(records.some((e) => e.attrs?.detail === 'cancel_without_request')).toBe(true);
    expect(
      records.filter((e) => e.attrs?.sequence !== undefined).map((e) => e.attrs?.sequence),
    ).toEqual(Array.from({ length: 144 }, (_, n) => n + 1));
    for (const reader of readers) {
      const dir = join(root, 'websocket-captures', connectionDirs[readers.indexOf(reader)]!);
      expect(reader.manifest().integrity?.events_sha256).toBe(
        createHash('sha256')
          .update(await readFile(join(dir, 'events.jsonl')))
          .digest('hex'),
      );
      for (const event of await reader.events()) {
        if (typeof event.payload === 'string' && event.type.startsWith('net.'))
          expect(event.attrs?.body_sha256).toBe(
            createHash('sha256').update(event.payload).digest('hex'),
          );
      }
    }
    const turnDirs = await readdir(join(root, 'runs'));
    expect(turnDirs).toHaveLength(2);
    const turnRecords = await Promise.all(
      turnDirs.map(async (dir) => (await TraceReader.open(join(root, 'runs', dir))).events()),
    );
    expect(turnRecords.flat().filter((e) => e.type === 'model.response')).toHaveLength(1);
    expect(
      turnRecords.every((events) => events.filter((e) => e.type === 'run.end').length === 1),
    ).toBe(true);
    expect(turnRecords.flat().some((e) => e.type === 'tool.result')).toBe(false);
    expect(JSON.stringify(turnRecords)).not.toContain('client_aborted');
    expect(JSON.stringify(turnRecords)).not.toContain('capture_limit');
  } finally {
    client.terminate();
    if (!closed) {
      await proxy.close();
      await turns.close();
    }
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function liveFixture(maxCapturedBytes = 4096) {
  const root = await realpath(await mkdtemp('/tmp/ar-ws-wire-'));
  const ca = await RunCa.create({ runDir: root });
  const cert = ca.issue('127.0.0.1');
  const origin = createServer({ key: cert.keyPem, cert: cert.certPem });
  const upstream = new WebSocketServer({ server: origin });
  const received: Buffer[] = [];
  upstream.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      received.push(Buffer.from(bytes as Buffer));
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_' + received.length, status: 'completed', output: [] },
        }),
      );
    }),
  );
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const store = openWebSocketCapture(join(root, 'connections'));
  const turns = await openCodexWorktreeCapture(
    join(root, 'review.sock'),
    new Map([[root, join(root, 'runs')]]),
  );
  const observations: WebSocketObservation[] = [];
  const models: unknown[] = [];
  const proxy = await createProxy({
    maxCapturedBytes,
    tls: {
      ca,
      hosts: ['127.0.0.1'],
      trustedOriginCerts: [await readFile(ca.certPath, 'utf8')],
      directCodexOrigin: { host: '127.0.0.1', port: (origin.address() as AddressInfo).port },
      onWebSocketObservation: (event) => {
        observations.push(event);
        return store.write(event);
      },
      onNetExchange: turns.finish,
      onFailure: turns.failure,
    },
    onRequestStart: turns.start,
    onExchange: (exchange) => {
      models.push(exchange);
      turns.model(exchange);
    },
  });
  return {
    root,
    proxy,
    upstream,
    observations,
    models,
    received,
    turns,
    async close() {
      await proxy.close();
      await turns.close();
      await store.close();
      for (const socket of upstream.clients) socket.terminate();
      upstream.close();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each(['invalid-json', 'binary', 'oversized'] as const)(
  'relays %s and subsequent traffic while saving connection evidence',
  async (scenario) => {
    const fixture = await liveFixture(scenario === 'oversized' ? 128 : 4096);
    const client = new WebSocket(fixture.proxy.url.replace('http:', 'ws:') + '/responses');
    try {
      await once(client, 'open');
      const body = scenario === 'oversized' ? 'x'.repeat(400) : '{bad json';
      let response = once(client, 'message');
      client.send(body, { binary: scenario === 'binary' });
      await response;
      response = once(client, 'message');
      client.send('{"type":"response.create","input":[]}');
      await response;
      expect(fixture.received.map((bytes) => bytes.toString())).toEqual([
        body,
        '{"type":"response.create","input":[]}',
      ]);
      expect(fixture.models).toHaveLength(0);
      expect(fixture.observations.some((o) => o.state === 'lost')).toBe(true);
      if (scenario === 'oversized') {
        expect(fixture.observations.some((o) => o.reason === 'frame_parse_failure')).toBe(true);
        expect(fixture.observations.some((o) => o.omission === 'body_limit')).toBe(true);
      } else
        expect(
          fixture.observations.some(
            (o) => o.payload?.includes(body) || o.representation === 'binary',
          ),
        ).toBe(true);
      client.terminate();
      await vi.waitFor(() =>
        expect(fixture.observations.some((o) => o.kind === 'close')).toBe(true),
      );
      await vi.waitFor(async () => {
        const [dir] = await readdir(join(fixture.root, 'connections'));
        const reader = await TraceReader.open(join(fixture.root, 'connections', dir!));
        expect(reader.manifest().integrity?.events_sha256).toBeTruthy();
        expect(reader.manifest().capture?.status).toBe('incomplete');
        expect((await reader.events()).some((e) => e.type === 'net.response' && e.payload)).toBe(
          true,
        );
      });
    } finally {
      client.terminate();
      await fixture.close();
    }
  },
);

it('forwards invalid frames unchanged and continues observing raw bytes after the frame parser fails', async () => {
  const fixture = await liveFixture();
  const url = new URL(fixture.proxy.url);
  const client = createConnection({ host: url.hostname, port: Number(url.port) });
  try {
    await once(client, 'connect');
    const connected = once(fixture.upstream, 'connection');
    const handshake = once(client, 'data');
    client.write(
      'GET /responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    expect((await handshake)[0].toString()).toContain('101 Switching Protocols');
    const [server] = (await connected) as [WebSocket & { _socket: Socket }];
    const invalid = Buffer.from([0x83, 0x00]);
    const forwarded = once(client, 'data');
    server._socket.write(invalid);
    expect((await forwarded)[0]).toEqual(invalid);
    await vi.waitFor(() =>
      expect(fixture.observations.some((o) => o.reason === 'frame_parse_failure')).toBe(true),
    );
    const later = once(client, 'data');
    server.send('still forwarded');
    expect((await later)[0].subarray(2).toString()).toBe('still forwarded');
    expect(fixture.models).toHaveLength(0);
    expect(fixture.observations.filter((o) => o.representation === 'wire')).toHaveLength(2);
  } finally {
    client.destroy();
    await fixture.close();
  }
});

it('isolates a parent and two simultaneous children when one child loses correlation', async () => {
  const fixture = await liveFixture();
  const clients: WebSocket[] = [];
  try {
    await Promise.all(
      ['parent', 'child-one', 'child-two'].map(async (turnId) => {
        const client = new WebSocket(fixture.proxy.url.replace('http:', 'ws:') + '/responses');
        clients.push(client);
        await once(client, 'open');
        if (turnId === 'child-one') {
          const cancelled = once(client, 'message');
          client.send('{"type":"response.cancel"}');
          await cancelled;
        }
        const reply = once(client, 'message');
        client.send(
          JSON.stringify({
            type: 'response.create',
            model: 'gpt-test',
            input: [{ role: 'user', content: turnId }],
            client_metadata: {
              'x-codex-turn-metadata': JSON.stringify({
                thread_id: 'chat',
                turn_id: turnId,
                workspaces: { [fixture.root]: {} },
              }),
            },
          }),
        );
        await reply;
        await vi.waitFor(async () =>
          expect(await finishTurn(join(fixture.root, 'review.sock'), fixture.root, turnId)).toEqual(
            { status: 'finalized', capture: turnId === 'child-one' ? 'incomplete' : 'complete' },
          ),
        );
      }),
    );
    const directories = await readdir(join(fixture.root, 'runs'));
    expect(directories).toHaveLength(3);
    for (const dir of directories) {
      const reader = await TraceReader.open(join(fixture.root, 'runs', dir));
      const events = await reader.events();
      const turnId = events[0]?.attrs?.turnId;
      const requests = events.filter((event) => event.type === 'net.request');
      if (turnId === 'child-one') {
        expect(requests).toHaveLength(0);
        expect(events.some((e) => e.type.startsWith('model.') || e.type.startsWith('tool.'))).toBe(
          false,
        );
        expect(events.some((e) => e.attrs?.rule === 'correlation_lost')).toBe(true);
      } else {
        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0]!.payload as string).input[0].content).toBe(turnId);
        expect(events.filter((e) => e.type === 'model.response')).toHaveLength(1);
      }
    }
    expect(new Set(fixture.observations.map((o) => o.connectionId)).size).toBe(3);
  } finally {
    for (const client of clients) client.terminate();
    await fixture.close();
  }
});

it.each(['streamed', 'disconnected'] as const)(
  'projects item-ID streams and only proven tool continuations: %s',
  async (mode) => {
    const fixture = await liveFixture();
    fixture.upstream.removeAllListeners('connection');
    let requestNumber = 0;
    const forwarded: unknown[] = [];
    fixture.upstream.on('connection', (socket) =>
      socket.on('message', (bytes) => {
        forwarded.push(JSON.parse(bytes.toString()));
        requestNumber++;
        if (mode === 'disconnected' && requestNumber === 2) {
          socket.terminate();
          return;
        }
        const id = `response_${requestNumber}`;
        const item =
          requestNumber === 1
            ? {
                id: 'item_tool',
                type: 'function_call',
                call_id: 'call_echo',
                name: 'echo',
                arguments: '{}',
              }
            : {
                id: 'item_answer',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done', annotations: [] }],
              };
        for (const frame of [
          { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, ...(requestNumber === 1 ? { arguments: '' } : { content: [] }) },
          },
          requestNumber === 1
            ? {
                type: 'response.function_call_arguments.delta',
                item_id: 'item_tool',
                output_index: 0,
                delta: '{}',
              }
            : {
                type: 'response.output_text.delta',
                item_id: 'item_answer',
                output_index: 0,
                content_index: 0,
                delta: 'done',
                logprobs: [],
              },
          {
            type: 'response.completed',
            response: { id, status: 'completed', model: 'gpt-test', output: [item] },
          },
        ])
          socket.send(JSON.stringify(frame));
      }),
    );
    const client = new WebSocket(fixture.proxy.url.replace('http:', 'ws:') + '/responses');
    try {
      await once(client, 'open');
      for (const input of [
        [{ role: 'user', content: 'run echo' }],
        [{ type: 'function_call_output', call_id: 'call_echo', output: 'tool answer' }],
      ]) {
        const terminal = new Promise<void>((resolve) => {
          const receive = (bytes: Buffer) => {
            if (JSON.parse(bytes.toString()).type === 'response.completed') {
              client.off('message', receive);
              client.off('close', resolve);
              resolve();
            }
          };
          client.on('message', receive);
          client.once('close', resolve);
        });
        client.send(
          JSON.stringify({
            type: 'response.create',
            model: 'gpt-test',
            input,
            client_metadata: {
              'x-codex-turn-metadata': JSON.stringify({
                thread_id: 'chat',
                turn_id: 'tools',
                workspaces: { [fixture.root]: {} },
              }),
            },
          }),
        );
        await terminal;
      }
      await vi.waitFor(async () =>
        expect(await finishTurn(join(fixture.root, 'review.sock'), fixture.root, 'tools')).toEqual({
          status: 'finalized',
          capture: mode === 'streamed' ? 'complete' : 'incomplete',
        }),
      );
      expect(forwarded).toHaveLength(2);
      const [dir] = await readdir(join(fixture.root, 'runs'));
      const reader = await TraceReader.open(join(fixture.root, 'runs', dir!));
      const events = await reader.events();
      expect(events.filter((e) => e.type === 'model.response')).toHaveLength(
        mode === 'streamed' ? 2 : 1,
      );
      const call = events.find((e) => e.type === 'tool.call')!;
      const result = events.find((e) => e.type === 'tool.result')!;
      if (mode === 'streamed') {
        expect(result.payload).toBe('tool answer');
        expect(result.causes).toEqual([call.seq]);
      } else expect(result).toBeUndefined();
      expect(events.filter((e) => e.type === 'tool.call')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(
        mode === 'streamed' ? 1 : 0,
      );
      expect(fixture.observations.some((o) => o.state === 'lost')).toBe(false);
    } finally {
      client.terminate();
      await fixture.close();
    }
  },
);
