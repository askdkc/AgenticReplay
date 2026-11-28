import { createHash, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, open, rename, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  Actor,
  AdapterInfo,
  EventType,
  Manifest,
  Payload,
  TraceEvent,
  TraceSegment,
  CaptureSummary,
  CaptureTransformation,
} from '@agenticreplay/schema';
import {
  EVENT_LOG_FILE,
  INLINE_PAYLOAD_LIMIT,
  RUN_ID_PATTERN,
  SCHEMA_VERSION,
  assertEvent,
  assertManifest,
  eventSegmentFileName,
} from '@agenticreplay/schema';
import { BlobLimitError, BlobStore, sha256File } from './blobs.js';
import { eventLogLayout, hashEventLog } from './event-log.js';
import { REDACTION_POLICY_VERSION, Redactor } from './redaction.js';
import { captureDirectoryName, firstUserPrompt } from './run-names.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function coalesceRedactionTransformations(
  transformations: readonly CaptureTransformation[],
): CaptureTransformation[] {
  const coalesced: CaptureTransformation[] = [];
  const firstByKey = new Map<string, CaptureTransformation>();
  for (const transformation of transformations) {
    const { kind, location, rule, reason, count } = transformation;
    if (kind !== 'redaction' || !Number.isSafeInteger(count) || count < 0) {
      coalesced.push({ ...transformation });
      continue;
    }

    const key = JSON.stringify([kind, location, rule, reason]);
    const first = firstByKey.get(key);
    if (first && Number.isSafeInteger(first.count + count)) {
      first.count += count;
      continue;
    }

    const copy = { ...transformation };
    coalesced.push(copy);
    if (!first) firstByKey.set(key, copy);
  }
  return coalesced;
}

/** Remove credential URL components while preserving the other serialized query bytes. */
function scrubTransportUrl(value: string): { value: string; count: number } {
  let count = 0;
  const safe = value
    .replace(/^(https?:\/\/)[^/?#]*@/i, (_match, scheme: string) => {
      count += 1;
      return scheme;
    })
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator: string, key: string) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        return match;
      }
      if (
        !/^(?:api[-_]?key|key|access[-_]?token|token|authorization|password|secret|signature)$/i.test(
          decoded,
        )
      )
        return match;
      count += 1;
      return `${separator}${key}=%3Credacted%3E`;
    });
  return { value: safe, count };
}

/** Paths are operational metadata, not opaque credentials. Named secret rules still apply. */
export function redactManifest(redactor: Redactor, manifest: Manifest): Manifest {
  // `run_id` is a schema-controlled identifier, not user content. Preserve it
  // outside the whole-manifest entropy pass: random valid IDs otherwise look
  // like credentials and can make the manifest invalid before it is written.
  const { cwd, argv, env_allowlisted, run_id, ...metadata } = manifest;
  const scrubbed = JSON.parse(
    redactor.redactString(JSON.stringify(metadata), 'manifest').value,
  ) as Manifest;
  scrubbed.run_id = run_id;
  scrubbed.cwd = redactor.redactString(cwd, 'manifest.cwd', { entropy: false }).value;
  scrubbed.argv = argv.map(
    (arg, index) =>
      redactor.redactString(arg, `manifest.argv.${index}`, {
        entropy: !(isAbsolute(arg) && existsSync(arg)),
      }).value,
  );
  if (env_allowlisted)
    scrubbed.env_allowlisted = JSON.parse(
      redactor.redactString(JSON.stringify(env_allowlisted), 'manifest.env').value,
    ) as Record<string, string>;
  return scrubbed;
}

export interface StorageLimits {
  /** Optional cumulative physical blob budget, after compression. No budget by default. */
  blobBytes?: number;
  /**
   * Target size of one event file. A run that outgrows it continues in the next file rather than
   * stopping: rotation is a layout decision, not a capture failure (spec §1.1).
   *
   * Defaults to 64 MiB. Passing this without `runEventBytes` keeps the old single-file meaning:
   * that argument was the whole-run cap before rotation existed, and reinterpreting it as a
   * per-file target would turn a bounded diagnostic trace into as many files as it has events.
   */
  eventBytes?: number;
  /** Whole-run event budget across every segment. Defaults to 2 GiB when rotation is on. */
  runEventBytes?: number;
  /** Maximum number of event files in one run; rotation stops rather than filling the disk. */
  eventSegments?: number;
}
export class DiagnosticStorageLimitError extends Error {
  constructor() {
    super('diagnostic storage limit reached');
  }
}

/** Provider correlation keys accepted in compact records and terminal diagnostics. */
function isToolUseId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}

/** Format recorder-owned references after ordinary envelope redaction. Keeping IDs under
 * tool_use_id during the scan applies the same protocol-ID policy as the saved call. */
function unresolvedDiagnostic(event: TraceEvent): Record<string, unknown> | undefined {
  if (
    event.type !== 'note' ||
    event.actor !== 'agenticreplay' ||
    event.attrs?.rule !== 'unresolved_tool_calls' ||
    !Array.isArray(event.attrs.calls)
  )
    return;
  const ids: string[] = [];
  const call_seqs: number[] = [];
  for (const call of event.attrs.calls) {
    if (
      !isToolUseId(call?.tool_use_id) ||
      !Number.isSafeInteger(call.seq) ||
      call.seq < 0 ||
      call.seq >= event.seq
    ) {
      throw new Error('invalid unresolved tool call reference');
    }
    ids.push(call.tool_use_id);
    call_seqs.push(call.seq);
  }
  return { rule: 'unresolved_tool_calls', observation: 'result_not_observed', ids, call_seqs };
}

