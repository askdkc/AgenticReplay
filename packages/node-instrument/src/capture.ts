import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type HeaderInput = ConstructorParameters<typeof Headers>[0];
type BodyValue = NonNullable<RequestInit['body']>;

export interface FetchCaptureScope {
  readonly sessionId?: string;
  readonly modelCallId?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface FetchCaptureEventBase {
  readonly boundary: 'fetch';
  readonly attemptId: string;
  readonly scope?: FetchCaptureScope;
  readonly url: string;
  readonly observedAt: string;
  readonly requestStartedAt: number;
  readonly captureStatus: 'complete' | 'partial' | 'omitted';
  readonly captureIssues?: readonly string[];
  readonly terminalOutcome?: 'completed' | 'origin_error' | 'client_aborted';
}

export interface FetchRequestStartEvent extends FetchCaptureEventBase {
  readonly kind: 'request-start';
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly requestBytes?: number;
}

export interface FetchRequestBodyEvent extends FetchCaptureEventBase {
  readonly kind: 'request-body';
  readonly body?: string;
  readonly requestBytes: number;
  readonly capturedBytes: number;
  readonly decoding: 'unknown';
}

export interface FetchResponseEvent extends FetchCaptureEventBase {
  readonly kind: 'response';
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly responseBytes?: number;
  readonly capturedBytes?: number;
  readonly body?: string;
  readonly decoding: 'unknown';
}

export interface FetchErrorEvent extends FetchCaptureEventBase {
  readonly kind: 'error';
  readonly error: string;
}

export type FetchCaptureEvent =
  FetchRequestStartEvent | FetchRequestBodyEvent | FetchResponseEvent | FetchErrorEvent;

export interface FetchCaptureOptions {
  readonly onEvent: (event: FetchCaptureEvent) => void | Promise<void>;
  readonly onSinkError?: (error: unknown, event: FetchCaptureEvent) => void | Promise<void>;
  readonly maxBodyBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly shouldCapture?: (url: string) => boolean;
}

export const fetchCaptureScope = new AsyncLocalStorage<FetchCaptureScope>();

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024 * 1024;
const installed = Symbol.for('agenticreplay.fetchCapture');
type GlobalFetch = typeof globalThis.fetch & { [installed]?: true };

function headersOf(headers: HeaderInput | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function inputDetails(
  input: FetchInput,
  init?: FetchInit,
): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyValue | null;
  request?: Request;
} {
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers !== undefined)
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return {
      url: input.url,
      method: init?.method ?? input.method,
      headers: headersOf(headers),
      body: init?.body,
      request: input,
    };
  }
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    headers: headersOf(init?.headers ?? {}),
    body: init?.body,
  };
}

function boundedBytes(
  bytes: Uint8Array,
  limit: number,
): { text?: string; bytes: number; captured: number; complete: boolean; issue?: string } {
  const captured = bytes.subarray(0, Math.min(bytes.byteLength, limit));
  let text: string | undefined;
  let issue: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(captured);
  } catch {
    issue = 'unsupported_binary_body';
  }
  return {
    ...(text === undefined ? {} : { text }),
    bytes: bytes.byteLength,
    captured: captured.byteLength,
    complete: bytes.byteLength <= limit,
    ...(issue === undefined && bytes.byteLength > limit
      ? { issue: 'body_limit' }
      : issue === undefined
        ? {}
        : { issue }),
  };
}

async function boundedBody(
  body: BodyValue | null | undefined,
  limit: number,
): Promise<{ text?: string; bytes: number; captured: number; complete: boolean; issue?: string }> {
  if (body === undefined || body === null) return { bytes: 0, captured: 0, complete: true };
  if (typeof body === 'string') {
    const bytes = Buffer.byteLength(body);
    return boundedBytes(Buffer.from(body), limit);
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
    return boundedBytes(bytes, limit);
  }
  return { bytes: 0, captured: 0, complete: false, issue: 'body_stream_unavailable' };
}

