import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { rewriteMcpConfig } from '@agenticreplay/adapters';
import { EARLIEST_TS_MS, LATEST_TS_MS } from '@agenticreplay/schema';
import { isMcpFrameRecord, objectsOnLine, MCP_RECORD_START } from '@agenticreplay/mcp-shim';
import type { McpFrameRecord } from '@agenticreplay/mcp-shim';
import type { TraceWriter } from '@agenticreplay/core';
import type { Output } from './out.js';

export interface McpCapture {
  /** Path to the rewritten config the agent should be pointed at. */
  configPath: string;
  rewritten: string[];
  skipped: string[];
  /** Frames observed so far, drained by the recorder. */
  drain(): Promise<McpFrameRecord[]>;
}

/**
 * A captured frame, as the shim writes it.
 *
 * Re-exported rather than redeclared. The version that used to live here named two of the same
 * fields differently — `server` for `name`, `direction` for `dir` — and since `JSON.parse` casts to
 * whatever the call site claims, nothing anywhere disagreed: every MCP event went into the trace
 * with an undefined server, and `direction === 'in'` was false for all of them, so every request
 * was recorded as a response. A format has one owner, and it is the thing that writes it.
 */
export type { McpFrameRecord };

/**
 * Point the launched agent at the instrumented config.
 *
 * Every target harness reads one of these; setting all three costs nothing and avoids making the
 * user work out which one their agent uses.
 */
export function pointAtMcpConfig(env: Record<string, string>, configPath: string): void {
  env.MCP_CONFIG_PATH = configPath;
  env.CLAUDE_MCP_CONFIG = configPath;
  env.OPENCODE_MCP_CONFIG = configPath;
}

/**
 * Drain captured frames into a trace as `mcp.request` / `mcp.response`.
 *
 * Frames are read off disk after the agent exits, so each carries the moment it passed through the
 * shim and is stamped with that rather than with the drain — `mono_us` is authoritative for
 * duration (spec §2.1), and a frame stamped at the drain can never interleave with the model turns
 * it actually sat between.
 */

/**
 * Whether a parsed capture line is something the drain can safely turn into an event.
 *
 * Several shims share one capture file — `createWriteStream(out, { flags: 'a' })`, whose own
 * comment says "several servers in one run may share a capture file" — so this file is exposed to
 * the same interleaved write as the shell frames, and the same two failures follow from it:
 *
 *   - a line that parses to `null` reaches `frame.ts` and throws `TypeError`
 *   - a `ts` that parses to an instant outside the range a `date-time` can express becomes a `Date`
 *     that `TraceWriter.append` cannot format, and `toISOString()` or `assertEvent` throws
 *
 * Both happen after the agent has exited, where the trace is being sealed. Being the right *type*
 * is not enough for `ts`; the instant has to exist.
 */
function usableFrame(value: unknown): value is McpFrameRecord {
  // The shape check belongs to the package that owns the format, so the two readers of this file
  // cannot drift apart — they already had, and the one without it died on a `null` line.
  if (!isMcpFrameRecord(value)) return false;
  const ts = (value as { ts?: unknown }).ts;
  if (ts === undefined) return true;
  if (typeof ts !== 'string') return false;
  const at = Date.parse(ts);
  // An unparseable `ts` is fine: the drain already falls back to the run's own turn for it.
  return Number.isNaN(at) || (at >= EARLIEST_TS_MS && at <= LATEST_TS_MS);
}

export async function drainMcpFrames(
  mcp: McpCapture,
  writer: TraceWriter,
  turnAt: (at: number) => number,
  fallbackTurn: number,
): Promise<void> {
  for (const frame of await mcp.drain()) {
    // Belt and braces with the filter in `drain`. This function is exported and reached from three
    // call sites, and what it is handed comes off a file several processes append to.
    if (!usableFrame(frame)) continue;
    const at = frame.ts === undefined ? Number.NaN : Date.parse(frame.ts);
    const when = Number.isNaN(at) ? undefined : new Date(at);
    await writer.append({
      type: frame.dir === 'in' ? 'mcp.request' : 'mcp.response',
      actor: 'agent',
      turn: when === undefined ? fallbackTurn : turnAt(at),
      ...(when === undefined ? {} : { occurredAt: when }),
      attrs: { server: frame.name, kind: frame.kind, method: frame.method, id: frame.id },
      payload: frame.raw as never,
    });
  }
}

