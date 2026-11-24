import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { BlobRef, Manifest, TraceEvent } from '@agenticreplay/schema';
import { EVENT_TYPES, assertManifest, isBlobRef, validateEvent } from '@agenticreplay/schema';
import { BlobStore } from './blobs.js';
import { eventLogLayout, hashRunEventLog } from './event-log.js';

/** A line the reader could not use. Reported, never repaired (spec §6). */
export interface ReadProblem {
  /**
   * 1-based line number within `file`; 0 for a problem with a file or the set of them.
   *
   * Kept per file rather than numbered across the log: "line 7" of an unknown file is not a
   * location anyone can look at, and a rotated run has several line 7s.
   */
  line: number;
  /** The segment the line is in, absent for a problem with the run's event log as a whole. */
  file?: string;
  reason: string;
}

export interface IntegrityResult {
  /**
   * True only for a sealed run whose event files still hash to the digest it was sealed with.
   *
   * The digest covers every segment in `seq` order, so a run that rotated is verified as a whole
   * rather than as its first file.
   */
  ok: boolean;
  /**
   * Why `ok` is what it is. `unsealed` is not `mismatch`, and collapsing the two is how a run whose
   * recorder was killed gets reported as tampered: nothing changed under it, there was simply never
   * a digest to check it against. Callers that only care whether the bytes are trustworthy read
   * `ok`; callers that tell a person what happened have to tell those two apart.
   */
  state: 'verified' | 'unsealed' | 'mismatch';
  /** Absent when the run was never sealed, so there is nothing to check against. */
  expected?: string;
  actual?: string;
  /** What the log is made of, in order: one file, or the segments of a rotated run. */
  files: string[];
}

const KNOWN_TYPES = new Set<string>(EVENT_TYPES);

/**
 * Reader for one recorded run.
 *
 * Two tolerances are mandated by spec §2 and both are deliberate: a run that crashed mid-write
 * leaves a partial final line, and a trace written by a newer AgenticReplay may carry event types this
 * build has never heard of. Neither may take down the whole trace — but neither is hidden either,
 * so anything skipped shows up in {@link problems}.
 *
 * A run's events may be in more than one file (spec §2.4). Every read here goes through that set,
 * in order, so `events()`, `stream()`, `verifyIntegrity()` and the blob store all describe the run
 * rather than its first file.
 */
export class TraceReader {
  readonly #runDir: string;
  readonly #manifest: Manifest;
  readonly #blobs: BlobStore;
  #problems: ReadProblem[] = [];

  private constructor(runDir: string, manifest: Manifest) {
    this.#runDir = runDir;
    this.#manifest = manifest;
    this.#blobs = new BlobStore(join(runDir, 'blobs'));
  }

  static async open(runDir: string): Promise<TraceReader> {
    const path = join(runDir, 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new Error(`not an agenticreplay run: cannot read ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`invalid manifest: ${path} is not JSON`);
    }
    assertManifest(parsed);
    return new TraceReader(runDir, parsed);
  }

  get runDir(): string {
    return this.#runDir;
  }

  manifest(): Manifest {
    return this.#manifest;
  }

  /** Lines skipped by the most recent read pass, and anything wrong with the log's file set. */
  problems(): ReadProblem[] {
    return [...this.#problems];
  }

  /**
   * The event files of this run, in `seq` order.
   *
   * Also records what is wrong with the set — a gap, or a file the manifest names and the
   * directory lacks — without pretending the remainder is the whole record. Callers that must not
   * show a partial trace as a complete one read {@link problems}.
   */
  async files(): Promise<string[]> {
    const layout = await eventLogLayout(this.#runDir, this.#manifest);
    this.#problems = layout.problems.map((reason) => ({ line: 0, reason }));
    return layout.segments.map((segment) => segment.path);
  }

  async events(): Promise<TraceEvent[]> {
    const out: TraceEvent[] = [];
    for await (const e of this.stream()) out.push(e);
    return out;
  }

  async *stream(): AsyncIterableIterator<TraceEvent> {
    const layout = await eventLogLayout(this.#runDir, this.#manifest);
    this.#problems = layout.problems.map((reason) => ({ line: 0, reason }));
    if (layout.segments.length === 0) return;
    for (const [position, segment] of layout.segments.entries()) {
      if (!(await stat(segment.path).catch(() => null))) {
        this.#problems.push({ line: 0, file: segment.name, reason: `${segment.path} is missing` });
        continue;
      }
      const rl = createInterface({
        input: createReadStream(segment.path),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      // One line is held back so the last one can be told apart from the rest: only the last line
      // of the LAST file may legitimately be half-written. A torn line anywhere earlier is a
      // malformed line, not a tolerated tail.
      let held: { line: number; text: string } | undefined;
      let n = 0;
      const isLastFile = position === layout.segments.length - 1;
      try {
        for await (const raw of rl) {
          n += 1;
          if (raw.trim().length === 0) continue;
          if (held) {
            const e = this.#parse(segment.name, held, false);
            if (e) yield e;
          }
          held = { line: n, text: raw };
        }
        if (held) {
          const e = this.#parse(segment.name, held, isLastFile);
          if (e) yield e;
        }
        // A segment with nothing in it is not evidence of anything, and a run that left one behind
        // a later file is a rotation that was interrupted. Said out loud, because a reader told
        // "the log is these files" would otherwise take an empty middle as a quiet stretch.
        if (!isLastFile && n === 0) {
          this.#problems.push({
            line: 0,
            file: segment.name,
            reason: 'segment is empty but is not the last file',
          });
        }
      } finally {
        rl.close();
      }
    }
  }

  async blob(ref: BlobRef | string): Promise<Uint8Array> {
    return this.#blobs.get(ref);
  }

  /** The event's payload, reading it back from its blob when it was spilled (spec §2.2). */
  async resolvePayload(event: TraceEvent): Promise<unknown> {
    const payload = event.payload;
    if (!isBlobRef(payload)) return payload;
    const text = new TextDecoder().decode(await this.blob(payload));
    if (payload.media_type !== undefined && !payload.media_type.includes('json')) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`blob ${payload.$blob} is not JSON; read it with blob() instead`);
    }
  }

  async verifyIntegrity(): Promise<IntegrityResult> {
    const files = await this.files();
    const actual = await hashRunEventLog(this.#runDir, this.#manifest);
    const expected = this.#manifest.integrity?.events_sha256;
    if (expected === undefined) return { ok: false, state: 'unsealed', actual, files };
    return expected === actual
      ? { ok: true, state: 'verified', expected, actual, files }
      : { ok: false, state: 'mismatch', expected, actual, files };
  }

  #parse(
    file: string,
    held: { line: number; text: string },
    isLast: boolean,
  ): TraceEvent | undefined {
    let value: unknown;
    try {
      value = JSON.parse(held.text);
    } catch {
      const reason = isLast ? 'truncated final line' : 'malformed JSON';
      this.#problems.push({ line: held.line, file, reason });
      return undefined;
    }
    const type = (value as { type?: unknown }).type;
    if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
      this.#problems.push({
        line: held.line,
        file,
        reason: `unknown event type ${JSON.stringify(type)}`,
      });
      return undefined;
    }
    const result = validateEvent(value);
    if (!result.valid) {
      this.#problems.push({ line: held.line, file, reason: result.errors.join('; ') });
      return undefined;
    }
    return value as TraceEvent;
  }
}
