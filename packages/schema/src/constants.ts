/**
 * Runtime constants mirroring the normative JSON Schema in `schema/`.
 *
 * The TypeScript types in `types.ts` are derived from these arrays, and
 * `test/schema-parity.test.ts` proves the arrays equal the schema enums. That gives the
 * same drift protection as codegen without a build step that can silently break.
 */

export const SCHEMA_VERSION = '0.4.0';

export const EVENT_TYPES = [
  'run.start',
  'run.end',
  'model.request',
  'model.response',
  'model.thinking',
  'tool.call',
  'tool.result',
  'mcp.request',
  'mcp.response',
  'shell.exec',
  'shell.result',
  'fs.snapshot',
  'fs.change',
  'net.request',
  'net.response',
  'retrieval.context',
  'error',
  'divergence',
  'checkpoint',
  'fork',
  'agent.start',
  'agent.handoff',
  'agent.guardrail',
  'graph.node.start',
  'graph.node.end',
  'route.decision',
  'session.snapshot',
  'note',
] as const;

export const ACTORS = [
  'agent',
  'harness',
  'model',
  'agenticreplay',
  'gateway',
  'tool',
  'user',
] as const;

export const DIVERGENCE_LEVELS = ['minor', 'major'] as const;

/** Match rungs from spec §4. Rung 1 is an exact canonical-hash match. */
export const MATCH_RUNGS = [1, 2, 3, 4] as const;

/** Payloads larger than this (serialized bytes) MUST spill to a blob. Spec §2.2. */
export const INLINE_PAYLOAD_LIMIT = 4096;

/**
 * The instants a `date-time` `ts` can write down: `0000-01-01T00:00:00.000Z` and
 * `9999-12-31T23:59:59.999Z`.
 *
 * `Date.parse` accepts far more than this — `+275760-09-13T00:00:00Z` parses, and
 * `toISOString` writes it back with a six-digit year, which the format rejects. Every reader that
 * hands the drain an instant off a file another process wrote has to bound it, because the throw
 * lands inside `TraceWriter.append`, where the trace is being sealed. Three of them do; this is
 * the copy they share, since what the bound describes is this schema rather than any one of them.
 */
export const EARLIEST_TS_MS = -62_167_219_200_000;
export const LATEST_TS_MS = 253_402_300_799_999;

export const RUN_ID_PATTERN = /^run_[0-9a-f]{6,32}$/;
export const BLOB_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The files one run's event log is split across, in `seq` order. Spec §1 and §2.
 *
 * The first file keeps the historical name so a run that never rotates is byte-for-byte what it
 * always was; every later file carries its 1-based index, zero-padded so a directory listing sorts
 * the same way a reader walks it. Index 1 is spelled `events.jsonl` and never
 * `events.000001.jsonl`: two spellings of the same position would make discovery depend on which
 * one a writer happened to pick.
 */
export const EVENT_LOG_FILE = 'events.jsonl';
const EVENT_SEGMENT_NAME = /^events(?:\.([0-9]{6}))?\.jsonl$/;

/** The file name for segment `index`, which is 1-based. */
export function eventSegmentFileName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('invalid event segment index');
  return index === 1 ? EVENT_LOG_FILE : `events.${String(index).padStart(6, '0')}.jsonl`;
}

/** The 1-based segment index a file name denotes, or undefined for any other name. */
export function eventSegmentIndex(name: string): number | undefined {
  const match = EVENT_SEGMENT_NAME.exec(name);
  if (!match) return undefined;
  const index = match[1] === undefined ? 1 : Number(match[1]);
  // `events.000001.jsonl` would be a second name for the first position.
  if (index < 1 || (match[1] !== undefined && index === 1)) return undefined;
  return index;
}

export function isEventSegmentName(name: string): boolean {
  return eventSegmentIndex(name) !== undefined;
}
