/**
 * Reads a run directory straight off disk, per spec §1. Deliberately does not depend on
 * @agenticreplay/core: the format is the contract, and a reader that only knows the spec proves it.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVENT_LOG_FILE,
  assertManifest,
  eventSegmentFileName,
  eventSegmentIndex,
  type Manifest,
  type TraceEvent,
  type TraceSegment,
} from '@agenticreplay/schema';
import { readCaptureDiagnostic, type CaptureDiagnostic } from './capture-diagnostic.js';
import { readViewerBlob } from './blob-file.js';
import { referencedBlobs } from './render.js';

/**
 * No silent body loss: the reader loads every redacted text blob unless the caller supplies a cap.
 * This is intentionally not a bounded-memory guarantee; callers handling untrusted large traces
 * should pass `maxBlobBytes` and inspect `omittedBlobs`.
 */
export const DEFAULT_MAX_BLOB_BYTES = Number.POSITIVE_INFINITY;

export interface TraceDirContents {
  manifest: Manifest;
  captureDiagnostic?: CaptureDiagnostic;
  events: TraceEvent[];
  /** Blob text by `$blob` reference. A digest absent here renders as an omitted payload. */
  blobs: Record<string, string>;
  /** Lines that were not parseable JSON — a truncated tail, most often (spec §2). */
  skippedLines: number;
  /** Blobs left out: missing, binary, or past the byte cap. */
  omittedBlobs: number;
}

export interface ReadTraceOptions {
  maxBlobBytes?: number;
}

/** Bodies are stored as JSON strings by the writer. A download must return the body itself. */
export function bodyText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : text;
  } catch {
    return text;
  }
}

/**
 * The event files of a run, in `seq` order.
 *
 * The manifest's segment list is authoritative when it is there, because only it can distinguish a
 * rotated run from one whose later file was deleted. The directory listing is the fallback for a
 * run whose manifest predates rotation or was never sealed, and it is sorted by the numeric index
 * rather than by name so a run past segment 9 does not read out of order.
 */
export async function eventFileNames(runDir: string, manifest: Manifest): Promise<string[]> {
  const recorded: TraceSegment[] | undefined = manifest.integrity?.segments;
  if (recorded !== undefined && recorded.length > 0) return recorded.map((segment) => segment.name);
  const entries = await readdir(runDir).catch(() => []);
  const found: { name: string; index: number }[] = [];
  for (const name of entries) {
    const index = eventSegmentIndex(name);
    if (index === undefined) continue;
    found.push({ name, index });
  }
  if (found.length === 0) return [EVENT_LOG_FILE];
  found.sort((a, b) => a.index - b.index);
  // A gap is not filled in: the viewer shows what is there, and a run missing its middle file must
  // not be read as if the later segments were contiguous with the first.
  return found.map((entry) => entry.name);
}

/** The last file of a run, which a live view has to watch for changes. */
export async function liveEventFileName(runDir: string, manifest: Manifest): Promise<string> {
  const names = await eventFileNames(runDir, manifest);
  return names.at(-1) ?? eventSegmentFileName(1);
}

/** Blob text, or null when the bytes are not text we can safely put in an HTML document. */
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  return text.includes('�') ? null : text;
}

export async function readTraceDir(
  runDir: string,
  options: ReadTraceOptions = {},
): Promise<TraceDirContents> {
  let manifestText: string;
  try {
    manifestText = await readFile(join(runDir, 'manifest.json'), 'utf8');
  } catch (cause) {
    throw new Error(`cannot read manifest.json in ${runDir}`, { cause });
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestText) as Manifest;
  } catch (cause) {
    throw new Error(`manifest.json in ${runDir} is not valid JSON`, { cause });
  }
  assertManifest(manifest);

  const events: TraceEvent[] = [];
  let skippedLines = 0;
  for (const name of await eventFileNames(runDir, manifest)) {
    let eventsText = '';
    try {
      eventsText = await readFile(join(runDir, name), 'utf8');
    } catch {
      // A segment the manifest names and the directory lacks stays silent here, exactly as a
      // missing events.jsonl always did: the viewer renders what it read. `skippedLines` is
      // incremented so the page does not report a clean read of a run it could not fully open.
      skippedLines += 1;
      continue;
    }
    for (const line of eventsText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Spec §2: readers MUST tolerate a truncated final line.
        skippedLines += 1;
        continue;
      }
      const event = parsed as TraceEvent;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof event.seq === 'number' &&
        typeof event.type === 'string'
      ) {
        // Unknown `type` values are kept, not dropped: the viewer renders them generically.
        events.push(event);
      } else {
        skippedLines += 1;
      }
    }
  }

  const blobs: Record<string, string> = {};
  let omittedBlobs = 0;
  let budget = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;

  for (const ref of referencedBlobs(events)) {
    const hex = ref.replace(/^sha256:/, '');
    if (!/^[0-9a-f]{2,}$/i.test(hex)) {
      omittedBlobs += 1;
      continue;
    }
    const path = join(runDir, 'blobs', hex.slice(0, 2), hex);
    let size = 0;
    let text: string | null;
    try {
      const bytes = await readViewerBlob(path, budget);
      size = bytes.length;
      text = decodeText(bytes);
    } catch {
      text = null;
    }
    if (text === null) {
      omittedBlobs += 1;
      continue;
    }
    budget -= size;
    blobs[ref] = text;
  }

  const captureDiagnostic = await readCaptureDiagnostic(runDir, manifest);
  return {
    manifest,
    events,
    blobs,
    skippedLines,
    omittedBlobs,
    ...(captureDiagnostic && { captureDiagnostic }),
  };
}