const DIAGNOSTIC_BYTES = 64 * 1024;
const END_BYTES = 4096;
/**
 * How much event content one run may keep in total, across every file.
 *
 * Rotation is what makes a long reasoning stream recordable, not a licence to fill the disk: a run
 * that reaches this stops rotating and says so, and the events it already has stay readable. 2 GiB
 * is 32 files at the 64 MiB target, which is far more than any single session produces and small
 * enough that a runaway loop is noticed rather than discovered when a volume fills.
 */
export const DEFAULT_RUN_EVENT_BYTES = 2 * 1024 * 1024 * 1024;
/** Files a run may rotate through. A structural bound; the byte budget normally binds first. */
export const DEFAULT_EVENT_SEGMENTS = 1024;

export interface TraceWriterInit {
  storageLimits?: StorageLimits;
  /** Defaults to a fresh `run_<12 hex>`. */
  runId?: string;
  /** A host-generated session title, when available. Never used as a raw filesystem path. */
  sessionTitle?: string;
  /** Session start time; defaults to the moment capture starts. */
  sessionStartedAt?: Date;
  adapter: AdapterInfo;
  argv: string[];
  cwd: string;
  agenticreplayVersion: string;
  envAllowlist?: string[];
}

/** The parts of an event a caller supplies; the writer stamps the rest. */
export interface EventInit {
  type: EventType;
  actor: Actor;
  turn?: number;
  causes?: number[];
  attrs?: Record<string, unknown>;
  /** Trusted operational path fields in attrs. Named secret rules still apply. Never use for API bodies. */
  operationalPathAttrs?: string[];
  payload?: Payload;
  /**
   * When the event actually happened, for anything captured out of band.
   *
   * Shell and MCP frames are drained from disk after the agent exits, so stamping them at write
   * time puts every one of them at the end of the run — `ts` and `mono_us` describing the drain
   * rather than the event, which spec §2.1 makes authoritative for duration. Supplying the real
   * moment is what lets them interleave with the model turns they happened between.
   */
  occurredAt?: Date;
  transformations?: CaptureTransformation[];
}

/**
 * Append-only writer for one run (spec §2).
 *
 * Every event takes the same path to disk — spill, redact, validate, append — because a redactor
 * that can be bypassed by one caller is not a redactor. Serialized bytes are scrubbed rather than
 * individual fields, so a secret hiding in a key, a nested string, or an attrs value is caught
 * regardless of shape.
 */
export class TraceWriter {
  #runDir: string;
  #sessionTitle = '';
  #titlePriority = 0;
  readonly #runId: string;
  readonly #blobs: BlobStore;
  /** Target size of the file being written; the single-file cap when rotation is off. */
  readonly #eventBytes: number;
  /** Whole-run event budget across every segment. */
  readonly #runEventBytes: number;
  /**
   * Whether the run may continue into another file.
   *
   * Off for a caller that passed `eventBytes` and no run budget: that argument was the whole-run
   * cap before rotation existed, and reinterpreting it as a per-file target would turn a bounded
   * diagnostic trace into as many files as it has events. The default path, and any caller that
   * states a run budget, rotate.
   */
  readonly #rotating: boolean;
  readonly #maxSegments: number;
  readonly #redactor: Redactor;
  readonly #base: Manifest;
  readonly #started = process.hrtime.bigint();
  readonly #startedAtMs = Date.now();
  #seq = 0;
  #handleClosed = false;
  #monoOffset = 0;
  #previousRedactions: ReturnType<Redactor['records']> = [];
  /** Whether run.start reached disk, so run.end can tell an open run from an unopened one. */
  #opened = false;
  #closedEvent = false;
  #turn = 0;
  #git: Manifest['git'];
  #tail: Promise<unknown> = Promise.resolve();
  #sealed: Manifest | undefined;
  #capture: CaptureSummary | undefined;
  readonly #captureIssues = new Set<string>();
  /** The file events are being appended to, and its 1-based index within the run. */
  #handle: FileHandle;
  #segmentIndex: number;
  #segmentName: string;
  #segmentFirstSeq: number;
  #segmentEvents: number;
  /** The live file's size, tracked so it does not have to be stat'ed per event. */
  #segmentBytes: number;
  /** Every closed file of this run, in order. The live file is appended on seal. */
  #closedSegments: { name: string; firstSeq: number; lastSeq: number; bytes: number }[] = [];
  /**
   * Set once opening the next file has failed, so the same disk full or read-only mount is not
   * retried for every event that follows. The trace already holds what it recorded; repeating a
   * failing create is how a recorder turns one bad write into a stalled session.
   */
  #rotationStopped: 'run_event_limit' | 'segment_limit' | 'rotation_failed' | undefined;

  private constructor(
    runId: string,
    runDir: string,
    base: Manifest,
    redactor: Redactor,
    handle: FileHandle,
    limits: StorageLimits = {},
    live?: {
      index: number;
      name: string;
      firstSeq: number;
      events: number;
      bytes: number;
      closed: { name: string; firstSeq: number; lastSeq: number; bytes: number }[];
    },
  ) {
    this.#runId = runId;
    this.#runDir = runDir;
    this.#blobs = new BlobStore(join(runDir, 'blobs'), limits.blobBytes);
    this.#eventBytes = limits.eventBytes ?? 64 * 1024 * 1024;
    this.#runEventBytes = limits.runEventBytes ?? DEFAULT_RUN_EVENT_BYTES;
    this.#rotating = limits.runEventBytes !== undefined || limits.eventBytes === undefined;
    this.#maxSegments = limits.eventSegments ?? DEFAULT_EVENT_SEGMENTS;
    this.#redactor = redactor;
    this.#handle = handle;
    this.#base = base;
    this.#segmentIndex = live?.index ?? 1;
    this.#segmentName = live?.name ?? EVENT_LOG_FILE;
    this.#segmentFirstSeq = live?.firstSeq ?? 0;
    this.#segmentEvents = live?.events ?? 0;
    this.#segmentBytes = live?.bytes ?? 0;
    this.#closedSegments = [...(live?.closed ?? [])];
  }