function captureResponse(
  response: Response,
  base: Omit<
    FetchResponseEvent,
    | 'kind'
    | 'status'
    | 'headers'
    | 'decoding'
    | 'captureStatus'
    | 'responseBytes'
    | 'capturedBytes'
    | 'body'
    | 'terminalOutcome'
    | 'captureIssues'
  >,
  limit: number,
  initialIssue: string | undefined,
  emit: (event: FetchResponseEvent) => Promise<void>,
  active: Set<() => void>,
  release: () => void,
): Response {
  if (!response.body) {
    void emit({
      ...base,
      kind: 'response',
      status: response.status,
      headers: headersOf(response.headers),
      responseBytes: 0,
      capturedBytes: 0,
      decoding: 'unknown',
      terminalOutcome: 'completed',
      captureStatus: initialIssue === undefined ? 'complete' : 'partial',
      ...(initialIssue === undefined ? {} : { captureIssues: [initialIssue] }),
    })
      .catch(() => undefined)
      .finally(release);
    return response;
  }
  const reader = response.body.getReader();
  const contentEncoding = response.headers.get('content-encoding');
  const normalizationIssue = contentEncoding === null ? undefined : 'content_encoding_normalized';
  const captured: Uint8Array[] = [];
  let bytes = 0;
  let capturedBytes = 0;
  let closed = false;
  let cancelCapture: (() => void) | undefined;
  const finish = (outcome: FetchResponseEvent['terminalOutcome'], issue?: string) => {
    if (closed) return;
    closed = true;
    if (cancelCapture !== undefined) active.delete(cancelCapture);
    let decodedBody: string | undefined;
    let decodingIssue: string | undefined;
    if (captured.length > 0) {
      try {
        decodedBody = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(captured));
      } catch {
        decodingIssue = 'unsupported_binary_body';
      }
    }
    const issues = [
      ...new Set(
        [
          initialIssue,
          issue,
          decodingIssue,
          capturedBytes < bytes ? 'body_limit' : undefined,
          normalizationIssue,
        ].filter((value): value is string => value !== undefined),
      ),
    ];
    void emit({
      ...base,
      kind: 'response',
      status: response.status,
      headers: headersOf(response.headers),
      responseBytes: bytes,
      capturedBytes,
      ...(decodedBody === undefined ? {} : { body: decodedBody }),
      decoding: 'unknown',
      terminalOutcome: outcome,
      captureStatus:
        outcome === 'completed' &&
        capturedBytes === bytes &&
        initialIssue === undefined &&
        issue === undefined &&
        decodingIssue === undefined
          ? 'complete'
          : 'partial',
      ...(issues.length === 0 ? {} : { captureIssues: issues }),
    })
      .catch(() => undefined)
      .finally(release);
  };
  cancelCapture = () => {
    finish('client_aborted', 'not_consumed');
    void reader.cancel('capture_disposed').catch(() => undefined);
  };
  active.add(cancelCapture);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          finish('completed');
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (capturedBytes < limit) {
          const take = part.value.subarray(
            0,
            Math.min(part.value.byteLength, limit - capturedBytes),
          );
          captured.push(take);
          capturedBytes += take.byteLength;
        }
        controller.enqueue(part.value);
      } catch (error) {
        finish('origin_error', error instanceof Error ? error.message : String(error));
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish('client_aborted', 'consumer_cancelled');
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function boundedRequest(details: ReturnType<typeof inputDetails>, limit: number) {
  if (details.body !== undefined) return boundedBody(details.body, limit);
  if (!details.request?.body) return boundedBody(undefined, limit);
  try {
    const clone = details.request.clone();
    if (!clone.body) return boundedBody(undefined, limit);
    const reader = clone.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let overLimit = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const previous = bytes;
        bytes += part.value.byteLength;
        if (previous < limit)
          chunks.push(part.value.subarray(0, Math.min(part.value.byteLength, limit - previous)));
        if (bytes > limit) {
          overLimit = true;
          break;
        }
      }
    } finally {
      if (overLimit) await reader.cancel('capture limit reached').catch(() => undefined);
    }
    if (overLimit)
      return {
        ...boundedBytes(Buffer.concat(chunks), limit),
        bytes,
        complete: false,
        issue: 'body_limit',
      };
    return boundedBytes(Buffer.concat(chunks), limit);
  } catch {
    return { bytes: 0, captured: 0, complete: false, issue: 'request_clone_failed' };
  }
}

export function withFetchCaptureScope<T>(scope: FetchCaptureScope, operation: () => T): T {
  return fetchCaptureScope.run(scope, operation);
}

