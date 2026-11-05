import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { Transform, type Writable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import * as ws from 'ws';
import type { HeaderValue, NetExchange, NetRequest, TlsInterceptOptions } from './intercept.js';

// ws exports Receiver at runtime. Its published type declarations cover the higher-level client.
const { Receiver } = ws as typeof ws & {
  Receiver: new (options: { isServer: boolean; maxPayload: number }) => Writable;
};
const TURN = 'x-codex-turn-metadata';
const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const CLIENT_TOOL_CALLS = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'shell_call',
  'apply_patch_call',
  'computer_call',
  'mcp_approval_request',
]);
const HANDSHAKE_ONLY = /^(connection|upgrade|sec-websocket-.*|proxy-.*|host)$/iu;

export function isCodexResponsesUpgrade(req: IncomingMessage): boolean {
  return (
    req.method === 'GET' &&
    req.headers.upgrade?.toLowerCase() === 'websocket' &&
    ['/responses', '/v1/responses', '/backend-api/codex/responses'].includes(
      req.url?.split('?')[0] ?? '',
    )
  );
}

interface RelayOptions {
  target: { host: string; port: number };
  ca: string[] | undefined;
  maxCaptured: number;
  budget: { reserve(bytes: number): number; release(bytes: number): void };
  secretHeaders: ReadonlySet<string>;
  capture: boolean;
  callbacks: Pick<TlsInterceptOptions, 'onRequestStart' | 'onNetExchange' | 'onFailure'>;
}

interface PendingResponse {
  request: NetRequest;
  requestBody: string;
  start: Promise<void>;
  response: string[];
  responseBytes: number;
  held: number;
  truncated: boolean;
  responseId?: string;
}

function parseMessage(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Relaying the original bytes is independent of successful JSON parsing.
  }
}

function responseCapture(req: IncomingMessage, options: RelayOptions) {
  const { callbacks, target, budget, maxCaptured } = options;
  let pending: PendingResponse | undefined;
  let correlationLost = false;
  let lastResponseId: string | undefined;
  const requestHeaders = Object.fromEntries(
    Object.entries(req.headers).filter(
      (entry): entry is [string, HeaderValue] =>
        entry[1] !== undefined &&
        !HANDSHAKE_ONLY.test(entry[0]) &&
        !options.secretHeaders.has(entry[0]) &&
        entry[0] !== TURN,
    ),
  );
  function finish(complete: boolean, output?: unknown[]) {
    const exchange = pending;
    if (!exchange) return;
    pending = undefined;
    const { request, requestBody, response, responseBytes, held, truncated, start } = exchange;
    const observed: NetExchange = {
      ...request,
      requestBody,
      requestBytes: request.requestBytes.length,
      status: 101,
      responseHeaders: { 'content-type': 'text/event-stream' },
      responseBody: response.join(''),
      responseBytes,
      ...(output && {
        codexTurnContinues: output.some((item) => {
          const type = (item as { type?: unknown } | null)?.type;
          return typeof type === 'string' && CLIENT_TOOL_CALLS.has(type);
        }),
      }),
      responseComplete: complete && !truncated && !request.requestTruncated,
      responseTruncated: truncated,
      abandoned: !complete,
      durationMs: Date.now() - request.requestStartedAt,
    };
    void start
      .then(() => callbacks.onNetExchange?.(observed))
      .catch(() => {
        callbacks.onFailure?.({
          ...target,
          kind: 'session',
          reason: 'Codex WebSocket recorder callback failed',
        });
      })
      .finally(() => budget.release(held));
  }
  function stop() {
    correlationLost = true;
    finish(false);
  }
  return {
    request(bytes: Buffer, binary: boolean) {
      const message = binary ? undefined : parseMessage(bytes);
      if (!message || message.type === 'response.cancel') {
        stop();
        return;
      }
      if (message.type !== 'response.create') return;
      // Responses have no client request ID. Once creates overlap, later responses on this
      // connection cannot prove which request they answer. Still account for each known turn.
      if (pending) stop();
      // The socket can outlive the turn. Its handshake metadata never identifies later messages.
      const metadata = message.client_metadata as Record<string, unknown> | undefined;
      const identity = metadata?.[TURN];
      const held = correlationLost || bytes.length > maxCaptured ? 0 : budget.reserve(bytes.length);
      const truncated = held !== bytes.length;
      const request: NetRequest = {
        ...target,
        requestId: randomUUID(),
        requestStartedAt: Date.now(),
        method: 'GET',
        transport: 'websocket',
        codexWarmup: message.generate === false,
        path: req.url ?? '/',
        requestHeaders: {
          ...requestHeaders,
          ...(typeof identity === 'string' && identity.length <= 8192 ? { [TURN]: identity } : {}),
        },
        requestBytes: truncated ? Buffer.alloc(0) : bytes,
        requestTruncated: truncated,
      };
      let start: Promise<void>;
      try {
        start = Promise.resolve(callbacks.onRequestStart?.(request));
      } catch (error) {
        start = Promise.reject(error);
      }
      // A terminal frame or socket close owns the notification, even for a rejected start.
      void start.catch(() => {});
      pending = {
        request,
        start,
        requestBody: truncated ? '' : bytes.toString('utf8'),
        response: [],
        responseBytes: 0,
        held,
        truncated: false,
      };
      if (correlationLost) finish(false);
    },
    response(bytes: Buffer, binary: boolean) {
      const message = binary ? undefined : parseMessage(bytes);
      if (typeof message?.type !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(message.type)) {
        stop();
        return;
      }
      if (!pending) {
        if (message.type.startsWith('response.')) stop();
        return;
      }
      const response = message.response as Record<string, unknown> | undefined;
      const id = response?.id ?? message.response_id;
      if (typeof id === 'string') {
        if (id === lastResponseId || (pending.responseId && pending.responseId !== id)) {
          stop();
          return;
        }
        pending.responseId = id;
      }
      // The Responses dialect consumes SSE. A frame maps to one SSE event without changing
      // the JSON content the client saw, including multiline JSON messages.
      const frame =
        `event: ${message.type}\n` +
        bytes
          .toString('utf8')
          .split(/\r\n|\r|\n/u)
          .map((line) => `data: ${line}\n`)
          .join('') +
        '\n';
      const size = Buffer.byteLength(frame);
      pending.responseBytes += bytes.length;
      if (!pending.truncated && size <= maxCaptured - pending.held) {
        const reserved = budget.reserve(size);
        pending.held += reserved;
        if (reserved === size) pending.response.push(frame);
        else pending.truncated = true;
      } else pending.truncated = true;
      if (TERMINAL.has(message.type)) {
        lastResponseId = pending.responseId;
        const output = Array.isArray(response?.output) ? response.output : undefined;
        finish(
          message.type === 'response.completed' &&
            typeof response?.id === 'string' &&
            (response.status === undefined || response.status === 'completed') &&
            output !== undefined,
          output,
        );
      }
    },
    close: stop,
  };
}

