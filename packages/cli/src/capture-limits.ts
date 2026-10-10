import type { ParsedArgs } from './args.js';

/** Limits bound retained bytes, independently of the live stream forwarded to the client. */
export function captureLimits(args: ParsedArgs): {
  maxCapturedBytes: number;
  maxBufferedBytes: number;
} {
  const maxCapturedBytes = args.num('max-body-bytes', 64 * 1024 * 1024)!;
  const maxBufferedBytes = args.num('max-buffered-bytes', 256 * 1024 * 1024)!;
  if (
    !Number.isSafeInteger(maxCapturedBytes) ||
    maxCapturedBytes < 1 ||
    !Number.isSafeInteger(maxBufferedBytes) ||
    maxBufferedBytes < maxCapturedBytes
  ) {
    throw new Error(
      'capture limits must be positive safe integers; --max-buffered-bytes must be at least --max-body-bytes',
    );
  }
  return { maxCapturedBytes, maxBufferedBytes };
}
