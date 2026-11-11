import { randomUUID } from 'node:crypto';
import { BINARY_BODY_PREFIX } from '@agenticreplay/core';
import type { WebSocketCaptureReason, WebSocketObservation } from './websocket-observation.js';
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
// Codex sends these connection-level notifications before response.created, between
// response events, and after a terminal. They do not identify a model response.
const CONNECTION_NOTIFICATIONS = new Set([
  'codex.rate_limits',
  'codex.response.metadata',
  'responsesapi.websocket_timing',
]);
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
  track?: (drained: Promise<void>) => void;
  callbacks: Pick<
    TlsInterceptOptions,
    'onRequestStart' | 'onNetExchange' | 'onFailure' | 'onWebSocketObservation'
  >;
}

interface PendingResponse {
  request: NetRequest;
  requestBody: string;
  requestBytes: number;
  start: Promise<void>;
  response: string[];
  responseBytes: number;
  held: number;
  truncated: boolean;
  responseId?: string;
  reasons: Set<WebSocketCaptureReason>;
  cancelled: boolean;
  items: Set<string>;
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

export function responseCapture(req: IncomingMessage, options: RelayOptions) {
  const { callbacks, target, budget, maxCaptured } = options;
  const connectionId = randomUUID();
  let pending: PendingResponse | undefined;
  let state: WebSocketObservation['state'] = 'ready';
  let sequence = 0;
  let lostAt: number | undefined;
  const rawBytes = { client: 0, server: 0 };
  let observingWrites = 0;
  let overflow: WebSocketObservation | undefined;
  let deferredClose: WebSocketObservation | undefined;
  let exchangeWrites = 0;
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  function settle() {
    if (
      state === 'closed' &&
      observingWrites === 0 &&
      exchangeWrites === 0 &&
      !overflow &&
      !deferredClose
    )
      resolveDrained();
  }
  // Bounded identity history. Exhaustion loses correlation rather than forgetting old IDs.
  const responseIds = new Set<string>();
  const retiredItems = new Set<string>();
  const requestHeaders = Object.fromEntries(
    Object.entries(req.headers).filter(
      (entry): entry is [string, HeaderValue] =>
        entry[1] !== undefined &&
        !HANDSHAKE_ONLY.test(entry[0]) &&
        !options.secretHeaders.has(entry[0]) &&
        entry[0] !== TURN,
    ),
  );
  function failure() {
    callbacks.onFailure?.({
      ...target,
      connectionId,
      code: 'save_failed',
      kind: 'session',
      reason: 'Codex WebSocket recorder callback failed',
    });
  }
  function deliver(event: WebSocketObservation, held: number) {
    observingWrites++;
    const done = () => {
      budget.release(held);
      observingWrites--;
      if (observingWrites === 0) {
        const omitted = overflow;
        const close = deferredClose;
        overflow = undefined;
        deferredClose = undefined;
        if (omitted) deliver(omitted, 0);
        if (close) deliver(close, 0);
      }
      settle();
    };
    try {
      void Promise.resolve(callbacks.onWebSocketObservation?.(event)).catch(failure).finally(done);
    } catch {
      done();
      failure();
    }
  }
  function observe(
    direction: WebSocketObservation['direction'],
    kind: WebSocketObservation['kind'],
    bytes?: Buffer,
    extra: Partial<WebSocketObservation> = {},
  ) {
    const at = ++sequence;
    if (!callbacks.onWebSocketObservation) return;
    const size = bytes?.length ?? 0;
    // Even empty omission records consume queue memory. Bound that queue when a writer stalls.
    const saturated = observingWrites >= 256 || overflow !== undefined;
    const held = !saturated && !extra.omission && size <= maxCaptured ? budget.reserve(size) : 0;
    const omission =
      extra.omission ??
      (size > maxCaptured ? 'body_limit' : held < size ? 'buffer_limit' : undefined);
    const event: WebSocketObservation = {
      ...target,
      connectionId,
      sequence: at,
      observedAt: Date.now(),
      path: req.url ?? '/',
      direction,
      kind,
      state,
      ...(lostAt === undefined ? {} : { lostAt }),
      bytes: size,
      ...(bytes && !omission
        ? {
            payload: bytes.equals(Buffer.from(bytes.toString('utf8')))
              ? bytes.toString('utf8')
              : BINARY_BODY_PREFIX + bytes.toString('base64'),
          }
        : {}),
      ...(omission ? { omission } : {}),
      ...extra,
    };
    if (saturated) {
      if (kind === 'close') deferredClose = event;
      else if (overflow) {
        overflow.bytes += size;
        overflow.omittedObservations!++;
        overflow.throughSequence = at;
        overflow.state = state;
        overflow.lostAt = lostAt;
        overflow.detail ??= event.detail;
      } else
        overflow = {
          ...event,
          kind: 'diagnostic',
          payload: undefined,
          direction: 'recorder',
          omission: 'buffer_limit',
          reason: 'buffer_limit',
          omittedObservations: 1,
          throughSequence: at,
        };
      return;
    }
    deliver(event, held);
  }
  observe('recorder', 'open', undefined, { recovery: 'new_connection' });

  function finish(complete: boolean, output?: unknown[]) {
    const exchange = pending;
    if (!exchange) return;
    pending = undefined;
    const { request, requestBody, response, responseBytes, held, truncated, start, reasons } =
      exchange;
    const observed: NetExchange = {
      ...request,
      correlation: state === 'lost' ? 'lost' : exchange.responseId ? 'matched' : 'unconfirmed',
      captureReasons: [...reasons],
      requestBody,
      requestBytes: exchange.requestBytes,
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
      durationMs: Date.now() - request.requestStartedAt,
    };
    exchangeWrites++;
    void start
      .then(() => callbacks.onNetExchange?.(observed))
      .catch(failure)
      .finally(() => {
        budget.release(held);
        exchangeWrites--;
        settle();
      });
  }
  function lose(detail: string, reason: WebSocketCaptureReason = 'correlation_lost') {
    if (state === 'closed' || state === 'lost') return;
    state = 'lost';
    lostAt = sequence + 1;
    pending?.reasons.add(reason);
    pending?.reasons.add('correlation_lost');
    observe('recorder', 'diagnostic', undefined, { reason, detail });
    finish(false);
  }
  function startRequest(bytes: Buffer, message: Record<string, unknown>) {
    const metadata = message.client_metadata as Record<string, unknown> | undefined;
    const identity = metadata?.[TURN];
    const held = bytes.length <= maxCaptured ? budget.reserve(bytes.length) : 0;
    const truncated = held !== bytes.length;
    const request: NetRequest = {
      ...target,
      connectionId,
      correlation: state === 'lost' ? 'lost' : 'matched',
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
    void start.catch(() => {});
    pending = {
      request,
      start,
      requestBody: truncated ? '' : bytes.toString('utf8'),
      requestBytes: bytes.length,
      response: [],
      responseBytes: 0,
      held,
      truncated: false,
      cancelled: false,
      items: new Set(),
      reasons: new Set(
        truncated ? [bytes.length > maxCaptured ? 'body_limit' : 'buffer_limit'] : [],
      ),
    };
    if (state === 'lost') {
      pending.reasons.add('correlation_lost');
      finish(false);
    }
  }
  return {
    drained,
    request(bytes: Buffer, binary: boolean) {
      if (state === 'closed') return;
      const message = binary ? undefined : parseMessage(bytes);
      if (!message || typeof message.type !== 'string')
        lose(binary ? 'binary_message' : 'invalid_json');
      else if (message.type === 'response.cancel') {
        if (!pending || state === 'lost') lose('cancel_without_request');
        else {
          const id = message.response_id;
          if (id !== undefined && id !== pending.responseId) lose('cancel_id_mismatch');
          else {
            state = 'cancelling';
            pending.cancelled = true;
            pending.reasons.add('cancel_observed');
          }
        }
      } else if (message.type === 'response.create' && pending) lose('overlapping_requests');
      observe('client', 'message', bytes, {
        representation: binary ? 'binary' : 'text',
        ...(message?.type === 'response.cancel' ? { reason: 'cancel_observed' as const } : {}),
      });
      if (message?.type === 'response.create') startRequest(bytes, message);
    },
    response(bytes: Buffer, binary: boolean) {
      if (state === 'closed') return;
      const message = binary ? undefined : parseMessage(bytes);
      if (typeof message?.type === 'string' && CONNECTION_NOTIFICATIONS.has(message.type)) {
        observe('server', 'message', bytes, { representation: 'text' });
        return;
      }
      const response = message?.response as Record<string, unknown> | undefined;
      const id = response?.id ?? message?.response_id;
      const item = message?.item as Record<string, unknown> | undefined;
      const itemId = item?.id ?? message?.item_id;
      if (typeof message?.type !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(message.type))
        lose(binary ? 'binary_message' : 'invalid_message');
      else if (!pending) lose('response_without_request');
      else if (typeof id === 'string') {
        if (!id.length || id.length > 256) lose('invalid_response_id');
        else if (message.type === 'response.created' && pending.responseId)
          lose('duplicate_response_start');
        else if (responseIds.has(id) || (pending.responseId && pending.responseId !== id))
          lose('response_id_conflict');
        else pending.responseId = id;
      } else if (id !== undefined || !pending.responseId || TERMINAL.has(message.type))
        lose('missing_response_id');
      if (state !== 'lost' && pending && message) {
        if (message.type === 'response.output_item.added') {
          // Responses deltas carry item_id, not response_id. Bind each item only inside the
          // sole named active response, and never reuse a retired item on a later request.
          if (
            typeof itemId !== 'string' ||
            !itemId.length ||
            itemId.length > 256 ||
            retiredItems.has(itemId) ||
            pending.items.has(itemId)
          )
            lose('unbound_response_item');
          else if (responseIds.size + retiredItems.size + pending.items.size >= 65536)
            lose('response_id_history_limit');
          else pending.items.add(itemId);
        } else if (id === undefined && (typeof itemId !== 'string' || !pending.items.has(itemId)))
          lose('unbound_response_item');
      }
      observe('server', 'message', bytes, { representation: binary ? 'binary' : 'text' });
      if (state === 'lost' || !pending || !message) return;
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
      if (!pending.truncated) {
        if (size <= maxCaptured - pending.held) {
          const reserved = budget.reserve(size);
          pending.held += reserved;
          if (reserved === size) pending.response.push(frame);
          else {
            pending.truncated = true;
            pending.reasons.add('buffer_limit');
          }
        } else {
          pending.truncated = true;
          pending.reasons.add('body_limit');
        }
      }
      if (TERMINAL.has(message.type as string)) {
        // A named terminal for the sole outstanding response is a cancellation drain boundary.
        // Errors without this evidence have already moved to lost above.
        const cancelled = pending.cancelled;
        if (pending.responseId) responseIds.add(pending.responseId);
        for (const item of pending.items) retiredItems.add(item);
        const output = Array.isArray(response?.output) ? response.output : undefined;
        for (const item of output ?? []) {
          const itemId = (item as { id?: unknown } | null)?.id;
          if (typeof itemId === 'string' && itemId.length <= 256) retiredItems.add(itemId);
        }
        finish(
          !cancelled &&
            message.type === 'response.completed' &&
            typeof response?.id === 'string' &&
            (response.status === undefined || response.status === 'completed') &&
            output !== undefined,
          output,
        );
        state = 'ready';
        if (cancelled)
          observe('recorder', 'diagnostic', undefined, {
            reason: 'cancel_observed',
            recovery: 'cancel_terminal',
          });
        if (responseIds.size + retiredItems.size >= 65536) lose('response_id_history_limit');
      }
    },
    frameFailure(direction: 'client' | 'server', bytes: Buffer, oversized = false) {
      if (state === 'closed') return;
      lose('receiver_failed', 'frame_parse_failure');
      // Message boundaries are no longer known. Bound the entire remaining raw stream per
      // direction rather than treating every TCP chunk as a new unlimited message.
      const omitted = oversized || bytes.length > maxCaptured - rawBytes[direction];
      if (!omitted) rawBytes[direction] += bytes.length;
      observe(direction, 'message', bytes, {
        representation: 'wire',
        reason: 'frame_parse_failure',
        ...(omitted ? { omission: 'body_limit', payload: undefined } : {}),
      });
    },
    close() {
      if (state === 'closed') return;
      pending?.reasons.add('connection_closed');
      finish(false);
      state = 'closed';
      observe('recorder', 'close', undefined, { reason: 'connection_closed' });
      settle();
    },
  };
}

function observeFrames(
  isServer: boolean,
  options: RelayOptions,
  onMessage: (data: Buffer, binary: boolean) => void,
  frameFailure: (direction: 'client' | 'server', bytes: Buffer, oversized?: boolean) => void,
): Transform {
  const parser = new Receiver({ isServer, maxPayload: options.maxCaptured });
  let observing = true;
  let oversized = false;
  parser.on('message', onMessage);
  parser.once('error', (error: NodeJS.ErrnoException) => {
    observing = false;
    oversized = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
  });
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      // Receiver unmasks frames in-place; retain only the original forwarding buffer.
      if (observing)
        parser.write(Buffer.from(chunk), (error) => {
          if (error) {
            observing = false;
            oversized =
              (error as NodeJS.ErrnoException).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
            frameFailure(isServer ? 'client' : 'server', chunk, oversized);
          }
        });
      else frameFailure(isServer ? 'client' : 'server', chunk);
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
    if (capture) options.track?.(capture.drained);
    const outgoing = capture && observeFrames(true, options, capture.request, capture.frameFailure);
    const incoming =
      capture && observeFrames(false, options, capture.response, capture.frameFailure);
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