function observeFrames(
  isServer: boolean,
  options: RelayOptions,
  onMessage: (data: Buffer, binary: boolean) => void,
  stop: () => void,
): Transform {
  const parser = new Receiver({ isServer, maxPayload: options.maxCaptured });
  let observing = true;
  parser.on('message', onMessage);
  parser.once('error', () => {
    observing = false;
    stop();
    options.callbacks.onFailure?.({
      ...options.target,
      kind: 'session',
      reason: 'Codex WebSocket frame capture stopped',
    });
  });
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      // Receiver unmasks frames in-place, so it must never see the relayed buffer.
      if (observing) parser.write(Buffer.from(chunk));
      done(null, chunk);
    },
    destroy(error, done) {
      parser.destroy();
      done(error);
    },
  });
}

/** Forward the upgraded stream, optionally observing uncompressed Responses messages. */
export function relayWebSocket(
  req: IncomingMessage,
  client: Socket,
  head: Buffer,
  options: RelayOptions,
): void {
  const { target, ca } = options;
  const headers = { ...req.headers };
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  headers.host = target.port === 443 ? host : `${host}:${target.port}`;
  // Negotiate no extensions so the same frame bytes can be inspected and relayed unchanged.
  if (options.capture) delete headers['sec-websocket-extensions'];
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const upstream = httpsRequest({
    ...target,
    path: req.url ?? '/',
    method: 'GET',
    headers,
    ca,
    rejectUnauthorized: true,
    servername: isIP(target.host) ? '' : target.host,
    checkServerIdentity: (_host, cert) => checkServerIdentity(target.host, cert),
    agent: false,
  });
  let upgraded = false;
  client.once('error', () => upstream.destroy());
  client.once('close', () => {
    if (!upgraded) upstream.destroy();
  });
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.once('error', () => {
    if (!client.destroyed)
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    options.callbacks.onFailure?.({
      ...target,
      kind: 'upstream_session',
      reason: 'Codex WebSocket upstream handshake failed',
    });
  });
  upstream.once('response', (response) => {
    const headers = response.rawHeaders;
    const lines: string[] = [];
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index]!;
      if (!/^(connection|content-length|transfer-encoding)$/iu.test(name))
        lines.push(`${name}: ${headers[index + 1]}`);
    }
    client.write(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n${lines.join('\r\n')}\r\n\r\n`,
    );
    response.on('error', () => client.destroy());
    response.pipe(client);
  });
  upstream.once('upgrade', (response, origin: Socket, originHead: Buffer) => {
    if (
      client.destroyed ||
      response.statusCode !== 101 ||
      (options.capture && response.headers['sec-websocket-extensions'])
    ) {
      origin.destroy();
      if (!client.destroyed)
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    upgraded = true;
    origin.setTimeout(0);
    const lines: string[] = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    }
    client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
    const capture = options.capture ? responseCapture(req, options) : undefined;
    const outgoing = capture && observeFrames(true, options, capture.request, capture.close);
    const incoming = capture && observeFrames(false, options, capture.response, capture.close);
    origin.on('error', () => client.destroy());
    client.once('close', () => {
      capture?.close();
      outgoing?.destroy();
      incoming?.destroy();
      origin.destroy();
    });
    origin.once('close', () => {
      capture?.close();
      client.end();
    });
    if (head.length) client.unshift(head);
    if (originHead.length) origin.unshift(originHead);
    (outgoing ? client.pipe(outgoing) : client).pipe(origin);
    (incoming ? origin.pipe(incoming) : origin).pipe(client);
  });
  upstream.end();
}
