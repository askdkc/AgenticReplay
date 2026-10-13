import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TraceWriter } from '@agenticreplay/core';
import {
  DEFAULT_MAX_CAPTURED_BYTES,
  HostPolicy,
  RunCa,
  resolveTlsHosts,
  type InterceptFailure,
  type NetExchange,
  type NetRequest,
  type TlsInterceptInfo,
  type TunnelRecord,
} from '@agenticreplay/proxy';
import type { ParsedArgs } from './args.js';
import type { Output } from './out.js';
import type { SerialQueue } from './serial.js';
import { captureLimits } from './capture-limits.js';

/**
 * TLS interception, shared by every command that runs an agent live.
 *
 * This lived inside `agenticreplay record` and nowhere else, which made `--tls-intercept` a flag the parser
 * accepted and `agenticreplay replay --model`, `agenticreplay fork` and `agenticreplay compare` silently discarded — the three
 * commands that also launch a real agent, and so the three where a harness talking to its own
 * backend over TLS is just as invisible. A flag that is accepted and ignored is worse than one that
 * is rejected: the operator believes they captured the traffic.
 *
 * Everything that can be rejected is rejected before anything is minted, so a run that is not going
 * to happen — `--tls-hosts '*'`, an unreadable `AGENTICREPLAY_TLS_UPSTREAM_CA` — leaves no private key on
 * disk at all. The caller owns the CA's lifetime and must dispose it on every exit path.
 */

export interface TlsCaptureRequest {
  args: ParsedArgs;
  out: Output;
  writer?: TraceWriter;
  /** Used by an exact replay running with --no-trace, where there is no writer to own the CA. */
  runDir?: string;
  writes: SerialQueue;
  /**
   * Snapshot the current turn at request start. The request ID retains that assignment through
   * concurrent completion. Tunnel-only evidence has no HTTP request and uses its observation time.
   */
  turn: () => number;
  /**
   * Shared with the plaintext passthrough route, so one path is warned about once however it
   * arrived and the run's own diagnosis can name every one of them. Left out, interception keeps
   * its own tally as before.
   */
  unclaimed?: UnclaimedPaths;
  onRequestStart?: (request: NetRequest) => Promise<void>;
  onNetExchange?: (exchange: NetExchange) => void;
}

export interface TlsCapture {
  /** The CA, present only when interception was asked for. The caller disposes it. */
  ca?: RunCa;
  /** Spread into `createProxy()`. Empty when interception was not asked for. */
  proxyOptions: Record<string, unknown>;
}

/**
 * Everything `setupTlsCapture` can refuse, without creating anything.
 *
 * A caller that has a trace directory to lose needs the refusal to happen first: a run abandoned
 * by a throw leaves an unsealed directory behind, and an unsealed directory wins `last`. An exact
 * replay has more than that to lose — it calls this before `replayWorkspace`, which writes the
 * recording over the operator's checkout.
 *
 * `extraOriginRoots` is here for the second reason and not the first. It reads files, so it was
 * left out of a function whose whole point was to decide from the arguments alone — but that made
 * this only *most* of what `setupTlsCapture` refuses, and an unreadable `AGENTICREPLAY_TLS_UPSTREAM_CA`
 * went on failing late, past the restore. The roots are read again below, microseconds later and
 * on a path the run was going to read anyway.
 */
export async function planTlsCapture(args: ParsedArgs): Promise<void> {
  captureLimits(args);
  if (!args.bool('tls-intercept')) return;
  HostPolicy.from([...resolveTlsHosts(args.list('tls-hosts'))]);
  await extraOriginRoots();
}

