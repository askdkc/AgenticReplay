import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { TraceWriter, ensureRunsDir } from '@agenticreplay/core';
import { FsCapture } from '@agenticreplay/fs-capture';
import {
  createProxy,
  unusableOrigin,
  recordableOrigin,
  RunCa,
  type NetExchange,
  type NetRequest,
  type RecordedExchange,
} from '@agenticreplay/proxy';
import {
  captureSession,
  defaultAdapters,
  resolveLaunch,
  snapshotDir,
} from '@agenticreplay/adapters';
import type { Adapter, RecordContext } from '@agenticreplay/plugin-api';
import { ExchangeEventDeriver, appendDerivedEvents } from '../exchange-events.js';
import { discardShellFrames, installShellShim, readShellFrames } from '@agenticreplay/shell-shim';
import {
  eventForSpan,
  discardAgentSpanTransport,
  installAgentSpans,
  sweepStaleTransports,
  touchTransports,
  pythonPathWith,
  agentSpanLosses,
  readAgentSpans,
  PYTHON_ADAPTERS,
  SPANS_ENV,
  type AgentSpanCapture,
} from '../agent-spans.js';
import { drainMcpFrames, pointAtMcpConfig, setupMcpCapture, type McpCapture } from '../mcp.js';
import { SerialQueue } from '../serial.js';
import { appendSnapshot } from '../fs-events.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import {
  persistNetExchange,
  planTlsCapture,
  setupTlsCapture,
  trustRunCa,
  UnclaimedPaths,
  persistNetRequestStart,
} from '../tls-capture.js';
import { upstreamPlan } from '../upstream.js';
import { AGENTICREPLAY_VERSION } from '../version.js';
import { captureLimits } from '../capture-limits.js';

export interface RecordResult {
  /**
   * Model exchanges the proxy captured.
   *
   * Zero is the failure this whole field exists for, and it has to be readable by a caller that
   * has no terminal to watch: the agent answers, the exit code is zero, and the trace is empty.
   */
  modelExchanges: number;
  runId: string;
  runDir: string;
  events: number;
  exitCode: number;
  childExitCode: number;
}

/**
 * `agenticreplay record <agent>` — stand up the capture layers, launch the agent pointed at them, and get
 * out of the way. The agent is not patched, wrapped or modified; it is simply started with a
 * couple of environment variables that point its model traffic at a local proxy.
 *
 * The wrapper exists for one reason: a TLS-intercepting run mints a private key, and a key that
 * outlives a failed run is the outcome this feature must not have. The recording's own teardown
 * deletes it on the way out, but the likeliest failure of all — the agent is not installed —
 * happens before any teardown runs. Owning the key's lifetime out here means no failure path
 * inside can skip it.
 */
/**
 * Whether a tool call ran a command.
 *
 * By the shape of the arguments rather than by the tool's name: every harness names it something
 * different — `Bash`, `shell`, `run_command`, `exec` — and a list of names would be wrong for the
 * next one. A `command` string is what they all have in common.
 */
function isCommandTool(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() !== '';
}

export async function recordCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<RecordResult> {
  // Before anything else, and never fatal: an orphan left by a killed run holds the same
  // un-redacted material a live one does, and the next recording is the only thing that will ever
  // come across it.
  const sweptStale = await sweepStaleTransports().catch(() => 0);
  if (sweptStale > 0) out.info('transports.swept', { stale: sweptStale });

  const minted: RunCa[] = [];
  // Transport directories, disposed here if the run throws before their drain reaches them. Both
  // hold material written by a process agenticreplay does not own — the agent's shells, the agent's own
  // interpreter — and a run that dies partway must not leave either behind.
  const transports: string[] = [];
  // While this run holds them, they are not orphans, and a sweep that cannot resolve this pid —
  // another container sharing `/tmp` — has no other way to know that. Started here so it covers
  // both transports from the moment each is pushed, and stopped on every exit path below.
  const stopHeartbeat = touchTransports(transports);
  try {
    return await runRecording(args, out, cwd, minted, transports);
  } catch (err) {
    for (const ca of minted) {
      await ca.dispose().catch(() => undefined);
    }
    for (const dir of transports) {
      await discardShellFrames(dir).catch(() => undefined);
    }
    throw err;
  } finally {
    stopHeartbeat();
  }
}

