import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest } from '@agenticreplay/schema';

export const CAPTURE_STATUS_FILE = 'capture-status.json';
const MAX_STATUS_BYTES = 8 * 1024;
const REASONS: ReadonlyMap<string, string> = new Map([
  ['queue_limit', 'Recording queue limit reached'],
  ['index_persistence_failed', 'Could not save the recording index'],
  ['trace_limit', 'Trace size limit reached'],
  ['trace_file_limit', 'Trace file count limit reached'],
  ['recording_io_failed', 'Could not write or finalize the recording'],
  ['ENOSPC', 'Storage ran out of space'],
  ['EACCES', 'Recording storage access denied'],
  ['EPERM', 'Recording storage access denied'],
  ['drain_timeout', 'Recording timed out waiting for pending calls'],
  ['missing_cause', 'An event could not be linked to its recorded cause'],
  ['trace_integrity_mismatch', 'Recording integrity check failed'],
]);

export interface CaptureDiagnostic {
  state: 'failed' | 'incomplete';
  reason: string;
  code?: string;
  missingEvents: number | undefined;
  unresolvedCalls: number | undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read only the same run's bounded DSH diagnostic. Exports may be shared, so render fixed
 * labels and counts, never arbitrary diagnostic strings, call IDs or exception details. */
export async function readCaptureDiagnostic(
  runDir: string,
  manifest: Manifest,
): Promise<CaptureDiagnostic | undefined> {
  if (manifest.adapter.id !== 'kiokuko-dsh') return undefined;
  let file: FileHandle | undefined;
  try {
    file = await open(
      join(runDir, CAPTURE_STATUS_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_STATUS_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > MAX_STATUS_BYTES) return undefined;
    const status = object(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    const state = status?.['state'];
    if (
      status?.['format'] !== 'dsh.capture-status.v1' ||
      status['httpCapture'] !== false ||
      status['runId'] !== manifest.run_id ||
      (state !== 'incomplete' && state !== 'failed')
    )
      return undefined;

    const code = status['lastErrorCode'] ?? object(status['failure'])?.['code'];
    const reason = typeof code === 'string' ? REASONS.get(code) : undefined;
    return {
      state,
      reason: reason ?? 'Recording failure reason unavailable',
      ...(reason && typeof code === 'string' ? { code } : {}),
      missingEvents: count(status['missingEvents']),
      unresolvedCalls: count(status['unresolvedCalls']),
    };
  } catch {
    // The sidecar is optional, including while the recorder is still writing a run.
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