export async function setupTlsCapture(req: TlsCaptureRequest): Promise<TlsCapture> {
  const { args, out, writer, writes } = req;

  const tlsHosts = args.list('tls-hosts');
  const interceptTls = args.bool('tls-intercept');

  // Naming hosts without asking for interception captures nothing and says nothing, which reads
  // as "agenticreplay ignored my traffic" rather than as "agenticreplay ignored my flag".
  if (!interceptTls && tlsHosts.length > 0) {
    out.warn('tls.hosts_ignored', { hosts: tlsHosts.join(','), next: 'add --tls-intercept' });
  }
  const limits = captureLimits(args);
  if (!interceptTls) return { proxyOptions: limits };

  // Resolved before anything is minted, so a contradictory list — one that both replaces the
  // defaults and adds to them — fails while the run directory still holds no private key.
  const hosts = resolveTlsHosts(tlsHosts);
  HostPolicy.from([...hosts]);
  const trustedOriginCerts = await extraOriginRoots();
  const runDir = writer?.runDir ?? req.runDir;
  if (!runDir) throw new Error('TLS interception needs a run directory');
  const ca = await RunCa.create({ runDir });

  // One line per path, not per call: an agent that posts to the same endpoint every turn would
  // otherwise bury the run in a warning the operator already read.
  const unclaimed = req.unclaimed ?? new UnclaimedPaths(limits.maxCapturedBytes);
  const requestTurns = new Map<string, number>();

  return {
    ca,
    proxyOptions: {
      ...limits,
      tls: {
        ...limits,
        ca,
        hosts: [...hosts],
        trustedOriginCerts,
        onRequestStart: async (request: NetRequest) => {
          if (req.onRequestStart) return req.onRequestStart(request);
          const turn = req.turn();
          requestTurns.set(request.requestId, turn);
          if (writer) await persistNetRequestStart(writer, turn, request);
        },
        onNetExchange: (exchange: NetExchange) => {
          if (req.onNetExchange) return req.onNetExchange(exchange);
          unclaimed.note(out, exchange);
          const turn = requestTurns.get(exchange.requestId) ?? req.turn();
          requestTurns.delete(exchange.requestId);
          if (writer) writes.push(() => persistNetExchange(writer, turn, exchange));
        },
        onTunnel: (tunnel: TunnelRecord) => {
          if (writer) writes.push(() => persistTunnel(writer, req.turn(), tunnel));
        },
        onFailure: (failure: InterceptFailure) => {
          writer?.markCaptureIncomplete('transport_interception_failed');
          if (writer)
            writes.push(async () => {
              await writer.append({
                type: 'note',
                actor: 'agenticreplay',
                turn: req.turn(),
                attrs: { rule: 'transport_interception_failed', ...failure },
              });
            });
          reportInterceptFailure(out, failure);
        },
      },
    },
  };
}

export async function persistNetRequestStart(
  writer: TraceWriter,
  turn: number,
  request: NetRequest,
): Promise<void> {
  await writer.append({
    type: 'net.request',
    actor: 'agent',
    turn,
    occurredAt: new Date(request.requestStartedAt),
    attrs: {
      phase: 'start',
      request_id: request.requestId,
      boundary: 'tls-intercept',
      host: request.host,
      port: request.port,
      method: request.method,
      path: request.path,
      headers: request.requestHeaders,
      bytes: request.requestBytes.byteLength,
      truncated: request.requestTruncated,
    },
  });
}

/**
 * The paths a run forwarded but could not interpret, warned about once each.
 *
 * Two callers, which is the point. Interception has reported this since it shipped; the ordinary
 * plaintext route — a harness redirected by a base-URL variable, posting to an endpoint no
 * dialect claims — reported nothing at all, and that is the commoner case by far. A retrieval
 * pipeline is entirely made of it: `/v1/embeddings` is not a model exchange, so a run that
 * captured every embedding call it made printed `capture.empty exchanges=0` and sent the operator
 * to check a base-URL variable that was set correctly all along.
 *
 * It also keeps the list, because the diagnosis at the end of the run needs to name the paths
 * rather than describe them.
 */
export class UnclaimedPaths {
  readonly #reported = new Set<string>();
  readonly #paths = new Set<string>();
  constructor(private readonly bodyLimit = DEFAULT_MAX_CAPTURED_BYTES) {}