/**
 * Set up MCP capture for a run.
 *
 * The mechanism is a config rewrite, not a patch: each stdio server is relaunched through
 * `agenticreplay-mcp-shim`, a transparent JSON-RPC tee. The agent's own config file is never touched — a
 * rewritten copy goes in the run directory, and the agent is pointed at that.
 *
 * HTTP and SSE servers are deliberately left alone and reported as skipped; they route through the
 * HTTP proxy instead, and silently dropping them would be worse than not capturing them.
 */
export async function setupMcpCapture(opts: {
  sourceConfigPath: string;
  runDir: string;
  out: Output;
}): Promise<McpCapture | undefined> {
  const raw = await readFile(opts.sourceConfigPath, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    opts.out.warn('mcp.config_unreadable', { path: opts.sourceConfigPath });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    opts.out.warn('mcp.config_unparseable', { path: opts.sourceConfigPath, error: String(err) });
    return undefined;
  }

  const framesPath = join(opts.runDir, 'mcp-frames.jsonl');
  const shim = resolveShimEntry();
  const shimArgs = [shim, '--out', framesPath];
  const { config, rewritten, skipped } = rewriteMcpConfig(parsed, process.execPath, shimArgs);

  const configPath = join(opts.runDir, 'mcp-config.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  opts.out.info('mcp.instrumented', {
    servers: rewritten.length,
    skipped: skipped.length,
    mode: 'record',
    config: configPath,
  });

  return {
    configPath,
    rewritten,
    skipped,
    async drain() {
      const text = await readFile(framesPath, 'utf8').catch(() => '');
      const records: McpFrameRecord[] = [];
      // A malformed capture line must never break the recorder; the agent's run matters more, and
      // a line that a short write left holding a fragment and a record must still yield the record.
      for (const parsed of text
        .split('\n')
        .flatMap((line) => objectsOnLine(line, MCP_RECORD_START))) {
        if (usableFrame(parsed)) records.push(parsed);
      }
      return records;
    },
  };
}

/**
 * Locate the installed shim entry point, whether running from source or from a published dist.
 *
 * This used to ask for `@agenticreplay/mcp-shim/dist/cli.js` and fall back to `@agenticreplay/mcp-shim`
 * when that threw. It always threw — the package declares an `exports` map, and an exports map
 * blocks every subpath it does not list — so the fallback ran every time and resolved to
 * `dist/index.js`, which is the library.
 *
 * The consequence was not a missing capture layer. Every stdio MCP server in the agent's config was
 * rewritten to launch that module, which exports and exits: the real server was never started at
 * all, so `--mcp-config` silently broke the agent's MCP servers *and* recorded nothing, while
 * `agenticreplay doctor` reported the shim runnable because the wrong process exited 0.
 *
 * So: one declared subpath, and no fallback that can succeed with the wrong file. A resolution
 * failure has to stay a failure — `setupMcpCapture` reports it, and the run continues without MCP
 * capture, which is the honest outcome.
 */
function resolveShimEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@agenticreplay/mcp-shim/cli');
}

/**
 * Exposed for the doctor command: is the shim runnable at all?
 *
 * It checks that the thing it launched *is the shim*, not merely that a process started and
 * stopped. Asking only for a clean exit is what let doctor vouch for a resolution that had landed
 * on the library: that module exits 0 having done nothing, which is indistinguishable from success
 * unless you look at what it said.
 */
export async function shimIsRunnable(): Promise<boolean> {
  let entry: string;
  try {
    entry = resolveShimEntry();
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, '--help'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => resolve(false));
    // `--help` is not a flag the shim takes, so it prints its usage and exits non-zero. That usage
    // line is the identification: any other program is not this one.
    child.on('close', () => resolve(stderr.includes('agenticreplay-mcp-shim --name')));
  });
}
