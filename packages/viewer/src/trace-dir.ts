/**
 * Reads a run directory straight off disk, per spec §1. Deliberately does not depend on
 * @agenticreplay/core: the format is the contract, and a reader that only knows the spec proves it.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertManifest, type Manifest, type TraceEvent } from '@agenticreplay/schema';
import { referencedBlobs } from './render.js';

/**
 * No silent body loss: the reader loads every redacted text blob unless the caller supplies a cap.
 * This is intentionally not a bounded-memory guarantee; callers handling untrusted large traces
 * should pass `maxBlobBytes` and inspect `omittedBlobs`.
 */
export const DEFAULT_MAX_BLOB_BYTES = Number.POSITIVE_INFINITY;

export interface TraceDirContents {
  manifest: Manifest;
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

  let eventsText = '';
  try {
    eventsText = await readFile(join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    eventsText = '';
  }

  const events: TraceEvent[] = [];
  let skippedLines = 0;
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
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      omittedBlobs += 1;
      continue;
    }
    if (size > budget) {
      omittedBlobs += 1;
      continue;
    }
    let text: string | null;
    try {
      text = decodeText(await readFile(path));
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

  return { manifest, events, blobs, skippedLines, omittedBlobs };
}