  /** Warn about this exchange if it is the first on its path, and remember the path. */
  note(out: Output, exchange: NetExchange): void {
    warnUnclaimed(out, this.#reported, this.#paths, exchange, this.bodyLimit);
  }

  /** The distinct paths seen, in the order they were first seen. */
  list(): string[] {
    return [...this.#paths];
  }

  get size(): number {
    return this.#paths.size;
  }
}

/**
 * A call that looked like a model request and was not understood.
 *
 * Traffic on a path no dialect claims is recorded as `net.*`: agenticreplay holds the bytes but not their
 * meaning, so it can neither match the request on replay nor rewrite its model on a fork. Strict
 * replay says so plainly — and says it one command too late, after the agent has finished and the
 * chance to record the run properly has gone. This is the same fact, delivered while it is still
 * actionable.
 *
 * Deliberately narrow. A GET, or a POST whose body is not JSON, is ordinary traffic that was never
 * a model call, and warning about it would teach the operator to ignore the warning that matters.
 */
function warnUnclaimed(
  out: Output,
  reported: Set<string>,
  paths: Set<string>,
  exchange: NetExchange,
  bodyLimit: number,
): void {
  if (exchange.method !== 'POST') return;
  // A retrieval rule claimed it, so every word of the warning below is false about this call: it
  // is not unclaimed, it does replay, and there is no dialect to go and write. Recording an
  // index build printed one of these per endpoint and told the operator the run could not be
  // reproduced, at the moment agenticreplay had just made sure it could.
  if (exchange.modelDialect !== undefined) return;
  // No response ever arrived, so this one is not evidence that a path went unrecognised. It is
  // kept as network traffic because an exchange with nothing to replay cannot be a model exchange
  // whatever dialect exists -- and telling the operator to write one would not change that. A
  // harness that opens a call and leaves would otherwise print this on every turn.
  if (exchange.status === 0) return;
  const body = exchange.requestBody.trim();
  if (!body.startsWith('{')) return;
  // A truncated body cannot parse — it was cut mid-JSON at the capture limit. Requiring a parse
  // would suppress the warning for exactly the requests it exists for, since a long conversation
  // is the one most likely to exceed the limit and the most expensive to have to record again.
  if (!exchange.requestTruncated) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null) return;
    } catch {
      // A body agenticreplay could not even parse is not a model call it failed to recognise.
      return;
    }
  }

  const path = exchange.path.split('?')[0] ?? exchange.path;
  const key = `${exchange.host}:${exchange.port}${path}`;
  if (reported.has(key)) return;
  reported.add(key);
  paths.add(path);

  // A body cut mid-JSON at the capture limit is a different fact from a path nobody claims, and
  // the advice differs with it: no dialect can read a truncated body, so writing one changes
  // nothing. Driving a 1.2 MiB request through an intercepted host printed the wrong one of these
  // -- `no wire dialect claims this path`, about a path the openai dialect had claimed all along.
  // `tls.` only where TLS was actually terminated. The same fact reached by the plaintext route
  // is not a fact about TLS, and a rule named for a mechanism that was not used sends the reader
  // looking for an interception they never turned on.
  const rule = exchange.intercepted === false ? 'proxy' : 'tls';
  if (exchange.requestTruncated) {
    out.warn(`${rule}.request_too_large`, {
      host: exchange.host,
      path: exchange.path,
      limit_bytes: bodyLimit,
      detail: 'the request body was cut at the capture limit, so no dialect could read it',
      consequence: 'capture is incomplete; the omitted body is not eligible for replay',
      next: 'increase --max-body-bytes and record again',
    });
    return;
  }

  out.warn(`${rule}.unclaimed_path`, {
    host: exchange.host,
    path: exchange.path,
    detail:
      exchange.intercepted === false
        ? 'forwarded and recorded, but no wire dialect claims this path'
        : 'decrypted and recorded, but no wire dialect claims this path',
    consequence: 'it replays as opaque network traffic and cannot be forked to another model',
    next: 'docs/plugins.md to add a dialect for it',
  });
}