async function runRecording(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  minted: RunCa[],
  transports: string[],
): Promise<RecordResult> {
  const registry = defaultAdapters();
  const agentName = args.positionals[0];

  let adapter: Adapter | undefined;
  if (agentName) {
    adapter = registry.get(agentName);
  } else if (args.passthrough.length > 0) {
    // A command after `--` is not a hint about the environment; it is the answer. Detection is
    // machine-wide by construction — every adapter's is `detectAgent(binaries, homePaths)`, which
    // asks whether a binary is on PATH or a directory exists under `$HOME`, and neither is a fact
    // about this directory. So on a machine with Claude Code installed,
    // `agenticreplay record -- python my_graph.py` detected `claude-code` and launched *that*, handing it
    // `python my_graph.py` as arguments. The run recorded, so the failure looked like a bad key
    // rather than like agenticreplay having started the wrong program.
    //
    // `generic-openai` rather than `exec`: both decline to guess what the command is, but only one
    // of them redirects anything. `exec` points the agent nowhere and warns that interception is
    // required — correct for a Go binary with its origin compiled in, and wrong as a default,
    // because most things run this way read a base-URL variable and would have been captured by
    // setting the three that `generic-openai` sets. Sending everyone to `--tls-intercept` to record
    // a Python script is a worse answer than the bug this replaces.
    adapter = registry.get('generic-openai');
  } else {
    adapter = await registry.detect(cwd);
    if (!adapter) {
      throw new Error(
        `could not detect an agent in ${cwd}\n` +
          `  name one explicitly: agenticreplay record <${registry.ids().join('|')}>\n` +
          `  known agents: ${registry.names().join('; ')}`,
      );
    }
    out.info('adapter.detected', { id: adapter.id });
  }

  // Before the run directory exists, because both of these refuse: `upstreamPlan` an upstream that
  // is not an origin, `planTlsCapture` a `--tls-hosts` list that names `*` or contradicts itself
  // and an `AGENTICREPLAY_TLS_UPSTREAM_CA` that cannot be read. Resolved after it, a typo in any of them
  // left an empty run behind for `agenticreplay list` to show. Neither depends on more than the arguments,
  // the environment and a file the run was going to read anyway, so there is no reason for either
  // to run later — and `planTlsCapture` is the refusing half of `setupTlsCapture` alone, so the
  // certificate authority is still minted below, once the run has a directory to mint it into.
  const plan = await upstreamPlan(args);
  await planTlsCapture(args);

  const dir = await ensureRunsDir(cwd);

  const writer = await TraceWriter.create(dir, {
    adapter: {
      id: adapter.id,
      version: AGENTICREPLAY_VERSION,
      harness_version: adapter.harnessVersions,
    },
    argv: [agentName ?? adapter.id, ...args.passthrough],
    cwd,
    agenticreplayVersion: AGENTICREPLAY_VERSION,
  });

  const captureFs = args.bool('fs', true);
  let fs: FsCapture | undefined;
  if (captureFs) {
    try {
      // The adapter's declared artifacts widen what a snapshot covers. A pipeline writes its
      // product to a path its own `.gitignore` excludes, so without this the trace holds the
      // calls that built an index and no trace of the index; see `HarnessArtifacts.capture`.
      fs = await FsCapture.start({
        runDir: writer.runDir,
        cwd,
        ...(adapter.artifacts?.capture === undefined ? {} : { forced: adapter.artifacts.capture }),
      });
      // Read once, before the agent touches anything: `git` describes the state the run started
      // from, which is what makes it a reproduction instruction rather than a postscript.
      writer.setGit(await fs.gitInfo());
    } catch (err) {
      // Filesystem capture is valuable but not essential; losing it should degrade the trace,
      // not abort the run the user actually wanted to record.
      out.warn('fs.unavailable', { reason: String(err) });
    }
  }

  // MCP capture is opt-in by pointing at a config: the file lives in a different place for every
  // harness, and guessing wrong would rewrite something the user did not mean us to touch.
  let mcp: McpCapture | undefined;
  const mcpConfigPath = args.str('mcp-config');
  if (mcpConfigPath) {
    mcp = await setupMcpCapture({ sourceConfigPath: mcpConfigPath, runDir: writer.runDir, out });
    // THE NOTE IS WRITTEN AFTER `run.start`, NOT HERE — see the append below it.
    //
    // Instrumenting MCP has to happen before the agent launches, because it rewrites the config the
    // agent is about to read. Recording that it happened does not: agenticreplay-trace requires `run.start`
    // at seq 0, and appending here put a `note` there instead, which the gateway's validator
    // refuses on push ("run.start at seq 1, must be seq 0"). Nothing local checks the ordering, so
    // every MCP-instrumented recording looked fine and was unpushable. `tls_intercept` already
    // separates the two — it sets up here and queues its note for after the start event.
  }

  // Shell capture: a PATH shim in front of sh/bash. The protocol layer already reports the command
  // and its merged output one turn late; what only the shim can see is the exit code, the real
  // duration, and which stream each byte came out of.
  let shell: Awaited<ReturnType<typeof installShellShim>> | undefined;
  if (args.bool('shell', true)) {
    try {
      shell = await installShellShim({ runDir: writer.runDir });
      // Only when agenticreplay minted it. A caller-supplied `framesPath` leaves the directory theirs,
      // and this list is deleted wholesale on a failure.
      if (shell.transportDir !== undefined) transports.push(shell.transportDir);
    } catch (err) {
      // Same posture as filesystem capture: degrade the trace, never abort the run.
      out.warn('shell.unavailable', { reason: String(err) });
    }
  }

  // Agent-level structure, for a harness that reports it. The proxy sees `POST /v1/responses` and
  // cannot say which agent sent it, that a handoff happened, or that a guardrail ran — the last of
  // which need make no request at all. A `sitecustomize.py` on PYTHONPATH attaches the OpenAI Agents
  // SDK's tracing to a run without editing the agent, the same trick as the fetch hook's
  // NODE_OPTIONS. Silent and free where the SDK is absent, which is most runs.
  let agentSpans: AgentSpanCapture | undefined;
  if (args.bool('agent-spans', true) || args.bool('tls-intercept', false)) {
    try {
      agentSpans = await installAgentSpans(writer.runDir);
      transports.push(agentSpans.transportDir);
    } catch (err) {
      // Same posture as the other optional layers: degrade the trace, never abort the run.
      out.warn('agent_spans.unavailable', { reason: String(err) });
    }
  }

  const deriver = new ExchangeEventDeriver();
  let turn = 0;
  // When each turn began, so an out-of-band frame can be attributed to the turn it happened during
  // rather than to whichever turn happened to be last when we drained the file.
  const turnStartedAt: { turn: number; at: number }[] = [];
  // Serial, not parallel: each persist snapshots the workspace, and two overlapping `git add`
  // calls collide on index.lock. It also keeps seq in the order exchanges actually happened.
  const writes = new SerialQueue();

  /**
   * TLS interception, off unless the flag is present.
   *
   * Base-URL injection captures every harness that reads a base-URL variable, which is most of
   * them. A Codex CLI signed in with a ChatGPT subscription reads none, and talks to its own
   * backend over TLS — invisible to the ordinary mechanism. This is the answer to that, and it is
   * deliberately a separate decision the operator has to make: it mints a certificate authority.
   */
  /**
   * Paths this run forwarded but could not read, however they arrived.
   *
   * Shared between the interception hook and the plaintext passthrough below, so a run that
   * captured only unreadable traffic can say which paths those were instead of blaming a
   * base-URL variable that was set correctly.
   */
  const unclaimed = new UnclaimedPaths(captureLimits(args).maxCapturedBytes);

  let networkExchanges = 0;
  const requestTurns = new Map<string, number>();
  const bufferLimit = captureLimits(args).maxBufferedBytes;
  let queuedBodyBytes = 0;
  function enqueueBodyWrite(bytes: number, task: () => Promise<void>): boolean {
    if (queuedBodyBytes + bytes > bufferLimit) {
      writer.markCaptureIncomplete('persistence_buffer_limit');
      return false;
    }
    queuedBodyBytes += bytes;
    writes.push(async () => {
      try {
        await task();
      } finally {
        queuedBodyBytes -= bytes;
      }
    });
    return true;
  }
  async function startRequest(request: NetRequest): Promise<void> {
    const requestTurn = ++turn;
    requestTurns.set(request.requestId, requestTurn);
    turnStartedAt.push({ turn: requestTurn, at: request.requestStartedAt });
    await persistNetRequestStart(writer, requestTurn, request);
  }
  function finishRequest(exchange: NetExchange): void {
    networkExchanges += 1;
    unclaimed.note(out, exchange);
    const requestTurn = requestTurns.get(exchange.requestId);
    if (requestTurn === undefined) writer.markCaptureIncomplete('missing_request_correlation');
    const bytes =
      Buffer.byteLength(exchange.requestBody) + Buffer.byteLength(exchange.responseBody);
    if (!enqueueBodyWrite(bytes, () => persistNetExchange(writer, requestTurn ?? 0, exchange))) {
      const omitted: NetExchange = {
        ...exchange,
        requestBody: '',
        responseBody: '',
        requestTruncated: true,
        responseTruncated: true,
        transformations: [
          ...(exchange.transformations ?? []),
          {
            kind: 'omission',
            location: 'request.body',
            rule: 'persistence_buffer_limit',
            count: 1,
            reason: 'concurrent persistence budget exhausted',
          },
          {
            kind: 'omission',
            location: 'response.body',
            rule: 'persistence_buffer_limit',
            count: 1,
            reason: 'concurrent persistence budget exhausted',
          },
        ],
      };
      writes.push(() => persistNetExchange(writer, requestTurn ?? 0, omitted));
    }
  }
  const tls = await setupTlsCapture({
    args,
    out,
    writer,
    writes,
    turn: () => turn,
    unclaimed,
    onRequestStart: startRequest,
    onNetExchange: finishRequest,
  });
  if (tls.ca) minted.push(tls.ca);
  const ca = tls.ca;

  // The mirror of the warning inside `setupTlsCapture`, which fires when hosts are named without
  // interception. This one fires when interception is the adapter's *only* route to the traffic
  // and it was not asked for: a `transport` adapter redirects nothing on purpose, so without
  // `--tls-intercept` the run completes, exits zero and records no model traffic at all. That is
  // the precise shape of failure the adapter contract exists to catch, and it deserves to be said
  // out loud rather than inferred from an empty trace. `tls.ca` is minted only when interception
  // is on, which makes it the signal.
  if (adapter.capture === 'transport' && !tls.ca) {
    out.warn('tls.intercept_required', {
      adapter: adapter.id,
      reason: 'this adapter points the agent nowhere and relies on interception',
      next: "add --tls-intercept, and --tls-hosts '+host' for a host outside the defaults",
    });
  }
  // A `config` adapter points the agent somewhere too — through a file rather than a variable —
  // so it needs no interception and must not be told to turn it on. It is named here only so
  // that the branch above is read as the narrow thing it is.

  /** Model exchanges the proxy actually captured — the number the warning below turns on. */
  let modelExchanges = 0;
  /**
   * Tool calls that ran a command, counted from the model exchanges rather than from the shim.
   *
   * This is the evidence half of the shell-shim check. The shim reports success when it installs,
   * which says nothing about whether the harness ever went through it: Claude Code on Windows
   * resolves its shell without consulting PATH, so `shell=on` printed happily while the frames
   * file stayed empty for a run full of Bash calls. Comparing what the model asked for against
   * what the shim saw is what turns that silence into something agenticreplay can say out loud.
   */
  let commandToolCalls = 0;
  /** Commands the shim actually saw. Zero against a non-zero `commandToolCalls` is the warning. */
  let shellFrames = 0;
  // (the count this used to keep was read by nothing; the layer reports through its events)
  /**
   * Exchanges the upstream answered with an error status.
   *
   * Counted because a run in which every model call failed is indistinguishable, from the summary
   * line alone, from one that worked: the harness retries, gives up, exits 0, and agenticreplay prints
   * `recorded … exit=0` over a trace whose every answer is a 503. That happened against a gateway
   * whose credentials had lapsed, and nothing in the output said so.
   */
  let erroredExchanges = 0;
  /** The status those errors carried, so the warning can name it rather than describe it. */
  const errorStatuses = new Map<number, number>();

  const proxy = await createProxy({
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    upstreamHeadersOrigin: plan.headersOrigin,
    onRequestStart: startRequest,
    onExchange: (exchange: RecordedExchange) => {
      modelExchanges += 1;
      if (exchange.status >= 400) {
        erroredExchanges += 1;
        errorStatuses.set(exchange.status, (errorStatuses.get(exchange.status) ?? 0) + 1);
      }
      enqueueBodyWrite(
        Buffer.byteLength(exchange.rawRequest) + Buffer.byteLength(exchange.rawResponse),
        () => persist(exchange),
      );
    },
    // A POST on a path no dialect claims is forwarded rather than refused, and lands in the trace
    // as the same `net.*` pair unrecognised TLS traffic does. AgenticReplay holds the bytes but not the
    // meaning, so it is evidence, not a replayable turn.
    onNetExchange: finishRequest,
    ...tls.proxyOptions,
  });

  async function persist(exchange: RecordedExchange): Promise<void> {
    const requestTurn = exchange.requestId ? requestTurns.get(exchange.requestId) : undefined;
    if (requestTurn === undefined) writer.markCaptureIncomplete('missing_model_correlation');
    await appendDerivedEvents(writer, deriver, exchange, requestTurn ?? 0, (derived) => {
      if (derived.type === 'tool.call' && isCommandTool(derived.attrs['input'])) {
        commandToolCalls += 1;
      }
    });

    if (fs) await appendSnapshot(fs, writer, out, requestTurn ?? 0);
  }

  await writer.append({
    type: 'run.start',
    actor: 'agenticreplay',
    turn: 0,
    attrs: { adapter: adapter.id, cwd, proxy: proxy.url },
  });

  // The source path, written down because a replay needs it and can get it nowhere else:
  // `manifest.argv` holds the agent's own arguments, and `--mcp-config` is agenticreplay's. Without this a
  // replay of an MCP-using run either loses the layer or cannot start the harness at all. Deferred
  // to here so `run.start` keeps seq 0 — see the note at the setup site.
  if (mcp && mcpConfigPath) {
    await writer.append({
      type: 'note',
      actor: 'agenticreplay',
      turn: 0,
      attrs: {
        rule: 'mcp_instrumented',
        source: resolve(cwd, mcpConfigPath),
        servers: mcp.rewritten.join(',') || undefined,
        skipped: mcp.skipped.join(',') || undefined,
      },
      operationalPathAttrs: ['source'],
    });
  }

  if (fs) await appendSnapshot(fs, writer, out, 0, { initial: true });

  /**
   * Give up on a run that has already started, then re-throw.
   *
   * Two failures share this path, and both were silent in their own way.
   *
   * A listening proxy keeps Node's event loop alive, so a throw printed the error and then hung
   * — `agenticreplay record generic-openai -- /nonexistent` never exited, and mistyping an agent name is
   * the first thing a new user does. And an unsealed trace has no `ended_at`, `counts` or
   * `integrity`, so everything the agent did is on disk while `verifyIntegrity` reports the run as
   * *tampered* rather than as unfinished.
   *
   * Sealing rather than discarding: a run that died is often the run you most want to read, and
   * the exit code is unknown rather than zero, so it is left absent.
   */
  async function abandon(err: unknown): Promise<never> {
    if (fs) await fs.dispose().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await writes.drain().catch(() => undefined);
    if (ca) await ca.dispose().catch(() => undefined);
    await writer
      .append({ type: 'run.end', actor: 'agenticreplay', turn, attrs: { error: String(err) } })
      .catch(() => undefined);
    await writer.close().catch(() => undefined);
    throw err;
  }

  /*
   * Everything from here to the child's exit runs with the proxy already listening, so everything
   * from here to the child's exit has to come back through `abandon`.
   *
   * The guard used to start at the spawn, which covered the failure it was written for — an agent
   * that is not on PATH — and missed the one that happens first. An adapter validates the
   * invocation in `prepare`, before anything is spawned: `agenticreplay record node agent.mjs`, with the
   * `--` left out, printed exactly the right message about the `--` and then hung forever. So did
   * a failure to snapshot the session directory, or to trust the run CA.
   */
  const { launch, sessionBefore } = await (async () => {
    try {
      const ctx: RecordContext = {
        runId: writer.runId,
        cwd,
        proxyUrl: proxy.url,
        runDir: writer.runDir,
        userArgs: args.passthrough,
        env: process.env,
      };
      const prepared = await adapter.prepare(ctx);

      // Listed before the agent starts, so the file it writes can be told from the ones already
      // there. The harness's transcript is the only record of what the person typed; without it an
      // interactive run is captured but its API exchanges remain the primary conversation record.
      const before = await snapshotDir(adapter.session?.dir(cwd, process.env));

      if (shell) {
        prepared.env.PATH = `${shell.dir}${delimiter}${process.env.PATH ?? ''}`;
      }
      if (agentSpans) {
        // Both, or neither works: PYTHONPATH is how Python finds the bootstrap, and the variable is
        // what tells the bootstrap this is a recording rather than an ordinary Python process.
        prepared.env.PYTHONPATH = pythonPathWith(
          agentSpans.pythonPath,
          process.env.PYTHONPATH,
          delimiter,
        );
        if (args.bool('agent-spans', true)) prepared.env[SPANS_ENV] = agentSpans.spansPath;
      }
      if (mcp) {
        pointAtMcpConfig(prepared.env, mcp.configPath);
        // The variables above are belt and braces for a harness agenticreplay has not met. What actually
        // reaches Claude Code is this: it takes the path on the command line and reads no
        // environment variable for it, so without this the instrumented config was written and
        // never opened.
        const mcpArgs = adapter.mcpConfigArgs?.(mcp.configPath);
        if (mcpArgs !== undefined) prepared.args = [...mcpArgs, ...prepared.args];
        else
          out.warn('mcp.not_wired', {
            adapter: adapter.id,
            cause: `${adapter.id} has no command-line form for an MCP config, and reads none of the variables agenticreplay sets`,
            effect:
              'the instrumented config exists but the agent will not load it, so no MCP frames will be captured',
          });
      }

      if (proxy.tls) {
        await trustRunCa(writer, proxy.tls, proxy.url, prepared.env, out);
      }

      return { launch: prepared, sessionBefore: before };
    } catch (err) {
      return abandon(err);
    }
  })();

  out.phase('recording', {
    run: writer.runId,
    adapter: adapter.id,
    proxy: proxy.url,
    // `proxy` is agenticreplay's own address, so the line said where the agent would call and never where
    // the call would go on to. A gateway left behind in `~/.agenticreplay/config.json` redirects every run
    // on the machine, and the first sign of it used to be an answer from a model nobody asked for.
    //
    // Only when something was configured. Left alone, each dialect has its own vendor default and
    // there is no single value to print — and `upstream=default` on every ordinary run is noise
    // that would teach people to stop reading the line. The trace records the origin either way,
    // per exchange, because that is where it is actually decided.
    ...(distinctOrigins(plan.upstream).length > 0
      ? { upstream: distinctOrigins(plan.upstream).join(',') }
      : {}),
    fs: fs ? 'on' : 'off',
    shell: shell ? 'on' : 'off',
  });

  let exitCode: number;
  try {
    exitCode = await runChild(
      launch.command,
      launch.args,
      { ...process.env, ...launch.env },
      launch.cwd ?? cwd,
      // Under --json, stdout is the result document. The agent's own output must not land in it.
      args.bool('json'),
    );
  } catch (err) {
    return abandon(err);
  }

  await writes.drain().catch((err: unknown) => {
    writer.markCaptureIncomplete('storage_failure');
    out.warn('capture.storage_failure', { detail: String(err) });
  });

  /** The turn an out-of-band frame belongs to: the last one that had begun when it happened. */
  function turnAt(at: number): number {
    let found = 0;
    for (const mark of turnStartedAt) {
      if (mark.at > at) break;
      found = mark.turn;
    }
    return found;
  }

  if (shell) {
    // Timestamped from the frame, not from now. These are read off disk after the agent has
    // exited, so stamping them at write time put every shell command at the end of the run with
    // the final turn number — which makes `mono_us` describe the drain rather than the command,
    // and leaves the commands unable to interleave with the model turns they happened between.
    const frames = await readShellFrames(shell.framesPath);
    // Read, then gone, for the same reason the spans transport is: every frame is about to be
    // appended through `writer.append`, which redacts, and what is left on disk afterwards is a
    // verbatim copy of every command line the agent ran that nothing reads and `agenticreplay scrub` never
    // rewrites. Before the appends rather than after, so an append that throws still takes it.
    const framesLeft =
      shell.transportDir === undefined ? undefined : await discardShellFrames(shell.transportDir);
    if (framesLeft !== undefined) out.warn('shell_frames.not_removed', { reason: framesLeft });
    shellFrames = frames.length;
    for (const frame of frames) {
      const startedAt = Date.parse(frame.startedAt);
      const at = Number.isNaN(startedAt) ? undefined : new Date(startedAt);
      const frameTurn = at === undefined ? turn : turnAt(startedAt);
      const exec = await writer.append({
        type: 'shell.exec',
        actor: 'harness',
        turn: frameTurn,
        ...(at === undefined ? {} : { occurredAt: at }),
        attrs: { argv: [frame.name, ...frame.argv], cwd: frame.cwd },
      });
      await writer.append({
        type: 'shell.result',
        actor: 'harness',
        turn: frameTurn,
        causes: [exec.seq],
        // The result happened when the command finished, which is what its duration measures.
        ...(at === undefined ? {} : { occurredAt: new Date(startedAt + frame.durationMs) }),
        attrs: {
          exit_code: frame.exitCode,
          signal: frame.signal,
          duration_ms: frame.durationMs,
          stdout_bytes: frame.stdoutBytes,
          stderr_bytes: frame.stderrBytes,
        },
      });
    }
  }

  if (agentSpans) {
    // Timestamped from the span, like the shell frames above and for the same reason: these are
    // read off disk after the agent exited, so stamping them now would file every handoff at the
    // end of the run rather than between the turns it happened between.
    const spans = await readAgentSpans(agentSpans.spansPath);
    // Read, then gone. Everything the trace keeps from this file is about to be appended through
    // `writer.append`, which redacts; what is left on disk afterwards is a copy nothing reads and
    // nothing scrubs. Before the appends rather than after, so an append that throws still takes
    // the transport with it.
    const spansLeft = await discardAgentSpanTransport(agentSpans.transportDir);
    if (spansLeft !== undefined) out.warn('agent_spans.not_removed', { reason: spansLeft });
    // Before the events, because both say the trace is about to be less complete than it looks,
    // and the operator reads the top of the drain rather than the bottom.
    const losses = agentSpanLosses(spans);
    // The second gate. The bootstrap now applies the first one itself — it reports a package only
    // once the agent actually imports the framework — so what is left here is the case where a run
    // captured no model traffic at all. `capture.empty` below already says that larger thing, and
    // naming a missing package on top of it would send someone to `pip install` over a problem
    // that is not about a package.
    for (const pkg of modelExchanges > 0 ? losses.unavailable : []) {
      // The prose comes from the adapter table, so a package cannot be reported with another
      // package's explanation — which is exactly what happened when this text was a constant and a
      // second adapter arrived.
      const adapter = PYTHON_ADAPTERS.find((entry) => entry.package === pkg);
      out.warn('agent_spans.unavailable', {
        package: pkg,
        // What was actually observed, rather than what it suggests. The bootstrap saw the
        // framework's own module being imported and confirmed with `importlib.metadata` that a
        // distribution provides that name; it does not know what the agent then did with it.
        cause: `${adapter?.distribution ?? 'the framework'} was imported and this package is not installed`,
        effect: `the run is recorded, without ${adapter?.lost ?? 'the structure only it can see'}`,
        next: `pip install ${pkg}`,
      });
    }
    if (losses.dropped > 0) {
      out.warn('agent_spans.dropped', {
        count: losses.dropped,
        // Which adapter, where it said. Several write to one transport, so the total on its own
        // says how much was lost and nothing about where to look.
        ...(losses.droppedBy.length > 0 ? { package: losses.droppedBy.join(', ') } : {}),
        cause: 'the adapter could not serialise or could not write these records',
      });
    }
    for (const span of spans) {
      const derived = eventForSpan(span);
      if (derived === undefined) continue;
      // When the span happened, from whichever end it carries. A record that closes something has
      // only `ended_at`, and reading `started_at` alone stamped every one of them from the drain's
      // own clock — which runs after the agent has exited. Measured on a three-node graph: all
      // three `graph.node.end` events landed at the same instant, 600ms after the run, so the
      // first node appeared to finish after the second had started and the timeline said the
      // opposite of what happened. `occurredAt` is also what `turnAt` reads, so the same mistake
      // filed them under the wrong turn.
      const startedAt = Date.parse(String(span.started_at ?? span.ended_at ?? ''));
      const at = Number.isNaN(startedAt) ? undefined : new Date(startedAt);
      await writer.append({
        type: derived.type as 'agent.start',
        // `harness`, not `agenticreplay`: we did not observe this, we were told it.
        actor: 'harness',
        turn: at === undefined ? turn : turnAt(startedAt),
        ...(at === undefined ? {} : { occurredAt: at }),
        attrs: derived.attrs,
      });
    }
  }

  if (mcp) await drainMcpFrames(mcp, writer, turnAt, turn);

  const orphans = deriver.unresolved();
  if (orphans.length > 0) {
    await writer.append({
      type: 'note',
      actor: 'agenticreplay',
      turn,
      attrs: { rule: 'unresolved_tool_calls', ids: orphans.map((o) => o.id) },
    });
  }

  // Before the trace is sealed, not after. A tunnel's record is only complete when its socket
  // closes, and closing the proxy is what closes the ones an exiting agent left open — so a
  // `proxy.close()` after `writer.close()` produced tunnel records with nowhere to go.
  await proxy.close();
  await writes.drain().catch((err: unknown) => {
    writer.markCaptureIncomplete('storage_failure');
    out.warn('capture.storage_failure', { detail: String(err) });
  });
  // The CA dies with the run. `dispose` is idempotent and best-effort: failing to delete a key is
  // worth a warning, never worth losing the trace the user was recording.
  if (ca) {
    try {
      await ca.dispose();
    } catch (err) {
      out.warn('tls.ca_not_removed', { path: ca.dir, reason: String(err) });
    }
  }

  /**
   * The harness's own transcript, and with it the prompts nothing on the wire carries.
   *
   * Written before `run.end` so it is part of the run rather than an appendix, and stored as a compact action note so interactive prompts that never reached the API remain visible.
   */
  let session: Awaited<ReturnType<typeof captureSession>>;
  if (adapter.session) {
    try {
      session = await captureSession(adapter.session, cwd, process.env, sessionBefore);
    } catch (err) {
      out.warn('session.unavailable', { reason: String(err) });
    }
  }
  if (session) {
    await writer.append({
      type: 'note',
      actor: 'harness',
      turn,
      attrs: {
        rule: 'session_prompts',
        harness: adapter.id,
        prompts: session.prompts.length,
      },
      payload: { prompts: session.prompts },
    });
  }

  const observed = networkExchanges;
  if (requestTurns.size !== networkExchanges) writer.markCaptureIncomplete('unfinalized_request');
  writer.setCaptureSummary({
    status: observed > 0 ? 'complete' : 'incomplete',
    issues: observed > 0 ? [] : ['no_requests_observed'],
    body_limit_bytes: captureLimits(args).maxCapturedBytes,
    requests: requestTurns.size,
    responses: networkExchanges,
  });
  await writer.append({
    type: 'run.end',
    actor: 'agenticreplay',
    turn,
    attrs: { exit_code: exitCode },
  });
  const manifest = await writer.close(exitCode);

  out.phase('recorded', {
    run: writer.runId,
    events: manifest.counts?.events ?? writer.seq,
    blobs: manifest.counts?.blobs ?? 0,
    exit: exitCode,
    capture: manifest.capture?.status ?? 'unverified',
    dir: writer.runDir,
  });

  /**
   * The quietest way agenticreplay can fail, and the most damaging.
   *
   * Capture works by pointing a base-URL variable at the proxy, so a harness that reads none of
   * them is never redirected — and there is nothing to notice. The agent answers, the exit code is
   * zero, and the trace is empty. An agent with its origin compiled into source is the live
   * example: it never consults a base-URL variable, so `agenticreplay record` produces exactly this.
   *
   * `contract.ts` already names this shape as what the adapter checks exist to prevent. They guard
   * the adapters; this guards the run, which is where a user actually meets it.
   */
  if (modelExchanges === 0) {
    const baseUrls = Object.keys(launch.env)
      .filter((name) => /(?:_BASE_URL|_API_BASE)$/.test(name))
      .sort();
    // Which cause is worth naming depends on how this adapter captures at all, and the line
    // already carries the evidence: `set=none` means there was never a variable to be ignored.
    // Printing "it may not read a base-URL variable" next to `set=none` contradicts the run's own
    // output and sends the reader after a route that was never the route -- which is how the
    // capture bug fixed earlier in this branch stayed hidden through a dozen rounds of debugging.
    //
    // The proxy's own counters come first, because they settle the question the other branches
    // are guessing at. A call agenticreplay forwarded is a call the agent made *to agenticreplay*: the variables
    // were read and the redirection worked, so "the agent never called the proxy" is false on its
    // face and costs the reader a search through a configuration that was right all along.
    const opaque = proxy.stats().passedThrough;
    const paths = unclaimed.list();

    out.warn('capture.empty', {
      exchanges: 0,
      cause:
        opaque > 0
          ? `the agent called the proxy ${opaque} time(s), on ${paths.length > 0 ? paths.join(', ') : 'unclassified paths'}; those requests are recorded as network traffic`
          : baseUrls.length > 0
            ? 'the agent never called the proxy — it may not read a base-URL variable'
            : adapter.capture === 'config'
              ? `${adapter.id} is redirected through its own config, and this run had no configured provider to redirect`
              : tls.ca
                ? 'this adapter captures at the transport, and nothing agenticreplay decrypted looked like a model call'
                : 'this adapter captures at the transport, and interception was not on',
      ...(opaque > 0 ? { passed_through: opaque } : {}),
      set: baseUrls.join(',') || 'none',
      next: opaque > 0 ? 'agenticreplay show to read what was forwarded' : 'agenticreplay doctor',
    });
  }

  /**
   * Every model call came back an error.
   *
   * `capture.empty` covers the run the proxy never saw. This covers the run it saw all of, where
   * every answer was a refusal: an expired gateway credential, a model the account cannot reach, a
   * provider outage. The harness retries, exhausts its attempts, prints its own error and exits 0,
   * so the summary reads exactly like a successful recording — `recorded events=27 exit=0` — over
   * a trace that contains no model output at all. Replaying it faithfully reproduces the failures.
   *
   * Only when *all* of them failed. A run that retried once and then worked is a run that worked,
   * and warning about it would train people to ignore the line that matters.
   */
  if (modelExchanges > 0 && erroredExchanges === modelExchanges) {
    const commonest = [...errorStatuses.entries()].sort((a, b) => b[1] - a[1])[0];
    out.warn('capture.errors', {
      exchanges: modelExchanges,
      errors: erroredExchanges,
      status: commonest ? commonest[0] : 'unknown',
      cause: 'every model call the proxy forwarded came back an error',
      effect: 'the trace holds the failures, not any model output — a replay reproduces those',
      next: 'agenticreplay show to read the errors, then check the upstream credential or model id',
    });
  }

  /**
   * Shell capture that was on and recorded nothing.
   *
   * `installShellShim` succeeding means a `sh`, a `bash` and a `zsh` were written into the run
   * directory and put at the front of PATH. It does not mean the harness went through them, and
   * on Windows Claude Code does not: it finds its shell without consulting PATH, so the shim sits
   * unused while `shell=on` is printed and the frames file stays empty. What is lost is precisely
   * what only the shim can see — the real exit code, the real duration, and which stream each byte
   * came from — while the commands still appear as tool calls, so nothing looks wrong.
   *
   * The condition is evidence, not a platform check: commands demonstrably ran and the layer that
   * was supposed to see them saw none of them, whatever the reason.
   */
  if (shell && shellFrames === 0 && commandToolCalls > 0) {
    out.warn('shell.ineffective', {
      commands: commandToolCalls,
      captured: 0,
      cause: 'the harness ran its shell without going through the PATH shim',
      effect: 'exit codes, durations and the stdout/stderr split are not in this trace',
      next: 'record with --no-shell, which claims nothing rather than claiming this',
    });
  }

  if (fs) await fs.dispose().catch(() => undefined);

  out.plain('');
  out.plain(`  agenticreplay show ${writer.runId}             # inspect the recorded activity`);
  out.plain(`  agenticreplay ui ${writer.runId}               # open the timeline`);

  return {
    runId: writer.runId,
    runDir: writer.runDir,
    events: manifest.counts?.events ?? writer.seq,
    modelExchanges,
    childExitCode: exitCode,
    exitCode: exitCode !== 0 ? exitCode : manifest.capture?.status === 'incomplete' ? 2 : 0,
  };
}

