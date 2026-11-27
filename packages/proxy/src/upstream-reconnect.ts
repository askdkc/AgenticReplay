import type { ServerResponse } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';

// Only start new attempts in this window. A model that accepts the connection can still
// take as long as it needs to generate its first token.
const RECONNECT_WINDOW_MS = 120_000;
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
]);
const DIAGNOSTIC_CODES = new Set([
  ...CONNECT_CODES,
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function transportErrors(error: unknown): Pick<NodeJS.ErrnoException, 'code' | 'syscall'>[] {
  // Node fetch wraps the socket error in TypeError.cause. A dual-stack connection can
  // report several errors, one per address. Every address must have failed before send.
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  const errors = cause instanceof AggregateError ? cause.errors : [cause];
  return errors.map((item: unknown) =>
    item instanceof Error ? (item as NodeJS.ErrnoException) : {},
  );
}

export function transportCodes(error: unknown): string {
  const codes = transportErrors(error).map((e) => e.code);
  return [...new Set(codes.filter((code) => code && DIAGNOSTIC_CODES.has(code)))].join(', ');
}

function failedBeforeSend(error: unknown): boolean {
  const errors = transportErrors(error);
  return (
    errors.length > 0 &&
    errors.every(
      ({ code, syscall }) =>
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'EAI_AGAIN' ||
        (syscall === 'connect' && CONNECT_CODES.has(code ?? '')),
    )
  );
}

export async function fetchWithReconnect(
  send: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  client: ServerResponse,
  shutdown: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  client.once('close', onClose);
  if (client.destroyed) onClose();
  // Shutdown stops reconnecting, but drains a request that the provider is already serving.
  const stopRetrying = AbortSignal.any([controller.signal, shutdown]);
  const request = { ...init, signal: controller.signal };
  const deadline = performance.now() + RECONNECT_WINDOW_MS;
  let backoff = 500;
  let attempts = 0;
  try {
    for (;;) {
      stopRetrying.throwIfAborted();
      attempts++;
      try {
        return await send(url, request);
      } catch (error) {
        stopRetrying.throwIfAborted();
        // A streamed upload may already have been consumed even if the dial failed.
        if (typeof init.body !== 'string' || !failedBeforeSend(error)) throw error;
        if (performance.now() + backoff < deadline) {
          await wait(backoff, undefined, { signal: stopRetrying });
          backoff = Math.min(backoff * 2, 5_000);
          if (performance.now() < deadline) continue;
        }
        throw new Error(`upstream connection unavailable after ${attempts} attempts`, {
          cause: error instanceof Error ? (error.cause ?? error) : error,
        });
      }
    }
  } finally {
    client.off('close', onClose);
  }
}
