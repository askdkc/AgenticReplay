import { once } from 'node:events';
import { TraceWriter, ensureRunsDir } from '@agenticreplay/core';
import {
  createProxy,
  type RecordedExchange,
  type RunCa,
  type NetRequest,
  type NetExchange,
} from '@agenticreplay/proxy';
import { defaultAdapters } from '@agenticreplay/adapters';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import { advertisedUrl, attachExports, attachInstructions } from '../attach.js';
import { ExchangeEventDeriver, appendDerivedEvents } from '../exchange-events.js';
import { SerialQueue } from '../serial.js';
import {
  planTlsCapture,
  setupTlsCapture,
  persistNetRequestStart,
  persistNetExchange,
} from '../tls-capture.js';
import { upstreamPlan } from '../upstream.js';
import { AGENTICREPLAY_VERSION } from '../version.js';

/**
 * `agenticreplay attach` — record an agent this machine did not start.
 *
 * Everything else here launches the agent: an adapter builds an environment, agenticreplay spawns the
 * process, and capture follows from that. It is a good design with one boundary it cannot cross —
 * an agent that is not on this machine. A bot on a VPS, an agent inside a dev container or a cloud
 * sandbox, a harness in someone else's CI: there is no process to spawn, so there is no
 * environment to build and no way to say `agenticreplay record` at all.
 *
 * So this inverts it. AgenticReplay holds the proxy open, prints exactly what to export on the far side,
 * and records whatever arrives until it is stopped. The recording that comes out is not a lesser
 * one: the same request and action events as a locally launched recording.
 *
 * The adapters are still what produce the variables — `--for claude` prints what the Claude Code
 * adapter would have set, pointed at the advertised address instead of a loopback one. That keeps
 * one source of truth for "which variable does this harness read", so a sandbox recording cannot
 * drift from a local one.
 */

export interface AttachResult {
  runId: string;
  runDir: string;
  modelExchanges: number;
  events: number;
  proxyUrl: string;
  /**
   * Non-zero when replay cannot answer a request or recording coverage is incomplete.
   * An operator stopping the session is normal; missing transport evidence still returns exit 2.
   */
  exitCode: number;
}

export interface AttachOptions {
  /**
   * Resolves when the session should stop. Defaults to SIGINT — the operator pressing ctrl-C,
   * which is how a session with no child process to wait on ends.
   */
  until?: Promise<void>;
  /** Called once the proxy is listening, with the address a remote agent should use. */
  onReady?: (info: { proxyUrl: string; runId: string }) => void;
}

export async function attachCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
  options: AttachOptions = {},
): Promise<AttachResult> {
  const minted: RunCa[] = [];
  try {
    return await runAttached(args, out, cwd, options, minted);
  } catch (err) {
    for (const ca of minted) await ca.dispose().catch(() => undefined);
    throw err;
  }
}

