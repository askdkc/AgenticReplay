import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { createServer, request } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createProxy, RunCa } from '@agenticreplay/proxy';
import { TraceReader } from '@agenticreplay/core';
import { parseArgs } from '../src/args.js';
import { attachCommand } from '../src/commands/attach.js';
import { Output } from '../src/out.js';
import { openCodexWorktreeCapture } from '../src/codex-turn-capture.js';

async function seal(socketPath: string, cwd: string, turnId: string, sessionId = 'chat-1') {
  return await requestTurn(socketPath, JSON.stringify({ cwd, sessionId, turnId }) + '\n');
}

async function requestTurn(socketPath: string, input: string) {
  return await new Promise<{ status: string; traceDirectory?: string }>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.write(input));
    socket.setTimeout(3000, () => socket.destroy(new Error('turn socket did not reply')));
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.on('end', () => resolve(JSON.parse(text)));
  });
}

it('records a direct Dock WebSocket and forwards ordinary HTTP to the same origin', async () => {
  const root = await realpath(await mkdtemp('/tmp/ar-dock-'));
  const socketPath = join(root, 'review.sock');
  const other = join(root, 'other-worktree');
  await mkdir(other);
  const originCa = await RunCa.create({ runDir: root });
  const cert = originCa.issue('127.0.0.1');
  const origin = createHttpsServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  });
  const wsOrigin = new WebSocketServer({ server: origin });
  let responseId = 0;
  wsOrigin.on('connection', (socket, req) => {
    socket.on('message', (bytes) => {
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: `resp_direct_${++responseId}`,
            object: 'response',
            status: 'completed',
            model: 'gpt-test',
            output: [],
          },
        }),
      );
      expect(req.headers.authorization).toBe('Bearer fixture-only');
      expect(JSON.parse(bytes.toString()).type).toBe('response.create');
    });
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const port = (origin.address() as AddressInfo).port;
  const turns = await openCodexWorktreeCapture(
    socketPath,
    new Map([
      [root, root],
      [other, other],
    ]),
  );
  const proxy = await createProxy({
    retainExchanges: false,
    tls: {
      ca: originCa,
      hosts: ['127.0.0.1'],
      directCodexOrigin: { host: '127.0.0.1', port },
      trustedOriginCerts: [await readFile(originCa.certPath, 'utf8')],
      onNetExchange: turns.finish,
    },
    onRequestStart: turns.start,
    onExchange: turns.model,
  });
  let client: WebSocket | undefined;
  try {
    const modelsPath = '/backend-api/codex/models?client_version=fixture';
    const models = await fetch(proxy.url + modelsPath);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ path: modelsPath, host: `127.0.0.1:${port}` });
    client = new WebSocket(proxy.url.replace(/^http:/u, 'ws:') + '/backend-api/codex/responses', {
      headers: { authorization: 'Bearer fixture-only' },
    });
    await once(client, 'open');
    const send = async (turnId: string, workspace: string) => {
      const reply = once(client!, 'message');
      client!.send(
        JSON.stringify({
          type: 'response.create',
          model: 'gpt-test',
          input: [{ role: 'user', content: 'dock probe' }],
          client_metadata: {
            'x-codex-turn-metadata': JSON.stringify({
              thread_id: 'chat-1',
              turn_id: turnId,
              workspaces: { [workspace]: {} },
            }),
          },
        }),
      );
      expect(JSON.parse((await reply)[0].toString()).type).toBe('response.completed');
    };
    await send('dock-turn', root);
    const sealed = await vi.waitFor(async () => {
      const result = await seal(socketPath, root, 'dock-turn');
      expect(result.status).toBe('sealed');
      return result;
    });
    const reader = await TraceReader.open(sealed.traceDirectory!);
    const events = await reader.events();
    const wireRequest = events.find((event) => event.type === 'net.request');
    const wireResponse = events.find((event) => event.type === 'net.response');
    expect(wireRequest?.attrs?.transport).toBe('websocket');
    expect(wireRequest?.attrs?.request_id).toBeTruthy();
    expect(wireResponse?.attrs?.request_id).toBe(wireRequest?.attrs?.request_id);
    expect(events[0]?.attrs).toMatchObject({ sessionId: 'chat-1', turnId: 'dock-turn' });
    expect(events.some((event) => event.type === 'model.response')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('fixture-only');
    expect(await seal(socketPath, other, 'dock-turn')).toEqual({ status: 'unavailable' });
    expect(await seal(socketPath, other, 'second-turn')).toEqual({ status: 'pending' });
    await send('second-turn', other);
    const second = await vi.waitFor(async () => {
      const result = await seal(socketPath, other, 'second-turn');
      expect(result.status).toBe('sealed');
      return result;
    });
    expect(dirname(second.traceDirectory!)).toBe(other);
    await send('foreign-turn', join(root, 'not-registered'));
    expect(await seal(socketPath, root, 'foreign-turn')).toEqual({ status: 'unavailable' });
  } finally {
    client?.terminate();
    await proxy.close();
    await turns.close();
    for (const socket of wsOrigin.clients) socket.terminate();
    wsOrigin.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('seals only the named Codex API turn while attach stays live', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-codex-')));
  const socketPath = join(root, 'review.sock');
  const origin = createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ id: 'resp_fixture', object: 'response', model: 'gpt-test', output: [] }),
      );
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture origin');
  const stop = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<string>();
  const recording = attachCommand(
    parseArgs([
      'attach',
      '--for',
      'codex',
      '--upstream-openai',
      `http://127.0.0.1:${address.port}`,
      '--codex-review-socket',
      socketPath,
    ]),
    new Output({ write: () => {} }),
    root,
    {
      until: stop.promise,
      onReady: (info) => ready.resolve(info.proxyUrl),
    },
  );
  try {
    const proxyUrl = await Promise.race([
      ready.promise,
      recording.then(() => {
        throw new Error('recorder stopped');
      }),
    ]);
    const send = async (turnId: string) => {
      const response = await fetch(new URL('/backend-api/codex/responses', proxyUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer forbidden-fixture-credential',
          'x-codex-turn-metadata': JSON.stringify({ thread_id: 'chat-1', turn_id: turnId }),
        },
        body: JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: turnId }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
    };
    await send('turn-one');
    await send('turn-two');
    expect((await seal(socketPath, root, 'missing-turn')).status).toBe('pending');
    const result = await seal(socketPath, root, 'turn-one');
    expect(result.status).toBe('sealed');
    expect(await seal(socketPath, root, 'turn-one')).toEqual(result);
    const reader = await TraceReader.open(result.traceDirectory!);
    const events = await reader.events();
    expect(reader.manifest().capture?.status).toBe('complete');
    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'net.request',
      'net.response',
      'model.request',
      'model.response',
      'run.end',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/turn-two|forbidden-fixture-credential/);
    expect(JSON.stringify(events)).toContain('turn-one');
    expect((await seal(socketPath, root, 'turn-two')).status).toBe('sealed');
  } finally {
    stop.resolve();
    await recording.catch(() => {});
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

const desktopHost = fileURLToPath(new URL('./fixtures/codex-desktop-host.mjs', import.meta.url));
const cli = process.env.AGENTICREPLAY_TEST_INSTALLED_CLI ?? resolve('bin/agenticreplay.js');

function desktop(root: string, env: NodeJS.ProcessEnv = {}, flags: string[] = []) {
  const child = spawn(
    process.execPath,
    ['--import', desktopHost, cli, 'record', 'codex', '--desktop', ...flags],
    {
      cwd: root,
      env: { ...process.env, ...env, AR_DESKTOP_FIXTURE_READY: join(root, 'desktop-ready.json') },
    },
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  return { child, result: once(child, 'close').then(([code]) => ({ code, output })) };
}

it('asks the user to quit the existing Codex desktop and exits with an error', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-desktop-running-')));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const { result } = desktop(root, { AR_DESKTOP_FIXTURE_RUNNING: '1' });
    expect(await result).toMatchObject({
      code: 1,
      output: expect.stringMatching(/quit Codex.*agenticreplay record codex --desktop/is),
    });
    await expect(lstat(join(root, 'desktop-ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(root, '.agenticreplay'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('records separate turns and rejects incomplete capture through the public desktop CLI', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-codex-ws-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const originCa = await RunCa.create({ runDir: join(root, 'origin') });
  const cert = originCa.issue('127.0.0.1');
  const origin = createHttpsServer({ key: cert.keyPem, cert: cert.certPem });
  const websocketOrigin = new WebSocketServer({ server: origin });
  let upstreamAuth: string | undefined;
  const releaseOverlappingResponse = Promise.withResolvers<void>();
  websocketOrigin.on('connection', (socket, request) => {
    upstreamAuth = request.headers.authorization;
    socket.on('message', async (data) => {
      const input = JSON.parse(data.toString()).input[0].content;
      if (input === 'turn-open') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_open' } }));
        return;
      }
      if (input === 'turn-overlap-first') await releaseOverlappingResponse.promise;
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_' + input,
            object: 'response',
            status: 'completed',
            model: 'gpt-test',
            output:
              input === 'first-tool-step'
                ? [
                    {
                      type: 'function_call',
                      call_id: 'call_test',
                      name: 'echo',
                      arguments: '{}',
                    },
                  ]
                : [],
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const { port } = origin.address() as AddressInfo;
  const { child, result } = desktop(
    root,
    {
      AGENTICREPLAY_TLS_UPSTREAM_CA: originCa.certPath,
      CODEX_HOME: join(root, 'normal-profile'),
    },
    ['--tls-hosts', '127.0.0.1'],
  );
  let client: WebSocket | undefined;
  let desktopPid: number | undefined;
  let socketPath: string | undefined;
  let caPath: string | undefined;
  try {
    const ready = await Promise.race([
      vi.waitFor(async () => JSON.parse(await readFile(join(root, 'desktop-ready.json'), 'utf8')), {
        timeout: 5000,
      }),
      result.then(({ output }) => {
        throw new Error(output);
      }),
    ]);
    desktopPid = ready.pid;
    socketPath = ready.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET as string;
    caPath = ready.env.NODE_EXTRA_CA_CERTS as string;
    expect(ready.cwd).toBe(root);
    expect(ready.env.CODEX_HOME).toBe(join(root, 'normal-profile'));
    expect(ready.env.CODEX_CA_CERTIFICATE).toBe(caPath);
    expect(ready.env.SSL_CERT_FILE).toBeDefined();
    expect(ready.env.https_proxy).toBe(ready.env.HTTPS_PROXY);
    const socketStat = await lstat(socketPath);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.uid).toBe(process.getuid!());
    expect(socketStat.mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(socketPath))).mode & 0o777).toBe(0o700);
    const ca = await readFile(caPath);
    const proxy = new URL(ready.env.HTTPS_PROXY);
    expect(proxy.hostname).toBe('127.0.0.1');
    const authority = '127.0.0.1:' + port;
    const metadata = (turn_id: string, cwd = root) =>
      JSON.stringify({ thread_id: 'chat-1', turn_id, workspaces: { [cwd]: {} } });
    const openWebSocket = async () => {
      const connect = request({
        host: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
      });
      connect.end();
      const [reply, tunnel, head] = await once(connect, 'connect');
      expect(reply.statusCode).toBe(200);
      if (head.length) tunnel.unshift(head);
      const tls = tlsConnect({ socket: tunnel, host: '127.0.0.1', ca });
      await once(tls, 'secureConnect');
      const websocket = new WebSocket('wss://' + authority + '/backend-api/codex/responses', {
        createConnection: () => tls,
        headers: {
          authorization: 'Bearer websocket-fixture-secret',
          'x-codex-turn-metadata': metadata('handshake-only'),
        },
      });
      await once(websocket, 'open');
      return websocket;
    };
    client = await openWebSocket();
    const send = (turn: string, cwd = root, input = turn) =>
      client!.send(
        JSON.stringify({
          type: 'response.create',
          model: 'gpt-test',
          input: [{ role: 'user', content: input }],
          client_metadata: { 'x-codex-turn-metadata': metadata(turn, cwd) },
        }),
      );
    for (const turn of ['turn-one', 'turn-two']) {
      const response = once(client, 'message');
      send(turn);
      expect(JSON.parse((await response)[0].toString()).type).toBe('response.completed');
    }
    expect(upstreamAuth).toBe('Bearer websocket-fixture-secret');
    for (const [turn, other] of [
      ['turn-one', 'turn-two'],
      ['turn-two', 'turn-one'],
    ]) {
      const result = await vi.waitFor(async () => {
        const attempt = await seal(socketPath!, root, turn!);
        expect(attempt.status).toBe('sealed');
        return attempt;
      });
      expect(await seal(socketPath, root, turn!)).toEqual(result);
      expect(await seal(socketPath, root, turn!, 'other-chat')).toEqual({ status: 'pending' });
      expect(await seal(socketPath, '/different-worktree', turn!)).toEqual({
        status: 'unavailable',
      });
      const reader = await TraceReader.open(result.traceDirectory!);
      const events = await reader.events();
      expect(reader.manifest().capture?.status).toBe('complete');
      expect(events.some((event) => event.type === 'model.response')).toBe(true);
      expect(events.find((event) => event.type === 'net.request')?.attrs?.transport).toBe(
        'websocket',
      );
      expect(JSON.stringify(events)).toContain(turn);
      expect(JSON.stringify(events)).not.toContain(other);
      expect(JSON.stringify(events)).not.toContain('websocket-fixture-secret');
    }
    expect(await requestTurn(socketPath, '{invalid}\n')).toEqual({ status: 'unavailable' });
    expect(await seal(socketPath, root, 'handshake-only')).toEqual({ status: 'pending' });

    const toolCall = once(client, 'message');
    send('turn-with-tool', root, 'first-tool-step');
    await toolCall;
    expect(await seal(socketPath, root, 'turn-with-tool')).toEqual({ status: 'pending' });
    const toolAnswer = once(client, 'message');
    send('turn-with-tool', root, 'final-tool-step');
    await toolAnswer;
    const toolTrace = await seal(socketPath, root, 'turn-with-tool');
    expect(toolTrace.status).toBe('sealed');
    const toolEvents = await (await TraceReader.open(toolTrace.traceDirectory!)).events();
    expect(toolEvents.filter((event) => event.type === 'model.response')).toHaveLength(2);

    const foreignResponse = once(client, 'message');
    send('turn-foreign', '/other-worktree');
    await foreignResponse;
    expect((await seal(socketPath, root, 'turn-foreign')).status).toBe('unavailable');

    const responses = Promise.withResolvers<void>();
    let received = 0;
    client.on('message', () => {
      if (++received === 2) responses.resolve();
    });
    send('turn-overlap-first');
    send('turn-overlap-second');
    await once(client, 'message');
    releaseOverlappingResponse.resolve();
    await responses.promise;
    await vi.waitFor(async () => {
      expect((await seal(socketPath!, root, 'turn-overlap-first')).status).toBe('unavailable');
    });
    expect((await seal(socketPath, root, 'turn-overlap-second')).status).toBe('unavailable');
    client.terminate();
    client = await openWebSocket();
    const opened = once(client, 'message');
    send('turn-open');
    await opened;
    expect(await seal(socketPath, root, 'turn-open')).toEqual({ status: 'pending' });
    const disconnected = once(client, 'close');
    client.terminate();
    await disconnected;
    await vi.waitFor(async () => {
      expect(await seal(socketPath!, root, 'turn-open')).toEqual({ status: 'unavailable' });
    });
    process.kill(desktopPid!, 'SIGUSR2');
    desktopPid = undefined;
    expect(await result).toMatchObject({ code: 0 });
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(caPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    releaseOverlappingResponse.resolve();
    client?.terminate();
    if (desktopPid !== undefined) process.kill(desktopPid, 'SIGUSR2');
    if (child.exitCode === null) child.kill('SIGTERM');
    await result;
    for (const socket of websocketOrigin.clients) socket.terminate();
    websocketOrigin.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await originCa.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