  /** The file events are appended to now. Rotation changes it; every segment is still this run. */
  get eventsPath(): string {
    return join(this.#runDir, this.#segmentName);
  }

  /** Every file this run's events are in, in `seq` order, the live one last. */
  get eventPaths(): string[] {
    return [
      ...this.#closedSegments.map((segment) => join(this.#runDir, segment.name)),
      this.eventsPath,
    ];
  }

  static async create(
    runsDir: string,
    init: TraceWriterInit,
    recovery?: { onEvent?: (event: TraceEvent) => void },
  ): Promise<TraceWriter> {
    for (const limit of Object.values(init.storageLimits ?? {})) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid storage limit');
    }
    const runId = init.runId ?? `run_${randomBytes(6).toString('hex')}`;
    if (!RUN_ID_PATTERN.test(runId))
      throw new Error(`not a valid run id: ${JSON.stringify(runId)}`);
    // One redactor for the whole run: the salt stays constant, so a secret seen in the environment
    // and again in a payload gets the same placeholder, and every removal lands in redactions.json.
    const redactor = new Redactor({ envAllowlist: init.envAllowlist, summarizeHits: true });
    const unredactedBase: Manifest = {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      created_at: (init.sessionStartedAt ?? new Date()).toISOString(),
      agenticreplay_version: init.agenticreplayVersion,
      adapter: init.adapter,
      argv: init.argv,
      cwd: init.cwd,
      env_allowlisted: redactor.redactEnv(process.env),
      platform: { os: platform(), arch: arch(), node: process.version },
      capture: { status: 'unverified', issues: [] },
    };
    const base = redactManifest(redactor, unredactedBase);
    assertManifest(base);
    const title = redactor.redactString(
      (init.sessionTitle ?? '').normalize('NFKC'),
      'session.title',
    ).value;
    const runDir = join(
      runsDir,
      captureDirectoryName(base.created_at, base.adapter.id, title, runId),
    );
    await mkdir(runsDir, { recursive: true, mode: DIR_MODE });
    try {
      await mkdir(runDir, { mode: DIR_MODE });
    } catch (error) {
      if (!recovery || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(runDir);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(runDir)) !== runDir ||
        (process.getuid && info.uid !== process.getuid()) ||
        (info.mode & 0o077) !== 0
      )
        throw new Error('unsafe initialization directory');
      const manifestPath = join(runDir, 'manifest.json');
      const manifestInfo = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (manifestInfo) {
        if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
          throw new Error('unsafe initialization manifest');
        const previous: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        assertManifest(previous);
        if (
          previous.run_id !== runId ||
          previous.cwd !== base.cwd ||
          previous.adapter.id !== base.adapter.id ||
          previous.created_at !== base.created_at
        )
          throw new Error('initialization identity mismatch');
        if (previous.ended_at || previous.counts?.events) {
          // Missing data from a populated trace is corruption, not unfinished initialization.
          await lstat(join(runDir, 'events.jsonl'));
        }
        // A crash between manifest publication and events creation leaves no event file.
        try {
          await (await open(join(runDir, 'events.jsonl'), 'ax', FILE_MODE)).close();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        return TraceWriter.resume(runDir, runId, recovery.onEvent, init.storageLimits);
      }
      const events = await lstat(join(runDir, 'events.jsonl')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (events && (!events.isFile() || events.isSymbolicLink() || events.size !== 0))
        throw new Error('cannot reconstruct initialization over recorded events');
    }
    // Publish the initial manifest atomically too: a failed creation must remain retryable.
    await atomicTraceFile(join(runDir, 'manifest.json'), `${JSON.stringify(base, null, 2)}\n`);

    const handle = await open(join(runDir, EVENT_LOG_FILE), 'a', FILE_MODE);
    const writer = new TraceWriter(runId, runDir, base, redactor, handle, init.storageLimits);
    const live = await handle.stat();
    writer.#segmentBytes = live.size;
    writer.#sessionTitle = title;
    writer.#titlePriority = title.trim() ? 3 : 0;
    return writer;
  }

  /** Reopen only a caller-owned recovery claim, never discover or rewrite historical runs. */
  static async resume(
    runDir: string,
    expectedRunId: string,
    onEvent?: (event: TraceEvent) => void,
    limits?: StorageLimits,
  ): Promise<TraceWriter> {
    const info = await lstat(runDir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(runDir)) !== runDir ||
      (process.getuid && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      throw new Error('unsafe recovery directory');
    const base: Manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
    assertManifest(base);
    if (base.run_id !== expectedRunId) throw new Error('recovery identity mismatch');

    // Every file of the run, not just `events.jsonl`: a rotated run's later events live in the
    // next segment, and resuming from the first one would append at the wrong seq into the wrong
    // file. Discovery falls back to the directory when the manifest never recorded a segment list.
    const layout = await eventLogLayout(runDir, base);
    if (layout.segments.length === 0) throw new Error('unsafe recovery events');
    for (const [position, segment] of layout.segments.entries()) {
      const segmentInfo = await lstat(segment.path);
      if (!segmentInfo.isFile() || segmentInfo.isSymbolicLink())
        throw new Error('unsafe recovery events');
      if (segmentInfo.size === 0) continue;
      const check = await open(segment.path, 'r');
      try {
        const last = Buffer.alloc(1);
        await check.read(last, 0, 1, segmentInfo.size - 1);
        // A partial line anywhere is corruption to resume over: appending behind it would bury a
        // torn event inside the log instead of leaving it at the end where a reader can see it.
        if (last[0] !== 10) throw new Error('partial recovery event');
      } finally {
        await check.close();
      }
      // Only the last file may be short of events; an empty one before it is a rotation that wrote
      // no event, which is not an event log this writer can continue either.
      if (position < layout.segments.length - 1 && segmentInfo.size === 0)
        throw new Error('empty recovery segment');
    }

    const last = layout.segments.at(-1)!;
    const writer = new TraceWriter(
      expectedRunId,
      runDir,
      base,
      new Redactor({ envAllowlist: [], summarizeHits: true }),
      await open(last.path, 'a', FILE_MODE),
      limits,
      {
        index: last.index,
        name: last.name,
        firstSeq: 0,
        events: 0,
        bytes: (await lstat(last.path)).size,
        closed: [],
      },
    );
    try {
      /** Per-file extent rebuilt from the bytes, not from a manifest that may predate rotation. */
      const extents: { name: string; firstSeq: number; lastSeq: number }[] = [];
      for (const segment of layout.segments) {
        const isLive = segment.name === last.name;
        const firstSeq = writer.#seq;
        for await (const line of createInterface({
          input: createReadStream(segment.path),
          crlfDelay: Infinity,
        })) {
          const event: TraceEvent = JSON.parse(line);
          assertEvent(event);
          if (event.seq !== writer.#seq || writer.#closedEvent)
            throw new Error('invalid recovery sequence');
          if (event.type === 'run.start') {
            if (event.seq !== 0) throw new Error('duplicate recovery start');
            writer.#opened = true;
          }
          if (event.type === 'run.end') writer.#closedEvent = true;
          writer.#seq++;
          writer.#turn = event.turn;
          writer.#monoOffset = Math.max(writer.#monoOffset, event.mono_us);
          onEvent?.(event);
        }
        const events = writer.#seq - firstSeq;
        if (isLive) {
          writer.#segmentFirstSeq = firstSeq;
          writer.#segmentEvents = events;
        } else {
          extents.push({ name: segment.name, firstSeq, lastSeq: writer.#seq - 1 });
        }
      }
      writer.#closedSegments = [];
      for (const extent of extents) {
        writer.#closedSegments.push({
          ...extent,
          bytes: (await lstat(join(runDir, extent.name))).size,
        });
      }
      try {
        writer.#previousRedactions = JSON.parse(
          await readFile(join(runDir, 'redactions.json'), 'utf8'),
        ).records;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Preserve the recovery path; a restarted run must not be renamed under its claim.
      writer.#sessionTitle = 'Codex turn';
      writer.#titlePriority = 3;
      if (
        writer.#closedEvent &&
        base.ended_at &&
        base.integrity?.events_sha256 === (await hashEventLog(layout.segments.map((s) => s.path)))
      ) {
        writer.#sealed = base;
        await writer.#handle.close();
        writer.#handleClosed = true;
      } else {
        writer.markCaptureIncomplete('recorder_restarted');
        for (const issue of base.capture?.issues ?? []) writer.markCaptureIncomplete(issue);
      }
      return writer;
    } catch (error) {
      await writer.#handle.close();
      throw error;
    }
  }

  get hasEnded(): boolean {
    return this.#closedEvent;
  }
  get finalizedManifest(): Manifest | undefined {
    return this.#sealed;
  }

  /** Drain and leave an unfinished run recoverable; shutdown is not host completion. */
  async suspend(): Promise<void> {
    if (this.#sealed || this.#handleClosed) return;
    await this.#tail;
    this.markCaptureIncomplete('recorder_shutdown');
    try {
      await this.#handle.sync();
    } finally {
      await this.#handle.close();
      this.#handleClosed = true;
    }
    await atomicTraceFile(
      join(this.#runDir, 'redactions.json'),
      JSON.stringify({
        policy_version: REDACTION_POLICY_VERSION,
        records: [...this.#previousRedactions, ...this.#redactor.records()],
      }),
    );
    await atomicTraceFile(
      join(this.#runDir, 'manifest.json'),
      JSON.stringify({ ...this.#base, capture: this.#capture }),
    );
  }

  /**
   * Record the repository state the run started from (spec §1).
   *
   * A setter rather than a constructor argument because the honest answer needs the run directory
   * to exist: the dirty check has to exclude agenticreplay's own files, or every run in a clean checkout
   * reports dirty. So the caller reads it once the capture layer is up and hands it back, and it
   * lands in the manifest at close alongside the counts.
   */
  setGit(info: Manifest['git']): void {
    this.#git = info;
  }

  /** Active capture paths stay fixed. After close, this returns the final titled directory. */
  get runDir(): string {
    return this.#runDir;
  }

  get runId(): string {
    return this.#runId;
  }

  /** The seq the next event will be given, which is also the number written so far. */
  get seq(): number {
    return this.#seq;
  }

  /** Capture state is independent of the recorded child's exit status. Failures are sticky. */
  setCaptureSummary(summary: CaptureSummary): void {
    for (const issue of summary.issues) this.#captureIssues.add(issue);
    this.#capture = { ...summary, issues: [...this.#captureIssues] };
  }

  markCaptureIncomplete(reason: string): void {
    this.#captureIssues.add(reason);
    this.#capture = { ...this.#capture, status: 'incomplete', issues: [...this.#captureIssues] };
  }

  async append(init: EventInit): Promise<TraceEvent> {
    if (this.#sealed) throw new Error(`run ${this.#runId} is closed`);
    // SPEC §2.3: `run.start` AND `run.end` BRACKET THE RUN, EXACTLY ONE OF EACH.
    //
    // Nothing enforced that here, and three commands got it wrong in three different ways —
    // `record --mcp-config` put a note at seq 0, `attach` wrote neither event, and a fork opened
    // on `fork`. All three produced traces that look fine to `agenticreplay show`, `agenticreplay replay` and the
    // viewer, and that no gateway will take:
    //
    //   invalid trace: run.start at seq 1, must be seq 0
    //   invalid trace: 0 run.start and 1 run.end events (exactly one of each)
    //
    // The cost of finding out late is the whole recording: the user learns at `agenticreplay push`, after
    // the agent session is over, that there is nothing to push. Refusing the write is the only
    // point where the mistake is still cheap — it fails in the developer's own test run, at the
    // line that wrote the wrong event, rather than in someone else's terminal a week later.
    // Only the three a fragment cannot reach innocently. "seq 0 must BE run.start" would be the
    // stronger rule and is wrong here: this writer is also how fixtures and conformance vectors
    // are built, and a deliberate fragment is allowed to hold a few events and no bracket at all.
    // These three are violations however the trace is meant to be used.
    if (init.type === 'run.start' && this.#seq !== 0) {
      throw new Error(
        `run.start belongs at seq 0 (spec §2.3); run ${this.#runId} tried to write it at seq ` +
          `${this.#seq}, behind ${this.#opened ? 'a run.start that is already there' : 'events that were written first'}. ` +
          'Append it before any capture layer can write.',
      );
    }
    if (init.type === 'run.end' && !this.#opened) {
      throw new Error(
        `run ${this.#runId} has no run.start to close: the spec brackets a run with exactly one ` +
          'of each (spec §2.3), and a gateway refuses the push — "0 run.start and 1 run.end ' +
          'events". Append run.start as the run opens.',
      );
    }
    if (init.type === 'run.end' && this.#closedEvent) {
      throw new Error(`run ${this.#runId} already has a run.end; the spec allows exactly one`);
    }
    // Clocks are read at call time so they describe the event, not the queue drain; seq is
    // assigned inside the queue so a rejected event leaves no hole in the dense order.
    const when = init.occurredAt ?? new Date();
    const ts = when.toISOString();
    // Monotonic for events stamped now; derived from the wall clock for one that happened earlier,
    // since there is no hrtime reading to recover. Clamped at zero rather than going negative for a
    // frame whose clock ran slightly behind the run's start.
    const mono_us = init.occurredAt
      ? Math.max(0, (when.getTime() - this.#startedAtMs) * 1000)
      : this.#monoOffset + Number((process.hrtime.bigint() - this.#started) / 1000n);
    const turn = init.turn ?? this.#turn;
    this.#turn = turn;
    const written = this.#tail.then(() => this.#write(ts, mono_us, turn, init));
    this.#tail = written.catch(() => {
      this.markCaptureIncomplete('event_write_failed');
    });
    return written;
  }

  async close(exitCode?: number): Promise<Manifest> {
    if (this.#sealed) return this.#sealed;
    await this.#tail;
    if (!this.#handleClosed) {
      await this.#handle.sync();
      await this.#handle.close();
      this.#handleClosed = true;
    }

    const blobs = await this.#blobs.count();
    // Every file of the run, described as it now stands. One file keeps the manifest
    // byte-identical to what it always was; a rotation records the order a reader must follow.
    const segments = await this.#sealSegments();
    const eventsSha256 = await hashEventLog(
      segments.map((segment) => join(this.#runDir, segment.name)),
    );
    const rawManifest: Manifest = {
      ...this.#base,
      ended_at: new Date().toISOString(),
      counts: { events: this.#seq, blobs },
      redaction: {
        policy_version: REDACTION_POLICY_VERSION,
        rules_fired: [...this.#previousRedactions, ...this.#redactor.records()].reduce<
          Record<string, number>
        >((counts, record) => {
          counts[record.rule] = (counts[record.rule] ?? 0) + record.count;
          return counts;
        }, {}),
      },
      integrity: {
        events_sha256: eventsSha256,
        blob_count: blobs,
        ...(segments.length > 1 ? { segments } : {}),
      },
      // Conditional for the same reason the fork keys are: the schema forbids unknown keys, and a
      // run outside a repository should carry no git block rather than three empty fields.
      ...(this.#git === undefined || Object.keys(this.#git).length === 0 ? {} : { git: this.#git }),
      ...(this.#capture === undefined
        ? {}
        : {
            capture: {
              ...this.#capture,
              ...(this.#captureIssues.size > 0 ? { status: 'incomplete' as const } : {}),
              issues: [...this.#captureIssues],
            },
          }),
    };
    if (exitCode !== undefined) rawManifest.exit_code = exitCode;
    const manifest = redactManifest(this.#redactor, rawManifest);
    assertManifest(manifest);

    const redactions = {
      policy_version: REDACTION_POLICY_VERSION,
      records: [...this.#previousRedactions, ...this.#redactor.records()],
    };
    await atomicTraceFile(
      join(this.#runDir, 'redactions.json'),
      `${JSON.stringify(redactions, null, 2)}\n`,
    );
    await atomicTraceFile(
      join(this.#runDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const titledDir = join(
      dirname(this.#runDir),
      captureDirectoryName(
        this.#base.created_at,
        this.#base.adapter.id,
        this.#sessionTitle,
        this.#runId,
      ),
    );
    if (titledDir !== this.#runDir) {
      await rename(this.#runDir, titledDir);
      this.#runDir = titledDir;
    }
    this.#sealed = manifest;
    return manifest;
  }

  /** Bytes already closed into earlier files, which the whole-run budget counts too. */
  #closedBytes(): number {
    return this.#closedSegments.reduce((total, segment) => total + segment.bytes, 0);
  }

  /** Whether another file may be opened, ignoring what it would contain. */
  #mayOpenNext(): boolean {
    if (!this.#rotating) return false;
    if (this.#rotationStopped !== undefined) return false;
    if (this.#segmentIndex >= this.#maxSegments) return false;
    return this.#closedBytes() + this.#segmentBytes < this.#runEventBytes;
  }

  /** Why rotation cannot continue, as the issue a trace records when it stops. */
  #exhaustedReason():
    'event_storage_limit' | 'run_event_limit' | 'segment_limit' | 'event_segment_unwritable' {
    if (!this.#rotating) return 'event_storage_limit';
    if (this.#rotationStopped === 'rotation_failed') return 'event_segment_unwritable';
    if (this.#rotationStopped === 'run_event_limit') return 'run_event_limit';
    if (this.#rotationStopped === 'segment_limit' || this.#segmentIndex >= this.#maxSegments)
      return 'segment_limit';
    return 'run_event_limit';
  }

  /**
   * Open the next event file and make it the live one.
   *
   * The failed file is closed first and its size recorded, so what the run already wrote stays
   * readable whatever happens next. Creation is exclusive (`ax`): a file already there is either
   * this writer's abandoned rotation from a crash — which the resume path reuses — or another
   * process's, and neither should be appended to by guessing.
   *
   * Returns false when nothing was opened. This never throws: a recording that cannot continue
   * into a new file still has to be able to write `run.end` into the file it has, and the caller
   * has a diagnostic path for exactly that.
   */
  async #rotate(): Promise<boolean> {
    if (!this.#mayOpenNext()) {
      // Once rotation has stopped, the reason is the record of WHY. Re-deriving it here overwrote
      // `event_segment_conflict` with `segment_limit` on the very next event, so a trace could name
      // a bound nobody reached instead of the disk it could not write to.
      if (this.#rotationStopped !== undefined) return false;
      const reason = this.#exhaustedReason();
      if (reason !== 'event_storage_limit') {
        this.#rotationStopped = reason === 'run_event_limit' ? 'run_event_limit' : 'segment_limit';
        this.markCaptureIncomplete(reason);
      }
      return false;
    }
    const nextIndex = this.#segmentIndex + 1;
    const nextName = eventSegmentFileName(nextIndex);
    const closedName = this.#segmentName;
    const closedFirst = this.#segmentFirstSeq;
    const closedEvents = this.#segmentEvents;
    let next: FileHandle;
    try {
      // O_APPEND follows the truncated EOF after rolling back a partial write.
      next = await open(join(this.#runDir, nextName), 'ax', FILE_MODE);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Another writer, or this run's own abandoned rotation. Reusing it is only safe when it is
        // empty; a file with bytes in it means two recorders are interleaving one run.
        const info = await lstat(join(this.#runDir, nextName)).catch(() => undefined);
        if (info?.isFile() && info.size === 0) {
          next = await open(join(this.#runDir, nextName), 'a', FILE_MODE);
        } else {
          this.#rotationStopped = 'rotation_failed';
          this.markCaptureIncomplete('event_segment_conflict');
          return false;
        }
      } else {
        // A full disk, a read-only mount, a permission the recorder does not have, or a directory
        // that cannot be written at all: none of them improve by being asked again per event, and
        // the run that already recorded something must stay usable.
        this.#rotationStopped = 'rotation_failed';
        this.markCaptureIncomplete(`event_segment_unwritable:${code ?? 'unknown'}`);
        return false;
      }
    }
    // Close the finished file before the new one becomes live: the handle is the writer's notion
    // of "where events go", and two of them at once would let a queued write land in the wrong one.
    const closedBytes = (await this.#handle.stat()).size;
    try {
      // A failed flush is not a reason to keep the old file open; the bytes are in the page cache
      // and the file stays readable either way.
      await this.#handle.sync().catch(() => undefined);
      await this.#handle.close();
    } catch (error) {
      // The new handle would be unreachable from here, and a leaked descriptor per failed rotation
      // is a slow exhaustion of the process. Drop it and stop rotating: the old handle may or may
      // not still be open, so the next append finds out and says so, which beats guessing here.
      await next.close().catch(() => undefined);
      this.#rotationStopped = 'rotation_failed';
      this.markCaptureIncomplete('event_segment_unwritable');
      throw error;
    }
    if (closedEvents > 0) {
      this.#closedSegments.push({
        name: closedName,
        firstSeq: closedFirst,
        lastSeq: closedFirst + closedEvents - 1,
        bytes: closedBytes,
      });
    }
    this.#handle = next;
    this.#segmentIndex = nextIndex;
    this.#segmentName = nextName;
    this.#segmentFirstSeq = this.#seq;
    this.#segmentEvents = 0;
    this.#segmentBytes = 0;
    return true;
  }

  /**
   * Every file of the run with its identity, for the manifest.
   *
   * The live file is included as it stands. A run that never rotated returns exactly one entry and
   * the caller leaves it out of the manifest: one file is the format that already existed, and a
   * reader that predates rotation must keep opening those runs unchanged.
   */
  async #sealSegments(): Promise<TraceSegment[]> {
    const live = {
      name: this.#segmentName,
      firstSeq: this.#segmentFirstSeq,
      lastSeq: this.#seq - 1,
      bytes: (await lstat(this.eventsPath)).size,
    };
    const all = [...this.#closedSegments, live];
    const out: TraceSegment[] = [];
    for (const segment of all) {
      // An empty file is not evidence, and recording it would claim a range no event occupies.
      if (segment.lastSeq < segment.firstSeq) continue;
      out.push({
        name: segment.name,
        first_seq: segment.firstSeq,
        last_seq: segment.lastSeq,
        bytes: segment.bytes,
        sha256: await sha256File(join(this.#runDir, segment.name)),
      });
    }
    return out;
  }

  async #write(ts: string, mono_us: number, turn: number, init: EventInit): Promise<TraceEvent> {
    const seq = this.#seq;
    const removed: string[] = [];
    const transformations: CaptureTransformation[] = [...(init.transformations ?? [])];
    let before = (await this.#handle.stat()).size;
    let omission: string | undefined;
    let payload = init.payload;
    // Omit early only when nothing can take the payload: a full file is not a reason on its own,
    // because the event may simply belong to the next file. Spilling a body to a blob and then
    // discarding the reference is the waste this check exists to avoid. A run that has decided it
    // cannot record further is the case where the file really is all there is.
    const stuck = this.#rotationStopped !== undefined || !this.#rotating;
    if (before >= this.#eventBytes && stuck) {
      // A run that stopped rotating keeps its diagnostic space: the payload goes, the event stays,
      // and the issue saying why is written once by whatever stopped it — not once per event here.
      omission = this.#exhaustedReason();
      payload = undefined;
    }
    let blob: ReturnType<BlobStore['prepare']> | undefined;
    let bodyEvidence: { body_bytes: number; body_sha256: string } | undefined;
    if (payload !== undefined) {
      const json = JSON.stringify(payload);
      const scrubbed = this.#redactor.redactString(json, `event:${seq}:payload`);
      removed.push(...scrubbed.hits.map((h) => h.identifier));
      transformations.push(
        ...scrubbed.hits.map((h) => ({
          kind: 'redaction' as const,
          location: 'payload',
          rule: h.rule,
          count: h.count,
          reason: 'secret redaction policy',
        })),
      );
      if (
        (init.type === 'net.request' || init.type === 'net.response') &&
        typeof payload === 'string'
      ) {
        const body = scrubbed.value === json ? payload : (JSON.parse(scrubbed.value) as string);
        bodyEvidence = {
          body_bytes: Buffer.byteLength(body),
          body_sha256: createHash('sha256').update(body).digest('hex'),
        };
        transformations.push({
          kind: 'encoding',
          location: 'storage',
          rule: 'json_string',
          count: 1,
          reason:
            'UTF-8 body stored as a JSON string; decode the JSON wrapper to download body bytes',
        });
      }
      if (Buffer.byteLength(scrubbed.value) > INLINE_PAYLOAD_LIMIT) {
        blob = this.#blobs.prepare(
          scrubbed.value,
          'application/json',
          init.type === 'model.request' || init.type === 'net.request',
        );
        payload = blob.ref;
      } else payload = JSON.parse(scrubbed.value) as Payload;
    }

    const event: TraceEvent = { seq, ts, mono_us, turn, type: init.type, actor: init.actor };
    if (init.causes !== undefined) event.causes = init.causes;
    if (init.attrs !== undefined) event.attrs = { ...init.attrs };
    if (init.type === 'run.start' && this.#titlePriority === 3) {
      event.attrs = { ...event.attrs, session_title: this.#sessionTitle };
    }
    if (event.type === 'net.request' || event.type === 'net.response') {
      for (const key of ['url', 'path', 'upstream', 'destination']) {
        const value = event.attrs?.[key];
        if (typeof value !== 'string') continue;
        const scrubbed = scrubTransportUrl(value);
        if (scrubbed.count === 0) continue;
        event.attrs![key] = scrubbed.value;
        transformations.push({
          kind: 'url_scrubbed',
          location: `attrs.${key}`,
          rule: 'url_credentials',
          count: scrubbed.count,
          reason: 'URL userinfo and sensitive query values excluded',
        });
      }
    }
    const operationalPaths: Record<string, string> = {};
    for (const key of init.operationalPathAttrs ?? []) {
      const value = event.attrs?.[key];
      if (typeof value !== 'string' || !isAbsolute(value)) continue;
      const path = this.#redactor.redactString(value, `event:${seq}:attrs.${key}`, {
        entropy: false,
      });
      operationalPaths[key] = path.value;
      delete event.attrs![key];
      removed.push(...path.hits.map((h) => h.identifier));
      transformations.push(
        ...path.hits.map((h) => ({
          kind: 'redaction' as const,
          location: `attrs.${key}`,
          rule: h.rule,
          count: h.count,
          reason: 'secret redaction policy for operational paths',
        })),
      );
    }

    // Placeholders contain no quote or backslash, so scrubbing the serialized line cannot make it
    // unparseable — and if it ever did, the parse throws and the event is never written.
    const scrubbed = this.#redactor.redactString(JSON.stringify(event), `event:${seq}`);
    removed.push(...scrubbed.hits.map((h) => h.identifier));
    transformations.push(
      ...scrubbed.hits.map((h) => ({
        kind: 'redaction' as const,
        location: 'envelope',
        rule: h.rule,
        count: h.count,
        reason: 'secret redaction policy',
      })),
    );
    let out = JSON.parse(scrubbed.value) as TraceEvent;
    const toolEvent = out.type === 'tool.call' || out.type === 'tool.result';
    if (
      toolEvent &&
      out.attrs &&
      'tool_use_id' in out.attrs &&
      !isToolUseId(out.attrs.tool_use_id)
    ) {
      delete out.attrs.tool_use_id;
      this.markCaptureIncomplete('invalid_tool_use_id');
    }
    const unresolved = unresolvedDiagnostic(out);
    if (unresolved) out.attrs = unresolved;
    if (Object.keys(operationalPaths).length) out.attrs = { ...out.attrs, ...operationalPaths };
    // The complete payload was already scanned above. Scanning it again as part of the envelope
    // doubles work and can apply a different policy to inline and spilled bodies.
    if (payload !== undefined) out.payload = payload;
    if (bodyEvidence) out.attrs = { ...out.attrs, ...bodyEvidence };
    if (removed.length > 0) out.redacted = [...new Set(removed)];
    if (transformations.length > 0) {
      // A caller may supply transport annotations; scrub those too before persistence.
      out.transformations = JSON.parse(
        this.#redactor.redactString(
          JSON.stringify(coalesceRedactionTransformations(transformations)),
          `event:${seq}:transformations`,
        ).value,
      ) as CaptureTransformation[];
    }

    const fitEvent = (): string => {
      // A write that does not fit is not a storage failure when the run can continue in the next
      // file: the omission is this event's only, and the run's own budget is what decides whether
      // the event exists at all. Recording an issue here is what made a healthy rotated run report
      // `event_storage_limit` for the single event that straddled a boundary.
      let omitted = omission;
      if (omitted) out.attrs = { ...out.attrs, payload_omitted: omitted };
      let line = `${JSON.stringify(out)}\n`;
      const closed = this.#closedBytes();
      const endsInFile = before + Buffer.byteLength(line) <= this.#eventBytes;
      // The run budget only applies to a run that can continue into another file. For a caller
      // that asked for one bounded file, `eventBytes` is the whole bound and adding a second one
      // the caller never mentioned would reject writes it used to accept.
      const endsInRun =
        !this.#rotating || closed + before + Buffer.byteLength(line) <= this.#runEventBytes;
      if (!endsInFile || !endsInRun) {
        blob = undefined;
        // Which budget ran out decides the issue, and whether it is an issue at all. An event that
        // overflows one file the run is about to leave is recorded whole in the next one, and
        // nothing is wrong. An event the whole run has no room for is a real loss, and so is one
        // that cannot move because rotation stopped.
        const exhausted = !endsInRun
          ? this.#rotating
            ? 'run_event_limit'
            : 'event_storage_limit'
          : this.#rotating && this.#rotationStopped === undefined
            ? undefined
            : this.#exhaustedReason();
        omitted ??= exhausted ?? 'event_storage_limit';
        if (exhausted !== undefined) this.markCaptureIncomplete(exhausted);
        // Keep a bounded diagnostic, never the unbounded payload/attrs that filled the store.
        const attrs: Record<string, unknown> = { payload_omitted: omitted };
        if (toolEvent) {
          if (isToolUseId(out.attrs?.tool_use_id)) attrs.tool_use_id = out.attrs.tool_use_id;
          if (out.attrs?.correlation === 'ambiguous') attrs.correlation = 'ambiguous';
        } else if (!unresolved) {
          for (const key of ['reason', 'message', 'error', 'exit_code', 'status']) {
            const value = out.attrs?.[key];
            if (typeof value === 'string') attrs[key] = value.slice(0, 96);
            else if (typeof value === 'number' || typeof value === 'boolean') attrs[key] = value;
          }
        }
        out = {
          seq,
          ts,
          mono_us,
          turn,
          type: init.type,
          actor: init.actor,
          attrs: unresolved ?? attrs,
          ...(toolEvent && out.causes ? { causes: out.causes } : {}),
        };
        line = `${JSON.stringify(out)}\n`;
        const allowance =
          init.type === 'run.end'
            ? DIAGNOSTIC_BYTES
            : init.type === 'error' || unresolved
              ? DIAGNOSTIC_BYTES - END_BYTES
              : END_BYTES;
        // The bounded record has to fit whatever bounded the write: the file, the run, or both.
        // Checking both is what keeps `run.end` writable at a run-level cap whose reservation was
        // never spent, rather than throwing because a file cap it does not count against is full.
        const tooBig =
          before + Buffer.byteLength(line) > this.#eventBytes + allowance ||
          (this.#rotating &&
            closed + before + Buffer.byteLength(line) > this.#runEventBytes + allowance);
        if (tooBig) {
          this.markCaptureIncomplete('diagnostic_storage_limit');
          throw new DiagnosticStorageLimitError();
        }
      }
      assertEvent(out);
      return line;
    };
    // Rotate before writing, never after: the event belongs to the next file, and a file boundary
    // has to fall between two lines rather than inside one. Decided on the event's FULL size, before
    // any omission rule runs: a full file is a reason to continue in the next one, not a reason to
    // throw away a payload the rest of the run has room for. `before > 0` is what keeps an event
    // larger than a whole file from being followed by an endless run of empty ones — the omission
    // path below then writes its bounded record into the file that was just opened.
    const plannedBytes = Buffer.byteLength(`${JSON.stringify(out)}\n`);
    if (before > 0 && before + plannedBytes > this.#eventBytes && (await this.#rotate())) {
      before = 0;
    }
    const writeLine = async (line: string): Promise<void> => {
      try {
        await this.#handle.writeFile(line);
      } catch (error) {
        // Truncate to this file's offset: the failed write must not leave half a line for the
        // next event to be appended behind.
        await this.#handle.truncate(before);
        throw error;
      }
      // Tracked from the bytes written rather than stat'ed again: the next event's decision needs
      // this file's size, and one syscall per event is the difference between a recorder that keeps
      // up with a stream and one that does not.
      this.#segmentBytes = before + Buffer.byteLength(line);
    };
    const line = fitEvent();
    if (blob) {
      try {
        await blob.publish(() => writeLine(line));
      } catch (error) {
        if (!(error instanceof BlobLimitError)) throw error;
        omission = 'blob_storage_limit';
        this.markCaptureIncomplete(omission);
        delete out.payload;
        await writeLine(fitEvent());
      }
    } else {
      await writeLine(line);
    }
    this.#segmentEvents += 1;
    if (init.type === 'run.start' || init.type === 'session.snapshot') {
      const title = init.attrs?.session_title ?? init.attrs?.title;
      if (typeof title === 'string' && title.trim() && this.#titlePriority < 2) {
        this.#sessionTitle = this.#redactor.redactString(
          title.normalize('NFKC'),
          'session.title',
        ).value;
        this.#titlePriority = 2;
      }
    }
    if (
      this.#titlePriority === 0 &&
      ['model.request', 'net.request', 'session.snapshot'].includes(init.type)
    ) {
      const prompt = firstUserPrompt(init.payload);
      if (prompt) {
        this.#sessionTitle = this.#redactor.redactString(
          prompt.normalize('NFKC'),
          'session.title',
        ).value;
        this.#titlePriority = 1;
      }
    }
    // Set after the write, not before it: a bracket that failed to reach disk is not one.
    if (out.type === 'run.start') this.#opened = true;
    if (out.type === 'run.end') this.#closedEvent = true;
    this.#seq = seq + 1;
    return out;
  }
}

/** Atomic, durable publication allows a failed close to be retried without a torn manifest. */
async function atomicTraceFile(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', FILE_MODE);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
