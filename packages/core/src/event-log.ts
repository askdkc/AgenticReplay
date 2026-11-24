import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest, TraceSegment } from '@agenticreplay/schema';
import { EVENT_LOG_FILE, eventSegmentFileName, eventSegmentIndex } from '@agenticreplay/schema';
import { sha256File } from './blobs.js';

/**
 * One run's event log, which is one file or a rotation of them (spec §1).
 *
 * A recording that outgrows its file continues in the next one under the same `run_id` and the
 * same dense `seq` order, so every reader has to treat "the log" as the ordered concatenation
 * rather than as `events.jsonl`. That is what this module is: the single place that answers which
 * files a run's events live in, in which order, and whether the set is intact.
 *
 * The manifest records the segments of a sealed run that has more than one. Discovery is the
 * fallback rather than the primary source, because a directory listing cannot tell a rotated run
 * from a run whose third file was deleted — and only the manifest can.
 */
export interface EventSegment {
  /** File name inside the run directory; `events.jsonl` for the first. */
  name: string;
  path: string;
  /** 1-based position in the log. */
  index: number;
  /** From the manifest, when it recorded them. */
  firstSeq?: number;
  lastSeq?: number;
  bytes?: number;
  sha256?: string;
}

export interface EventLogLayout {
  /** Files to read, in `seq` order. A file the manifest names but the disk lacks is absent here. */
  segments: EventSegment[];
  /**
   * What is wrong with the set as a whole: a gap in the numbering, a file the manifest names and
   * the directory does not hold, or an unlisted file after a sealed set. Empty when intact.
   *
   * Kept apart from the segments so a caller can read what survived without presenting it as the
   * complete log — the distinction the manifest's segment list exists to make.
   */
  problems: string[];
  /** Names the manifest recorded, for a caller that has to tell "short" from "different". */
  recorded: TraceSegment[];
}

/** Names in the directory that are event segments, by index, regardless of gaps. */
async function discovered(runDir: string): Promise<{ name: string; index: number }[]> {
  const entries = await readdir(runDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const found: { name: string; index: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const index = eventSegmentIndex(entry.name);
    if (index === undefined) continue;
    // A segment is a regular file this user owns like every other file in the run; a symlink here
    // would let one run read another's or any path at all.
    const info = await stat(join(runDir, entry.name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    found.push({ name: entry.name, index });
  }
  return found.sort((a, b) => a.index - b.index);
}

function fromRecorded(segment: TraceSegment): EventSegment {
  return {
    name: segment.name,
    path: '',
    index: eventSegmentIndex(segment.name) ?? 0,
    firstSeq: segment.first_seq,
    lastSeq: segment.last_seq,
    bytes: segment.bytes,
    sha256: segment.sha256,
  };
}

/**
 * Which files hold this run's events, in order, and what is wrong with the set.
 *
 * `manifest` is optional because the writer asks before the manifest is sealed, and because a run
 * whose manifest cannot be read is still worth reading event by event.
 */
export async function eventLogLayout(runDir: string, manifest?: Manifest): Promise<EventLogLayout> {
  const problems: string[] = [];
  const present = await discovered(runDir);
  const byName = new Map(present.map((entry) => [entry.name, entry]));
  const recorded = manifest?.integrity?.segments ?? [];

  if (recorded.length > 0) {
    const segments: EventSegment[] = [];
    for (const segment of recorded) {
      const found = byName.get(segment.name);
      if (!found) {
        problems.push(`${segment.name} is missing`);
        continue;
      }
      segments.push({ ...fromRecorded(segment), path: join(runDir, found.name) });
    }
    // An unlisted event file after a sealed set is either a recorder that rotated after sealing
    // (impossible: sealing is the last write) or a file put there afterwards. Either way the
    // manifest's account of the run is no longer the whole of it.
    const listed = new Set(recorded.map((segment) => segment.name));
    for (const entry of present) {
      if (!listed.has(entry.name)) problems.push(`${entry.name} is not recorded in the manifest`);
    }
    return { segments, problems, recorded };
  }

  if (present.length === 0) {
    problems.push(`${join(runDir, EVENT_LOG_FILE)} is missing`);
    return { segments: [], problems, recorded };
  }
  for (const [position, entry] of present.entries()) {
    const expected = position + 1;
    if (entry.index !== expected) {
      problems.push(
        `${entry.name} is segment ${entry.index}, expected ${eventSegmentFileName(expected)}`,
      );
    }
  }
  return {
    segments: present.map((entry) => ({
      name: entry.name,
      path: join(runDir, entry.name),
      index: entry.index,
    })),
    problems,
    recorded,
  };
}

/** The files a run's events live in, in order. Throws only when there is nothing to read. */
export async function eventLogPaths(runDir: string, manifest?: Manifest): Promise<string[]> {
  const { segments, problems } = await eventLogLayout(runDir, manifest);
  if (segments.length === 0) {
    throw new Error(problems[0] ?? `no event log in ${runDir}`);
  }
  return segments.map((segment) => segment.path);
}

/**
 * The integrity root of an event log: SHA-256 over the segments' bytes in `seq` order.
 *
 * One file hashes to exactly what it always did, so a run that never rotated keeps the digest it
 * was sealed with. Concatenating rather than hashing a list is deliberate — the digest answers
 * "is this the log the run wrote", and a reader that can only see `events.jsonl` must fail the
 * check on a rotated run rather than pass it over a prefix.
 */
export async function hashEventLog(paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of paths) {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** The integrity root of a run directory, whatever its log is split into. */
export async function hashRunEventLog(runDir: string, manifest?: Manifest): Promise<string> {
  const { segments } = await eventLogLayout(runDir, manifest);
  return hashEventLog(segments.map((segment) => segment.path));
}

/** One file's digest and size, for recording a segment in the manifest. */
export async function describeSegment(path: string, name: string): Promise<TraceSegment> {
  const [sha256, info] = await Promise.all([sha256File(path), stat(path)]);
  return {
    name,
    first_seq: 0,
    last_seq: 0,
    bytes: info.size,
    sha256,
  };
}