/**
 * Launch the agent.
 *
 * `stdio: 'inherit'` by default, and that matters: an interactive harness needs the real terminal,
 * and anything less turns a TUI into a stream of escape codes.
 *
 * `quietStdout` is for `--json`, where agenticreplay's stdout is a document rather than a terminal. The
 * agent's own chatter is still shown — it moves to stderr, where a human reads it and a parser
 * does not. stdin and stderr stay inherited so the agent can still prompt and still colour.
 */
async function runChild(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  quietStdout = false,
): Promise<number> {
  // Resolved the way detection resolves, so a launcher never reports ENOENT for an agent that
  // `agenticreplay doctor` just called present.
  const target = await resolveLaunch(command, argv);
  return new Promise((resolve, reject) => {
    const child = spawn(target.file, target.args, {
      env,
      cwd,
      shell: target.shell,
      stdio: quietStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    child.stdout?.pipe(process.stderr);
    // Forward interrupts so Ctrl-C reaches the agent rather than orphaning it behind the proxy.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    child.on('error', (err) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      reject(
        new Error(
          `could not launch "${command}"\n` +
            `  ${String(err)}\n` +
            `  is it installed and on your PATH?`,
        ),
      );
    });
    child.on('close', (code) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code ?? 0);
    });
  });
}

