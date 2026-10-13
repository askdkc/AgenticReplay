#!/usr/bin/env node
import { createWriteStream, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JsonRpcFrame } from './framing.js';
import { runShim } from './shim.js';
import type { FrameDirection } from './shim.js';

export interface ShimCliArgs {
  name: string;
  out?: string;
  command: string;
  args: string[];
}

export interface ShimCliIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export const USAGE =
  'usage: agenticreplay-mcp-shim --name <server-name> [--out <file.jsonl>] -- <command> [args...]';

function fail(problem: string): never {
  throw new Error(`${problem}\n${USAGE}`);
}

/**
 * Everything after `--` belongs to the MCP server, untouched — servers take `--name` and `--out`
 * of their own, and swallowing them here would silently change how the server runs.
 */
export function parseArgs(argv: string[]): ShimCliArgs {
  let name: string | undefined;
  let out: string | undefined;
  let i = 0;

  for (; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (arg === '--name' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value === '--') fail(`${arg} needs a value`);
      if (arg === '--name') name = value;
      else if (arg === '--out') out = value;
      i += 1;
      continue;
    }
    fail(`unexpected argument '${arg}'`);
  }

  if (name === undefined) fail('--name is required: it labels this server in the trace');
  if (argv[i] !== '--') fail("missing '--' separator before the MCP server command");
  const command = argv[i + 1];
  if (command === undefined) fail("no command after '--': give the MCP server to launch");

  return { name, out, command, args: argv.slice(i + 2) };
}

/**
 * One line of the capture file, as written.
 *
 * Exported because the recorder reads these back, and it used to do so through a type of its own
 * that named the same fields differently — `server` for `name`, `direction` for `dir`. Nothing
 * caught it: JSON.parse casts to whatever you claim, so every frame arrived with an undefined
 * server, and `direction === 'in'` was false for all of them, which recorded every request as a
 * response. The writer owns the format; the reader imports it.
 */
export interface McpFrameRecord {
  /** RFC3339, stamped when the frame passed through the shim — not when it was read back. */
  ts: string;
  /** The server's name in the agent's own config. */
  name: string;
  dir: FrameDirection;
  kind: string;
  raw: string;
  id?: string | number;
  method?: string;
}

/**
 * Whether a parsed capture line is a frame, rather than merely valid JSON.
 *
 * One predicate for the format, used by both readers of this file. Several shims share one capture
 * — see the `--out` comment below — so an interleaved write can leave a line that parses to `null`,
 * to a number, or to an object with none of these fields, and *every* reader has to survive it. The
 * two that dereference `name` are one file apart and both used to cast straight through.
 *
 * `name` and `raw` only: those are what the readers touch before they know anything else. The rest
 * is checked where it is used, because what is unsafe differs between them — the recorder builds an
 * instant out of `ts`, and this file does not.
 */
export function isMcpFrameRecord(value: unknown): value is McpFrameRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<McpFrameRecord>;
  return typeof record.name === 'string' && typeof record.raw === 'string';
}

/**
 * Where every MCP record on a line begins: both writers below put `ts` first, and `cli.test.ts`
 * pins that against what they actually write. The bytes cannot occur inside a value, which is the
 * property {@link objectsOnLine} needs of whatever it is given.
 */
export const MCP_RECORD_START = '{"ts":';

/**
 * Where the object starting at `from` ends, or -1 if it does not end on this line.
 *
 * Braces only: a `}` can appear in three places, and two of them are handled by counting. Inside a
 * string it is text, which is what the quote and escape tracking is for; inside a nested object it
 * is that object's, which is what the depth is for; the third is the one being looked for. Brackets
 * need no counting of their own, because a `}` inside an array belongs to an object opened in it.
 *
 * Only sound when `from` is outside any string, which is what anchoring the search on an opening
 * that cannot occur inside one buys. Started anywhere else, a fragment that stops mid-string leaves
 * every quote after it on the wrong side, and the walk confidently returns a boundary that is not
 * one — which is why what it returns is never taken on trust.
 */
function endOfObject(line: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = from; at < line.length; at += 1) {
    const ch = line[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return at + 1;
  }
  return -1;
}