/** Install process-local fetch observation. The returned disposer drains all capture tasks. */
export function installFetchCapture(options: FetchCaptureOptions): () => Promise<void> {
  const original = globalThis.fetch as GlobalFetch;
  if (original[installed])
    throw new Error('fetch capture is already installed; use one process-global sink');
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError('maxBodyBytes must be a positive safe integer');
  if (!Number.isSafeInteger(maxBuffered) || maxBuffered < limit)
    throw new RangeError('maxBufferedBytes must be a safe integer >= maxBodyBytes');
  const pending = new Set<Promise<unknown>>();
  const activeResponses = new Set<() => void>();
  let reserved = 0;
  let sinkFailed = false;
  let sinkFailure: unknown;
  const emit = async (event: FetchCaptureEvent) => {
    if (sinkFailed) throw sinkFailure;
    const task = (async () => {
      try {
        await options.onEvent(event);
      } catch (error) {
        if (!sinkFailed) {
          sinkFailed = true;
          sinkFailure = error;
        }
        try {
          await options.onSinkError?.(error, event);
        } catch {
          /* Sink diagnostics cannot replace the original failure. */
        }
        throw error;
      }
    })();
    pending.add(task);
    try {
      await task;
    } finally {
      pending.delete(task);
    }
  };
  const capture = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const details = inputDetails(input, init);
    const enabled = options.shouldCapture?.(details.url) ?? true;
    if (!enabled) return original(input, init);
    const scope = fetchCaptureScope.getStore();
    const attemptId = randomUUID();
    const requestStartedAt = Date.now();
    const base = {
      boundary: 'fetch' as const,
      attemptId,
      ...(scope === undefined ? {} : { scope }),
      url: details.url,
      observedAt: new Date(requestStartedAt).toISOString(),
      requestStartedAt,
    };
    await emit({
      ...base,
      kind: 'request-start',
      method: details.method,
      headers: details.headers,
      captureStatus: 'complete',
    });
    const reserve = Math.min(limit, maxBuffered);
    const canBuffer = reserved + reserve <= maxBuffered;
    if (canBuffer) reserved += reserve;
    let request: Awaited<ReturnType<typeof boundedRequest>>;
    if (!canBuffer) request = { bytes: 0, captured: 0, complete: false, issue: 'buffer_limit' };
    else {
      // Clone/tee the Request before dispatch can disturb its body. The request-start
      // evidence above is already persisted before this asynchronous buffering begins.
      const requestPromise = boundedRequest(details, limit);
      const responsePromise = original(input, init);
      // The request clone may take longer than an origin failure. Attach a rejection handler
      // immediately so a fast connection failure cannot become an unhandled rejection while the
      // bounded request evidence is still being collected; the original rejection is still awaited
      // below and remains the fetch outcome.
      void responsePromise.catch(() => undefined);
      try {
        request = await requestPromise;
      } catch {
        request = { bytes: 0, captured: 0, complete: false, issue: 'body_capture_failed' };
      }
      void emit({
        ...base,
        kind: 'request-body',
        requestBytes: request.bytes,
        capturedBytes: request.captured,
        ...(request.text === undefined ? {} : { body: request.text }),
        decoding: 'unknown',
        captureStatus: request.complete ? 'complete' : 'partial',
        ...(request.issue ? { captureIssues: [request.issue] } : {}),
      }).catch(() => undefined);
      if (canBuffer) reserved -= reserve;
      try {
        const response = await responsePromise;
        const responseReserve = Math.min(limit, maxBuffered);
        const responseCanBuffer = reserved + responseReserve <= maxBuffered;
        if (responseCanBuffer) reserved += responseReserve;
        return captureResponse(
          response,
          base,
          responseCanBuffer ? limit : 0,
          responseCanBuffer ? undefined : 'buffer_limit',
          emit,
          activeResponses,
          () => {
            if (responseCanBuffer) reserved -= responseReserve;
          },
        );
      } catch (error) {
        const aborted = details.request?.signal.aborted === true || init?.signal?.aborted === true;
        void emit({
          ...base,
          kind: 'error',
          error: error instanceof Error ? error.message : String(error),
          terminalOutcome: aborted ? 'client_aborted' : 'origin_error',
          captureStatus: request.complete ? 'complete' : 'partial',
          ...(request.issue ? { captureIssues: [request.issue] } : {}),
        }).catch(() => undefined);
        throw error;
      }
    }
    void emit({
      ...base,
      kind: 'request-body',
      requestBytes: request.bytes,
      capturedBytes: request.captured,
      ...(request.text === undefined ? {} : { body: request.text }),
      decoding: 'unknown',
      captureStatus: request.complete ? 'complete' : 'partial',
      ...(request.issue ? { captureIssues: [request.issue] } : {}),
    }).catch(() => undefined);
    try {
      const response = await original(input, init);
      const responseReserve = Math.min(limit, maxBuffered);
      const responseCanBuffer = reserved + responseReserve <= maxBuffered;
      if (responseCanBuffer) reserved += responseReserve;
      return captureResponse(
        response,
        base,
        responseCanBuffer ? limit : 0,
        responseCanBuffer ? undefined : 'buffer_limit',
        emit,
        activeResponses,
        () => {
          if (responseCanBuffer) reserved -= responseReserve;
        },
      );
    } catch (error) {
      void emit({
        ...base,
        kind: 'error',
        error: error instanceof Error ? error.message : String(error),
        terminalOutcome: 'origin_error',
        captureStatus: 'partial',
        captureIssues: ['buffer_limit'],
      }).catch(() => undefined);
      throw error;
    }
  };
  const wrapped = capture as GlobalFetch;
  wrapped[installed] = true;
  globalThis.fetch = wrapped;
  return async () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
    for (const finalize of [...activeResponses]) finalize();
    while (pending.size > 0) await Promise.allSettled([...pending]);
    if (sinkFailed) throw sinkFailure ?? new Error('fetch capture sink failed');
  };
}