/**
 * What the launched agent needs in its environment to be intercepted, and the disclosure the
 * operator needs before it happens.
 *
 * Lived in `agenticreplay record` alongside the setup, so a fork that minted a CA would have decrypted
 * nothing: the child was never pointed at the proxy and never told to trust the root. Interception
 * is only two halves working together, so both halves belong in one place.
 */
export async function trustRunCa(
  writer: TraceWriter | undefined,
  proxyTls: TlsInterceptInfo,
  proxyUrl: string,
  env: Record<string, string>,
  out: Output,
): Promise<void> {
  // The child trusts the run CA through its own environment and through nothing else. Nothing here
  // touches a system or browser trust store, and agenticreplay will not offer to: interception ends when
  // this process does, which is the property that makes it defensible at all.
  env.HTTPS_PROXY = proxyUrl;
  env.https_proxy = proxyUrl;
  // NODE_EXTRA_CA_CERTS *adds* to Node's trust store. The rest of these *replace* an OpenSSL
  // client's store outright, so they get the bundle — the run CA plus the public roots — or the
  // child would lose its ability to reach every host agenticreplay deliberately does not intercept.
  env.NODE_EXTRA_CA_CERTS = proxyTls.caCertPath;
  // Python OS truststore clients may ignore SSL_CERT_FILE. The process-local bootstrap
  // adds this CA to their contexts while retaining platform roots and verification.
  env.AGENTICREPLAY_TLS_CA = proxyTls.caCertPath;
  for (const variable of [
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'AWS_CA_BUNDLE',
    'DENO_CERT',
  ]) {
    env[variable] = proxyTls.caBundlePath;
  }
  // The agent also talks to the recording proxy directly over plain HTTP via the base-URL
  // variables. Sending those through the proxy as well would be a loop.
  const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const noProxy = [existing, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  out.warn('tls.intercepting', {
    hosts: proxyTls.hosts,
    ca_sha256: proxyTls.fingerprint,
    ca_dir: dirname(proxyTls.caCertPath),
  });
  out.plain('  TLS interception is on for this run. Traffic to the hosts above is decrypted,');
  out.plain('  recorded and re-encrypted; everything else is tunnelled unread. The certificate');
  out.plain(
    '  authority is unique to this run, trusted only by the agent agenticreplay launches, and',
  );
  out.plain('  deleted when the run ends. It is not installed anywhere.');

  // A digest, never the certificate and never the key. The CA is deleted when the run ends, so
  // this line is the only lasting evidence of which authority signed what — enough to match a
  // certificate someone finds later to the run that minted it, and useless for anything else.
  if (writer) {
    await writer.append({
      type: 'note',
      actor: 'agenticreplay',
      turn: 0,
      attrs: {
        rule: 'tls_intercept',
        hosts: proxyTls.hosts,
        ca_sha256: proxyTls.fingerprint,
        python_trust: 'process-local truststore CA addition; verification remains enabled',
      },
    });
  }
}

/**
 * One decrypted HTTP exchange agenticreplay did not recognise as a model call.
 *
 * `net.request` / `net.response` have been in the spec since v0 and nothing has ever emitted them;
 * this is what makes them real. The pair is deliberately shaped like `model.request` /
 * `model.response` so the timeline reads the same either way.
 */
export async function persistNetExchange(
  writer: TraceWriter,
  turn: number,
  exchange: NetExchange,
): Promise<void> {
  const failedBeforeHeaders =
    exchange.status === 0 && Boolean(exchange.responseError) && exchange.responseBytes === 0;
  const incomplete =
    exchange.requestTruncated ||
    exchange.responseTruncated ||
    (!exchange.responseComplete && !failedBeforeHeaders) ||
    Boolean(exchange.abandoned);
  if (incomplete) writer.markCaptureIncomplete('incomplete_transport_body');
  const requestChanges = (exchange.transformations ?? []).filter((t) =>
    t.location.startsWith('request'),
  );
  const responseChanges = (exchange.transformations ?? []).filter((t) =>
    t.location.startsWith('response'),
  );
  const request = await writer.append({
    type: 'net.request',
    // The agent made the call. No actor names "some server on the internet", so the reply is
    // attributed to agenticreplay, which is the only party that witnessed it.
    actor: 'agent',
    turn,
    occurredAt: new Date(exchange.requestStartedAt),
    attrs: {
      phase: 'body',
      request_id: exchange.requestId,
      boundary: exchange.intercepted === false ? 'http-proxy' : 'tls-proxy',
      capture_incomplete: exchange.requestTruncated,
      host: exchange.host,
      port: exchange.port,
      method: exchange.method,
      path: exchange.path,
      ...(exchange.alpn === undefined ? {} : { alpn: exchange.alpn }),
      // Absent means intercepted — every exchange the interceptor produces. The proxy's plaintext
      // passthrough says so explicitly, because it decrypted nothing.
      intercepted: exchange.intercepted ?? true,
      ...(exchange.modelDialect === undefined ? {} : { model_dialect: exchange.modelDialect }),
      headers: exchange.requestHeaders,
      bytes: exchange.requestBytes,
      truncated: exchange.requestTruncated,
    },
    ...(exchange.requestTruncated
      ? {
          transformations: [
            ...requestChanges,
            {
              kind: 'omission' as const,
              location: 'request.body',
              rule: 'capture_limit',
              count: 1,
              reason: 'body exceeds capture resource limit',
            },
          ],
        }
      : { payload: exchange.requestBody, transformations: requestChanges }),
  });
  await writer.append({
    type: 'net.response',
    actor: 'agenticreplay',
    turn,
    causes: [request.seq],
    attrs: {
      request_id: exchange.requestId,
      capture_incomplete: incomplete,
      response_complete: exchange.responseComplete,
      transport_outcome: exchange.abandoned
        ? 'client_aborted'
        : exchange.responseError
          ? 'origin_error'
          : 'completed',
      ...(exchange.responseError ? { error: exchange.responseError } : {}),
      host: exchange.host,
      port: exchange.port,
      status: exchange.status,
      intercepted: exchange.intercepted ?? true,
      headers: exchange.responseHeaders,
      bytes: exchange.responseBytes,
      // What agenticreplay decompressed, next to the header set that no longer describes it. `bytes` is
      // still the wire count, so the two together say how much the encoding was worth.
      ...(exchange.responseDecodedFrom === undefined
        ? {}
        : { decoded_from: exchange.responseDecodedFrom }),
      truncated: exchange.responseTruncated,
      // Only when it happened, so a normal exchange carries no field saying it was normal. It
      // reads differently from `truncated`: the agent stopped reading, agenticreplay did not stop keeping.
      ...(exchange.abandoned ? { abandoned: true } : {}),
      duration_ms: exchange.durationMs,
    },
    ...(exchange.responseTruncated
      ? {
          transformations: [
            ...responseChanges,
            {
              kind: 'omission' as const,
              location: 'response.body',
              rule: 'capture_limit',
              count: 1,
              reason: 'body exceeds capture resource limit',
            },
          ],
        }
      : { payload: exchange.responseBody, transformations: responseChanges }),
  });
}

/**
 * A connection agenticreplay refused to decrypt.
 *
 * Recorded because the refusal is itself the evidence — and because an operator whose harness talks
 * to an endpoint nobody predicted finds it here, in a line naming the host and nothing else, rather
 * than by guessing. No path, no headers, no payload: there is nothing to write, because agenticreplay never
 * held the plaintext.
 */
async function persistTunnel(
  writer: TraceWriter,
  turn: number,
  tunnel: TunnelRecord,
): Promise<void> {
  writer.markCaptureIncomplete('unobserved_tunnel_body');
  const request = await writer.append({
    type: 'net.request',
    actor: 'agent',
    turn,
    attrs: {
      host: tunnel.host,
      port: tunnel.port,
      intercepted: false,
      reason: 'host not in the TLS interception allowlist',
      capture_incomplete: true,
    },
    transformations: [
      {
        kind: 'omission',
        location: 'request.body',
        rule: 'unsupported_transport',
        count: 1,
        reason: 'TLS tunnel was forwarded without body interception',
      },
    ],
  });
  await writer.append({
    type: 'net.response',
    actor: 'agenticreplay',
    turn,
    causes: [request.seq],
    attrs: {
      host: tunnel.host,
      port: tunnel.port,
      intercepted: false,
      bytes_to_origin: tunnel.bytesToOrigin,
      bytes_to_client: tunnel.bytesToClient,
      duration_ms: tunnel.durationMs,
      ...(tunnel.error === undefined ? {} : { error: tunnel.error }),
    },
  });
}

/**
 * Extra roots to trust when connecting onward to the real origin.
 *
 * An intercepting proxy terminates TLS, so it also has to make the outbound connection itself. In a
 * corporate environment that connection goes through another intercepting proxy whose root Node
 * does not ship, and the run fails at the first request with an opaque certificate error.
 */
async function extraOriginRoots(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = env.AGENTICREPLAY_TLS_UPSTREAM_CA;
  if (!configured) return [];
  const roots: string[] = [];
  for (const path of configured
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    roots.push(await readFile(path, 'utf8'));
  }
  return roots;
}

/**
 * ONE EVENT NAME PER THING THAT ACTUALLY HAPPENED.
 *
 * `tls.handshake_failed` was every failure interception could produce — a body that would not
 * decompress, a WebSocket upgrade declined, an h2 stream faulting, and, buried among them, the one
 * an operator most needs to recognise: the client refusing OUR certificate.
 *
 * That last one is why the name mattered. It is reported on the client side of the proxy, but
 * "handshake failed" with an `h2 session:` prefix reads as a problem between agenticreplay and the origin —
 * so the operator goes looking at the network, the upstream, the proxy variables. The fix is on the
 * other side of the connection entirely: the run CA is not in the agent's trust store. Meanwhile
 * nothing from that host is recorded, and the trace looks merely quiet rather than broken.
 *
 * The name is what people grep and alert on, so it is the name that has to be true.
 */
export function reportInterceptFailure(out: Output, failure: InterceptFailure): void {
  const { kind, ...fields } = failure;
  switch (kind) {
    case 'client_handshake':
      out.warn('tls.handshake_failed', {
        ...fields,
        cause:
          'the agent refused the certificate agenticreplay presented — this run’s CA is not in its trust store',
        effect: `nothing from ${failure.host} is being recorded; the trace will simply be missing it`,
        next: 'trust the run CA in the agent: NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, SSL_CERT_FILE, or the language runtime’s own store — `agenticreplay record --tls-intercept` prints the path',
      });
      return;
    case 'upstream_session':
      out.warn('tls.upstream_failed', {
        ...fields,
        cause: 'agenticreplay could not establish or keep the TLS session to the origin',
        next: 'check the host is reachable from this machine, and that any corporate root it needs is in AGENTICREPLAY_TLS_UPSTREAM_CA',
      });
      return;
    case 'body_opaque':
      // Not a failure of the connection at all: the exchange is recorded, the body just could not
      // be decoded, so it is kept as it arrived. Saying "handshake" here sent people to the wrong
      // layer for something that lost no data.
      out.warn('net.body_opaque', {
        ...fields,
        effect: 'the exchange is recorded; this body is kept as it arrived rather than decoded',
      });
      return;
    case 'upgrade_refused':
      out.warn('net.upgrade_refused', {
        ...fields,
        next: 'take the host off --tls-hosts so the whole connection is tunnelled untouched',
      });
      return;
    case 'session':
      out.warn('tls.session_error', fields);
      return;
  }
}