async function runAttached(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  options: AttachOptions,
  minted: RunCa[],
): Promise<AttachResult> {
  const registry = defaultAdapters();
  const bind = args.str('bind') ?? '127.0.0.1';
  const advertise = args.str('advertise');
  const requestedPort = args.num('port') ?? 0;

  // Resolved before the run directory is made, so an invocation that cannot work — a wildcard bind
  // with nothing to advertise — leaves nothing behind to clean up. The port is not known yet when
  // agenticreplay is choosing one, and does not need to be: only the host can make this fail.
  advertisedUrl({
    bind,
    port: requestedPort === 0 ? 1 : requestedPort,
    ...(advertise === undefined ? {} : { advertise }),
  });

  // The remote process is not visible locally, so the operator names its harness or uses exec.
  const adapterName = args.str('for') ?? 'exec';
  const adapter = registry.get(adapterName);

  // The last thing that can refuse the run, and it runs before the trace exists: a writer created
  // first and abandoned by a throw leaves an unsealed run directory behind, which then wins `last`
  // — so the next command someone types operates on the session that never happened. Awaited
  // since it grew the one refusal that needs the disk, an `AGENTICREPLAY_TLS_UPSTREAM_CA` that cannot be
  // read; the guarantee here is unchanged, it just covers one more way to fail.
  await planTlsCapture(args);

  // Before the run directory exists, because this refuses an upstream that is not an origin: resolved after it, a
  // typo in `--upstream-*` left an empty run behind for `agenticreplay list` to show. It depends on nothing
  // but the arguments and the environment, so there is no reason for it to run any later.
  const plan = await upstreamPlan(args);

  const dir = await ensureRunsDir(cwd);
  const writer = await TraceWriter.create(dir, {
    adapter: {
      id: adapter.id,
      version: AGENTICREPLAY_VERSION,
      harness_version: adapter.harnessVersions,
    },
    argv: [adapterName],
    cwd,
    agenticreplayVersion: AGENTICREPLAY_VERSION,
  });

  let modelExchanges = 0;
  let turn = 0;

  const writes = new SerialQueue();
  const attempts = new Map<string, number>();
  let terminalAttempts = 0;
  async function start(request: NetRequest): Promise<void> {
    attempts.set(request.requestId, ++turn);
    await persistNetRequestStart(writer, turn, request);
  }
  function finish(exchange: NetExchange): void {
    terminalAttempts++;
    const at = attempts.get(exchange.requestId);
    if (at === undefined) writer.markCaptureIncomplete('missing_request_correlation');
    writes.push(() => persistNetExchange(writer, at ?? 0, exchange));
  }
  const tls = await setupTlsCapture({
    args,
    out,
    writer,
    writes,
    // Out-of-band traffic belongs to whichever turn was in progress when it happened, exactly as in
    // a launched recording. A fixed 0 filed every net.* event against the start of the session.
    turn: () => turn,
    onRequestStart: start,
    onNetExchange: finish,
  });
  if (tls.ca) minted.push(tls.ca);
  const deriver = new ExchangeEventDeriver();

  // BEFORE THE PROXY, NOT AFTER: `createProxy` is listening by the time it returns, and the first
  // thing a remote agent sends becomes an event. `attach` wrote no run.start at all, so every
  // session it recorded opened on `model.request` and the gateway refused the push — "0 run.start
  // and 1 run.end events". The proxy URL that `record`'s run.start carries is not known yet and is
  // not read by anything; the adapter and the cwd are what a reader needs.
  await writer.append({
    type: 'run.start',
    actor: 'agenticreplay',
    turn: 0,
    attrs: { adapter: adapter.id, cwd, attached: true },
  });

  const proxy = await createProxy({
    host: bind,
    port: requestedPort,
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    upstreamHeadersOrigin: plan.headersOrigin,
    ...tls.proxyOptions,
    onRequestStart: start,
    onNetExchange: finish,
    onExchange: (exchange: RecordedExchange) => {
      modelExchanges += 1;
      const at = exchange.requestId ? (attempts.get(exchange.requestId) ?? 0) : 0;
      writes.push(() => appendDerivedEvents(writer, deriver, exchange, at));
    },
  });

  const advertised = advertisedUrl({
    bind,
    port: proxy.port,
    ...(advertise === undefined ? {} : { advertise }),
  });

  try {
    const proxyUrl = advertised;

    // What the adapter would have put into a child's environment, pointed at the reachable
    // address rather than a loopback one. `runDir` is this machine's, and is only ever used by
    // adapters that write a scratch file — none of which a remote agent would read, which is why
    // `--for` is documented as the variables rather than as full instrumentation.
    const launch = await adapter.prepare({
      runId: writer.runId,
      cwd,
      runDir: writer.runDir,
      proxyUrl,
      userArgs: ['<your agent>'],
      env: process.env,
    });

    const remoteCaPath = args.str('remote-ca-path') ?? '/tmp/agenticreplay-ca.crt';
    const instructions = attachInstructions({
      proxyUrl,
      adapterEnv: launch.env,
      ...(proxy.tls
        ? {
            ca: { certPath: proxy.tls.caCertPath, bundlePath: proxy.tls.caBundlePath },
            remoteCaPath,
          }
        : {}),
    });

    out.phase('attached', {
      run: writer.runId,
      proxy: proxyUrl,
      for: adapter.id,
    });
    if (proxy.tls) {
      out.warn('tls.intercepting', {
        hosts: proxy.tls.hosts,
        ca_sha256: proxy.tls.fingerprint,
      });
      await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        turn: 0,
        attrs: {
          rule: 'tls_intercept',
          hosts: proxy.tls.hosts,
          ca_sha256: proxy.tls.fingerprint,
        },
      });
    }
    /**
     * An instruction the operator cannot act on is worse than none: the block pastes cleanly, the
     * session waits, and nothing ever connects. Both shapes of that are visible from here.
     */
    const exported = attachExports({
      proxyUrl,
      adapterEnv: launch.env,
      ...(proxy.tls
        ? {
            ca: { certPath: proxy.tls.caCertPath, bundlePath: proxy.tls.caBundlePath },
            remoteCaPath,
          }
        : {}),
    });
    if (Object.keys(exported).length === 0) {
      out.warn('attach.nothing_to_set', {
        for: adapter.id,
        cause: `${adapter.id} redirects nothing, and this session is not intercepting`,
        next: 'name the harness with --for <agent>, or add --tls-intercept',
      });
    }
    // A path under the run directory exists on this machine and nowhere else. The fetch hook is
    // the live example: `--for node` names a preload agenticreplay just wrote here, so the block would
    // instrument nothing over there while looking exactly as though it had.
    const local = Object.entries(exported)
      .filter(([, value]) => value.includes(writer.runDir))
      .map(([name]) => name);
    if (local.length > 0) {
      out.warn('attach.local_path', {
        vars: local.join(','),
        cause: `${adapter.id} instruments by writing a file here and naming it in the environment`,
        effect: 'those paths do not exist in the sandbox, so that half of the capture will not run',
        next: 'copy the named files across, or use --tls-intercept instead',
      });
    }

    out.plain('');
    for (const line of instructions) out.plain(`  ${line}`);
    out.plain('');
    out.plain('  Recording. Press ctrl-C when the agent is done.');

    options.onReady?.({ proxyUrl, runId: writer.runId });
    await (options.until ?? firstInterrupt());
  } finally {
    await proxy.close();
    await writes.drain().catch(() => writer.markCaptureIncomplete('storage_failure'));
    await tls.ca?.dispose();
  }

  /**
   * The same warning a launched run gets, and it matters more here. A remote agent that was never
   * given the block — or was given it in a shell that had already started the agent — produces a
   * session that ends cleanly and records nothing, and there is no exit code to hint at it.
   */
  if (modelExchanges === 0) {
    out.warn('capture.empty', {
      exchanges: 0,
      cause: 'nothing connected to the proxy while the session was open',
      next: 'check the sandbox can reach the advertised address, and that the exports were set',
    });
  }

  writer.setCaptureSummary({
    status: terminalAttempts > 0 && terminalAttempts === attempts.size ? 'complete' : 'incomplete',
    issues:
      terminalAttempts === 0
        ? ['no_requests_observed']
        : terminalAttempts !== attempts.size
          ? ['unfinalized_request']
          : [],
    requests: attempts.size,
    responses: terminalAttempts,
  });
  // The other half of the bracket. `close` seals the manifest; it does not write the event.
  await writer.append({
    type: 'run.end',
    actor: 'agenticreplay',
    turn,
    attrs: { exchanges: modelExchanges },
  });
  const manifest = await writer.close(0);
  out.info('recorded', {
    run: writer.runId,
    events: manifest.counts?.events ?? 0,
    exchanges: modelExchanges,
    dir: writer.runDir,
  });

  return {
    runId: writer.runId,
    runDir: writer.runDir,
    modelExchanges,
    events: manifest.counts?.events ?? 0,
    // The address the agent should use, not the one agenticreplay bound — a caller reading this from
    // `--json` needs something it can connect to, which a wildcard bind is not.
    proxyUrl: advertised,
    exitCode: manifest.capture?.status === 'incomplete' ? 2 : 0,
  };
}

/** Ctrl-C, which is the only way an operator ends a session with no child process to wait on. */
async function firstInterrupt(): Promise<void> {
  await once(process, 'SIGINT');
}
