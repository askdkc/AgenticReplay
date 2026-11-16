import { types } from 'node:util';
import type { InterceptFailure, TlsInterceptOptions } from './intercept.js';

const errorCodes = [
  'ENOSPC',
  'EACCES',
  'EPERM',
  'ENOENT',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EROFS',
  'EDQUOT',
] as const;
const errorTypes = new Map<object, CaptureDiagnostic['errorType']>([
  [Error.prototype, 'Error'],
  [TypeError.prototype, 'TypeError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [RangeError.prototype, 'RangeError'],
]);

export interface CaptureDiagnostic {
  phase: 'observation' | 'request_start' | 'exchange';
  errorCode: (typeof errorCodes)[number] | 'UNKNOWN';
  errorType: 'Error' | 'TypeError' | 'SyntaxError' | 'RangeError' | 'Unknown';
  count: number;
  firstAt: number;
  lastAt: number;
  emit: boolean;
  summary?: 'periodic' | 'final';
}

function classify(error: unknown): Pick<CaptureDiagnostic, 'errorCode' | 'errorType'> {
  if (types.isProxy(error) || !types.isNativeError(error))
    return { errorCode: 'UNKNOWN', errorType: 'Unknown' };

  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const code: unknown =
    descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  const errorCode = errorCodes.find((allowed) => allowed === code) ?? 'UNKNOWN';
  let prototype: object | null = Object.getPrototypeOf(error);
  while (prototype !== null && !types.isProxy(prototype)) {
    const errorType = errorTypes.get(prototype);
    if (errorType) return { errorCode, errorType };
    prototype = Object.getPrototypeOf(prototype);
  }
  return { errorCode, errorType: 'Unknown' };
}

export function reportWebSocketFailure(
  onFailure: TlsInterceptOptions['onFailure'],
  failure: InterceptFailure,
): void {
  try {
    void Promise.resolve(onFailure?.(failure)).catch(() => {});
  } catch {
    // Diagnostic delivery must never interrupt the relay or report another capture failure.
  }
}

interface FailureCounter {
  diagnostic: CaptureDiagnostic;
  reportedCount: number;
  nextCount: number;
}

export function captureFailures(report: (diagnostic: CaptureDiagnostic) => void) {
  const counters = new Map<string, FailureCounter>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function summarize(summary: NonNullable<CaptureDiagnostic['summary']>): void {
    for (const counter of counters.values()) {
      const diagnostic = counter.diagnostic;
      if (counter.reportedCount === diagnostic.count) continue;
      counter.reportedCount = diagnostic.count;
      report({ ...diagnostic, emit: true, summary });
    }
  }

  return {
    record(phase: CaptureDiagnostic['phase'], error: unknown): void {
      const classification = classify(error);
      const key = `${phase}:${classification.errorCode}:${classification.errorType}`;
      const now = Date.now();
      let counter = counters.get(key);
      if (!counter) {
        counter = {
          diagnostic: {
            phase,
            ...classification,
            count: 0,
            firstAt: now,
            lastAt: now,
            emit: false,
          },
          nextCount: 1,
          reportedCount: 0,
        };
        counters.set(key, counter);
      }
      const diagnostic = counter.diagnostic;
      diagnostic.count++;
      diagnostic.lastAt = now;
      diagnostic.emit = diagnostic.count === counter.nextCount;
      if (diagnostic.emit) {
        counter.nextCount *= 2;
        counter.reportedCount = diagnostic.count;
      }
      timer ??= setInterval(() => summarize('periodic'), 60_000).unref();
      report({ ...diagnostic });
    },
    finish(): void {
      clearInterval(timer);
      timer = undefined;
      summarize('final');
      counters.clear();
    },
  };
}