/**
 * The records on one line, which is nearly always one.
 *
 * A record is written with a single write, and that is not a single `write` syscall: a short
 * write — a full disk, a quota, a process killed inside it — leaves part of one on disk with no
 * newline behind it, and the next writer's bytes land straight on the end. Skipping such a line
 * whole threw away whatever on it was *complete*, so work recorded in full went missing because a
 * different writer was interrupted. Losing the torn one is unavoidable; losing its neighbour is not.
 *
 * **The whole line first, then anchored, then verified.**
 *
 * A line that parses is one record and needs none of what follows: that is every line of every
 * ordinary capture, and it is also the only thing that reads a record whose fields are not in the
 * order this file expects. The rest is recovery, and recovery is where the care goes.
 *
 * Verified, because that is where the correctness is. The walk balances braces; only
 * `JSON.parse` knows a record from a balanced run of bytes, and a piece that does not parse moves
 * the search to the *next candidate*, never past the piece. Advancing past a boundary the walk was
 * confident about and wrong about is how a complete record was skipped without being read: a
 * fragment that stops inside a string leaves every quote after it on the wrong side, and the walk
 * then reports a boundary beyond the neighbour. Measured on one ordinary frame, that lost the
 * neighbour for 122 of its 166 possible cut points.
 *
 * Anchored, because the candidates have to come from somewhere and the opening is the one place on
 * a line that is certainly outside a string — JSON escapes the quotes in a value, so the sequence
 * cannot occur within one. Searching every `{` would also work, since the parse is what decides,
 * but it tries far more candidates and can hand back an object that was nested inside the fragment.
 *
 * A fragment on its own yields nothing, which is the partial final line this has always tolerated —
 * recovery must not invent a record out of a prefix.
 *
 * `opening` is the caller's, because the CLI reads two of these files with different first keys —
 * `{"ts":` for MCP frames, `{"kind":` for agent spans — and a third copy of this reasoning is how
 * the readers of an append-only file drift apart. It lives here rather than in the CLI because the
 * shim must read its own captures and carries no dependency that could pull a runtime into the
 * agent's process; the shell shim keeps an identical private copy for the same reason.
 */
export function objectsOnLine(line: string, opening: string): Record<string, unknown>[] {
  // The ordinary line is one whole record, whatever key it happens to begin with — one written
  // by a version that ordered its fields differently, or one that simply has no such field, is
  // still a record and is still on a line of its own. Only a line that does not parse needs the
  // rest of this, and that is a line a short write left holding more than it should.
  try {
    const whole: unknown = JSON.parse(line);
    return whole !== null && typeof whole === 'object' && !Array.isArray(whole)
      ? [whole as Record<string, unknown>]
      : [];
  } catch {
    // Not one record: a fragment, or a fragment with something whole stuck to it.
  }
  const found: Record<string, unknown>[] = [];
  let at = line.indexOf(opening);
  while (at !== -1) {
    const end = endOfObject(line, at);
    let next = at + 1;
    if (end !== -1) {
      try {
        // A slice that starts at `{` and ends at the `}` that closed it parses to an object or
        // not at all, which is what lets the callers below take the type on trust.
        found.push(JSON.parse(line.slice(at, end)) as Record<string, unknown>);
        next = end;
      } catch {
        // Balanced, and not a record. The opening after it may still start one.
      }
    }
    at = line.indexOf(opening, next);
  }
  return found;
}

function toRecord(name: string, dir: FrameDirection, frame: JsonRpcFrame): string {
  const record: McpFrameRecord = {
    ts: new Date().toISOString(),
    name,
    dir,
    kind: frame.kind,
    raw: frame.raw,
  };
  if (frame.id !== undefined) record.id = frame.id;
  if (frame.method !== undefined) record.method = frame.method;
  return `${JSON.stringify(record)}\n`;
}

export async function main(argv: string[], io: ShimCliIo = {}): Promise<number> {
  const parsed = parseArgs(argv);

  // Append: several servers in one run may share a capture file, and a rerun must not erase it.
  const sink = parsed.out ? createWriteStream(parsed.out, { flags: 'a' }) : undefined;
  if (sink) {
    // The server keeps running whatever happens to the capture — but an empty trace with no
    // explanation is its own debugging problem, so say it once on stderr.
    sink.once('error', (err: Error) => {
      (io.stderr ?? process.stderr).write(
        `agenticreplay-mcp-shim: capture to ${parsed.out} disabled: ${err.message}\n`,
      );
    });
    sink.on('error', () => {});
  }

  try {
    return await runShim({
      name: parsed.name,
      command: parsed.command,
      args: parsed.args,
      ...(sink
        ? { onFrame: (dir, frame) => void sink.write(toRecord(parsed.name, dir, frame)) }
        : {}),
      ...io,
    });
  } finally {
    if (sink) {
      await new Promise<void>((resolve) => {
        sink.once('close', () => resolve());
        sink.end(() => resolve());
      });
    }
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // realpath both sides: npm installs the bin as a symlink, and argv[1] is the link path.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Nothing is left to read; let the loop drain the last writes and exit on its own.
      process.stdin.pause();
    },
    (err: Error) => {
      process.stderr.write(`agenticreplay-mcp-shim: ${err.message}\n`);
      process.exitCode = 1;
      process.stdin.pause();
    },
  );
}