/**
 * The origins a configured upstream map actually names, deduplicated and safe to print.
 *
 * `resolveUpstream` writes one entry per dialect and `openai` and `openai-responses` always share
 * a value — so the raw map renders a single gateway three times. What a reader wants is the set of
 * places traffic can go, which is usually one.
 *
 * Through `recordableOrigin` for the same reason the trace goes through it, and against the same
 * sentence: `agenticreplay setup --gateway` accepts a URL carrying the key — `https://user:pw@gw.example`,
 * `https://gw.example?key=…` — and `config.ts` says of that file that "nothing ever prints it
 * back". A line on the terminal is printing it back, and it is a line that ends up in CI logs.
 */
export function distinctOrigins(upstream: Record<string, string> | undefined): string[] {
  const safe = Object.values(upstream ?? {})
    // Dropped only where sanitising cannot work, so a gateway configured with its key in the URL
    // still says *where* the traffic went. `recordableOrigin` removes userinfo and query, which is
    // enough for every `http(s)://` value — but a scheme-less URL parses with its username as the
    // protocol, so it comes back as `myuser://PASSWORD@gw.example/v1`, credential intact, and a
    // filter keeping everything that is not `undefined` kept it. There is no sanitising that: with
    // no scheme there is no telling which half of `a:b` was meant as the host. `upstreamPlan`
    // refuses these before a run starts; this is here because the function is exported and one
    // line from a terminal.
    .filter((origin) => unusableOrigin(origin) === undefined)
    .map(recordableOrigin)
    .filter((origin): origin is string => origin !== undefined);
  return [...new Set(safe)];
}
