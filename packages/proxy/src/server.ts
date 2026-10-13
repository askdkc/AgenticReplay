import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AUTH_REQUEST_HEADERS,
  AUTH_RESPONSE_HEADERS,
  BINARY_BODY_PREFIX,
  Redactor,
  fetchPinned,
} from '@agenticreplay/core';
import type {
  CanonicalRequest,
  CanonicalResponse,
  Usage,
} from '@agenticreplay/plugin-api';
import type { CaptureTransformation } from '@agenticreplay/schema';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  openaiToCanonicalRequest,
  openaiToCanonicalResponse,
  parseAnthropicSse,
  parseOpenaiSse,
  parseResponsesSse,
  responsesToCanonicalRequest,
  responsesToCanonicalResponse,
} from '@agenticreplay/providers';
import {
  anthropicDialect,
  codexDialect,
  openaiDialect,
  responsesDialect,
  selectDialect,
  type Dialect,
} from './dialects.js';
import { decodeForwardPath, type ForwardPath } from './forward.js';
import {
  attachTlsIntercept,
  decodeBody,
  DEFAULT_MAX_CAPTURED_BYTES,
  type NetExchange,
  type NetRequest,
  type TlsInterceptOptions,
} from './intercept.js';

export type {
  InterceptFailure,
  NetExchange,
  NetRequest,
  TlsInterceptOptions,
  TunnelRecord,
} from './intercept.js';

function scalarHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function captureHeaderTransformations(
  original: Record<string, string | string[]>,
  recorded: Record<string, string | string[]>,
): CaptureTransformation[] {
  const excluded = Object.keys(original).filter((name) => !(name in recorded));
  if (excluded.length === 0) return [];
  return [
    {
      kind: 'header_excluded',
      location: 'request.headers',
      rule: 'authentication-and-hop-by-hop-header-exclusion',
      count: excluded.length,
      reason: excluded
        .map((name) => name.toLowerCase())
        .sort()
        .join(', '),
    },
  ];
}

function captureResponseHeaders(headers: Headers, decoded = false): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (AUTH_RESPONSE_HEADERS.includes(key)) return;
    if (decoded && (key === 'content-encoding' || key === 'content-length')) return;
    result[key] = value;
  });
  return result;
}

function captureResponseHeaderTransformations(headers: Headers): CaptureTransformation[] {
  const excluded: string[] = [];
  headers.forEach((_value, name) => {
    if (AUTH_RESPONSE_HEADERS.includes(name.toLowerCase())) excluded.push(name.toLowerCase());
  });
  return [
    ...(excluded.length === 0
      ? []
      : [
          {
            kind: 'header_excluded' as const,
            location: 'response.headers',
            rule: 'authentication-header-exclusion',
            count: excluded.length,
            reason: [...new Set(excluded)].sort().join(', '),
          },
        ]),
    {
      kind: 'encoding' as const,
      location: 'response.headers',
      rule: 'fetch-headers-boundary-normalization',
      count: 1,
      reason: 'fetch Headers lowercases names and combines repeated fields before capture',
    },
  ];
}

function captureEncodingTransformation(
  location: string,
  encoding: string | undefined,
): CaptureTransformation[] {
  const values = (encoding ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '' && value !== 'identity');
  if (values.length === 0) return [];
  return [
    {
      kind: 'decompression',
      location,
      rule: 'content-encoding',
      count: values.length,
      reason: values.join(', '),
    },
  ];
}

function captureUrlTransformations(origin: string): CaptureTransformation[] {
  const scrubbed = recordableOrigin(origin);
  if (scrubbed === undefined || scrubbed === origin) return [];
  return [
    {
      kind: 'url_scrubbed',
      location: 'destination.url',
      rule: 'credential-and-query-secret-scrub',
      count: 1,
      reason: 'destination credentials or secret query parameters removed before persistence',
    },
  ];
}

function binaryBodyTransformation(location: string, body: string): CaptureTransformation[] {
  if (!body.startsWith(BINARY_BODY_PREFIX)) return [];
  return [
    {
      kind: 'encoding',
      location,
      rule: 'binary-body-base64-persistence',
      count: 1,
      reason: 'invalid UTF-8 preserved as base64 because the transport body is binary',
    },
  ];
}

/**
 * An origin with the parts a credential rides in taken out.
 *
 * `agenticreplay setup --gateway` accepts whatever URL it is handed and stores it in `~/.agenticreplay/config.json`,
 * and a gateway that authenticates by URL rather than by header is handed one that carries the key:
 * `https://user:pw@gw.example` or `https://gw.example?key=…`. The proxy has to *send* that — it is
 * how the request authenticates — but recording it verbatim would have written the key into every
 * trace made on that machine, breaking the promise stated where the key is read:
 *
 *   > the proxy adds it to the outbound request only, while what gets recorded is derived from the
 *   > *incoming* request with auth stripped, so a gateway key agenticreplay injects is invisible to the
 *   > recording by construction rather than by a rule someone has to remember.
 *
 * So the stripping happens here, in the one place an exchange is built, rather than at each call
 * site — for the same reason that sentence gives.
 *
 * The path is kept. It is not a credential, and it is load-bearing: a gateway serving tenants at
 * `/team-a/v1` and `/team-b/v1` answers from two different places, and the exchange's own `path`
 * is the *client's* (`/chat/completions`), not the upstream's base. Only userinfo, query and
 * fragment come out.
 *
 * An origin that will not parse is dropped rather than passed through: it cannot be sanitised, and
 * absent already means "not recorded".
 */
export function recordableOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    const url = new URL(origin);
    const port = url.port === '' ? '' : `:${url.port}`;
    // `new URL('https://h').pathname` is '/', which is not part of how anyone writes an origin.
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.protocol}//${url.hostname}${port}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Why a string cannot be used as an origin at all, or nothing if it can.
 *
 * Narrower than it first was, because the first version refused configurations that work. A
 * gateway that authenticates by query — `https://gw.example/v1?key=…` — is an ordinary way to
 * configure one, and undici sends it without complaint; refusing it broke a working setup to close
 * a leak that was never about sending. Userinfo is the same story one step along: undici does
 * reject `https://u:pw@gw` at request time, but it is *sanitisable* — {@link recordableOrigin}
 * removes it cleanly — and the recording path already accepts it and keeps it out of the trace.
 *
 * What is left is the case where there is nothing to sanitise, because there is no origin. A
 * gateway typed without a scheme parses with the username as the protocol:
 *
 *     new URL('myuser:PASSWORD@gw.example/v1')   // protocol 'myuser:', pathname the rest
 *
 * so {@link recordableOrigin} answers `myuser://PASSWORD@gw.example/v1` — a value, which means a
 * caller guarding with `?? url` never notices, and the password is on the line anyway. There is no
 * fixing that by rewriting: with no scheme there is no telling which half of `a:b` was meant as
 * the host. And nothing refused here could have worked — undici cannot parse it either.
 */
export function unusableOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'it is not a URL — an origin needs a scheme, like https://gateway.example';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // Named without echoing the value: a scheme-less URL puts the username here, so `protocol` is
    // the one part of it that is safe to quote back.
    return `its scheme is "${url.protocol.replace(/:$/, '')}" — an origin has to be http or https`;
  }
  return undefined;
}

/**
 * Free text with the credential taken out of any URL it names.
 *
 * For error messages, which nobody composes and everybody prints. A failed `fetch` reports the URL
 * it was given, so an origin configured as `https://user:pw@gw` or `https://gw?key=…` arrives
 * inside the exception text and goes straight to a terminal:
 *
 *     warn gateway.unreachable why="Request cannot be constructed from a URL that includes
 *       credentials: http://someone:PASSWORD@127.0.0.1:50164/v1/models"
 *
 * {@link recordableOrigin} cannot help there — it takes a URL, and this is prose with a URL in it.
 *
 * The query goes as well as the userinfo. That loses the occasional harmless parameter from an
 * error message, which is the right trade: a key in a query is the commonest way a gateway
 * authenticates by URL, and an error string is not where anyone should be reading parameters back.
 */
export function withoutCredentials(text: string): string {
  return (
    text
      // Up to the *last* `@` before the path, not the first. `[^/\s@]*` could not cross an `@`, so
      // an ordinary password containing one — `p@ssw0rd` — ended the match early and the remainder
      // stayed in userinfo position: `https://myuser:p@ssw0rd@gw` came out as `https://ssw0rd@gw`.
      // `[^\s/]*` may cross `@` and backtracks to the last one, and still cannot reach past the
      // path, so an `@` in a path segment (`/v1/@scope/pkg`) is not mistaken for userinfo.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1')
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)\?[^\s#"']*/gi, '$1')
      // And once more without a scheme. undici reports an origin it could not parse verbatim —
      // `Failed to parse URL from my.gateway.example?key=…` — and both rules above need a
      // `scheme://` to fire, so that string went through untouched into the 500 body the agent
      // prints. A host-shaped token is one with a dot in it and no whitespace. The cost is that
      // an error naming a file ending in '?' loses the question mark, which is a fair price in
      // prose nobody reads for punctuation.
      .replace(/([a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*(?::\d+)?[^\s?#"']*)\?[^\s#"']*/gi, '$1')
  );
}

/**
 * An origin agenticreplay could not parse, reduced to the host it names and nothing else.
 *
 * Three rounds of review here, each finding a shape the last one let through, and the lesson is
 * the same each time: a string no parser accepted has no structure to rely on, so nothing may be
 * kept because of where it sits — only because of what it is made of.
 *
 * `withoutCredentials` went first. It is written for prose and its rules need prose shapes: a
 * dotted host for the scheme-less query rule, no whitespace inside userinfo. `gw?key=SECRET123`,
 * `localhost?key=…`, `192.168.0.1?key=…` and `https://user:pa ss@gw` all went through it whole.
 *
 * Cutting by position went second, and left `https://gw key=SECRET123`: a secret in a
 * whitespace-separated token after the host is still "after the last `@`", so it was kept as part
 * of the host.
 *
 * So the last step is a whitelist — the characters a host and a port are made of, and the first
 * one that is not ends it. A path is not returned at all: the success branch of `originParts`
 * gives `url.hostname`, the exchange records its request path in its own field, and a path that
 * reached here unparsed could carry a secret as easily as a query could.
 *
 * An origin with no host left — `https://user:pass@` — yields the empty string, which is the
 * honest answer: there was no host in it to name.
 *
 * `redactString` still runs over the result at the call site, as a backstop for a long key rather
 * than the thing doing the work: its shape rules and 20-character entropy floor catch neither
 * `hunter2` nor `SECRET123`.
 */
export function scrubOrigin(origin: string): string {
  const withoutQuery = origin.replace(/[?#][\s\S]*$/, '');
  const schemeEnd = withoutQuery.indexOf('://');
  const rest = schemeEnd === -1 ? withoutQuery : withoutQuery.slice(schemeEnd + 3);
  const pathStart = rest.indexOf('/');
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  // A host, then a port only if it is one. Allowing a bare `:` for the port let a whole
  // `user:password` through when the origin had no `@` to cut at — `https://myuser:hunter2`
  // came back whole — because userinfo and host:port are the same shape until something
  // says which it is. Digits after the colon say it. An IPv6 literal keeps its brackets,
  // which is what separates its colons from that one.
  return /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]+)?/.exec(host)?.[0] ?? '';
}

export interface RecordedExchange {
  seq: number;
  requestId?: string;
  requestStartedAt?: number;
  dialect: string;
  path: string;
  /** Verbatim request body. Keeping it is what makes exact replay exact. */
  rawRequest: string;
  /** Verbatim response body, SSE included. */
  rawResponse: string;
  status: number;
  streamed: boolean;
  canonicalRequest: CanonicalRequest;
  canonicalResponse?: CanonicalResponse;
  usage?: Usage;
  requestHeaders?: Record<string, string>;
  /**
   * Which application protocol carried it: `h2`, `http/1.1`, or absent where agenticreplay did not
   * establish the connection itself and so cannot say. Only interception knows this -- the
   * base-URL route hands the call to `fetch`, which chooses for itself and does not report back.
   */
  alpn?: string;
  /**
   * The `content-encoding` agenticreplay decoded away before recording the response, when there was one.
   * Interception only, for the same reason: on the base-URL route the HTTP client decompresses
   * before agenticreplay sees a body, so there is nothing agenticreplay could truthfully claim to have removed.
   */
  responseDecodedFrom?: string;
  /**
   * The origin that actually answered this call.
   *
   * A run's destination is not one value that could live in the manifest: the origin is chosen per
   * request, from an explicit `--upstream-*`, the gateway `agenticreplay setup` configured, a `/forward/`
   * base the client announced, or the dialect's vendor default — and a fork that changes provider
   * changes it again mid-run. So it is recorded where it is decided, once per exchange.
   *
   * The trace could say what was sent and what came back but not who answered it, which is the
   * question asked first when a recording looks wrong: a gateway left over in `~/.agenticreplay/config.json`
   * redirects every run on the machine, and nothing in the run said so.
   */
  upstream?: string;
  durationMs?: number;
}

export interface ProxyOptions {
  upstream?: Record<string, string>;
  dialects?: Dialect[];
  onExchange?: (e: RecordedExchange) => void;
  onRequestStart?: (request: NetRequest) => void | Promise<void>;
  maxCapturedBytes?: number;
  maxBufferedBytes?: number;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
  upstreamHeaders?: Record<string, string>;
  upstreamHeadersOrigin?: string;
  passthroughUpstream?: string;
  onNetExchange?: (e: NetExchange) => void;
  tls?: TlsInterceptOptions;
}

export interface ProxyStats {
  liveCalls: number;
  intercepted: number;
  tunnelled: number;
  passedThrough: number;
}

export interface TlsInterceptInfo {
  /** The hosts that will be decrypted, as written. */
  hosts: string;
  /** SHA-256 of the run CA, so the certificate on disk can be matched to this run. */
  fingerprint: string;
  caCertPath: string;
  /** The run CA plus the system roots, for clients whose trust variable replaces the store. */
  caBundlePath: string;
}

export interface ProxyHandle {
  url: string;
  port: number;
  stats(): ProxyStats;
  exchanges(): RecordedExchange[];
  /** Present only when TLS interception is on. */
  tls?: TlsInterceptInfo;
  close: () => Promise<void>;
}

/**
 * Hop-by-hop headers, dropped before forwarding because they describe *this* connection.
 *
 * The full RFC 7230 §6.1 set, plus `host` and `accept-encoding`, which describe this hop for the
 * same reason. `transfer-encoding` is the one that was missing and the one that bites: an SDK
 * that hands `fetch` a `Request` — or any stream body — sends `transfer-encoding: chunked` and no
 * `content-length`, and agenticreplay then copied that header onto an outbound call whose body it had
 * already buffered. undici refuses the contradiction, so the agent got
 * `500 {"error":{"message":"TypeError: fetch failed"}}` on every such turn, with nothing in the
 * message pointing at a header, at agenticreplay, or at the agent.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
]);

/**
 * Auth material. Forwarded upstream — an agent that cannot authenticate is an agent that cannot
 * run — but never written into a trace. Claude Code under a subscription login sends its own
 * `authorization: Bearer` and ignores any injected key, so dropping these would break it outright.
 * §7 says never *write* auth material, which is a different requirement from never relaying it.
 *
 * From core, not restated here: this list had drifted from the interceptor's copy of it, and the
 * two headers only the interceptor knew about were an Azure key and a Google one.
 */
const SECRET_REQUEST_HEADERS = new Set(AUTH_REQUEST_HEADERS);

export function defaultDialects(): Dialect[] {
  return [
    codexDialect(),
    anthropicDialect({
      toCanonicalRequest: anthropicToCanonicalRequest,
      toCanonicalResponse: anthropicToCanonicalResponse,
      parseSse: parseAnthropicSse,
    }),
    openaiDialect({
      toCanonicalRequest: openaiToCanonicalRequest,
      toCanonicalResponse: openaiToCanonicalResponse,
      parseSse: parseOpenaiSse,
    }),
    // After the chat dialect deliberately: see the note on `responsesDialect`.
    responsesDialect({
      toCanonicalRequest: responsesToCanonicalRequest,
      toCanonicalResponse: responsesToCanonicalResponse,
      parseSse: parseResponsesSse,
    }),
  ];
}

class BodyLimitError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`request body exceeded capture limit of ${limit} bytes`);
  }
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ body: Buffer; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > limit) {
      req.resume();
      throw new BodyLimitError(bytes, limit);
    }
    chunks.push(buffer);
  }
  return { body: Buffer.concat(chunks), bytes };
}

/** Is this something a dialect could parse at all? Cheap guard, run before anything is forwarded. */
function isReadable(rawBody: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * Whether two origin strings name the same scheme, host and port — the test a credential must
 * pass before travelling with a request. Same shape as the copy in the CLI's upstream plan,
 * which cannot be imported from here: the proxy is a leaf, and the comparison is two lines.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}

export async function createProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const dialects = options.dialects ?? defaultDialects();
  // PINNED BY DEFAULT (orcacode-review). This proxy is handed the stored gateway
  // key as `upstreamHeaders` and attaches it to both live call sites, so it is a
  // carrier of exactly the credential fetchPinned exists to protect — and it
  // escaped the CLI's fence twice over: that fence walked only packages/cli/src,
  // and this call is an ALIAS, so a scan for a bare `fetch(` would not have seen
  // it even with the wider scope.
  //
  // `fetchImpl` stays the seam the tests inject through; only the default moves.
  const doFetch = options.fetchImpl ?? fetchPinned;
  const captured: RecordedExchange[] = [];
  // Plain base-URL traffic needs the same aggregate bound as intercepted traffic. This counter
  // covers bodies retained by concurrent fetch responses while each response still streams to the
  // caller; it is released only after that response has been materialized into evidence.
  let plainBufferedBytes = 0;
  const plainBufferLimit = options.maxBufferedBytes ?? 256 * 1024 * 1024;

  const stats: ProxyStats = { liveCalls: 0, intercepted: 0, tunnelled: 0, passedThrough: 0 };
  const redactor = new Redactor();

  const server = createServer((req, res) => {
    void handle(req, res)
      .catch((err: unknown) => {
        // Whatever failed, its message may name the origin it was given — and this body reaches
        // the agent, which prints it. See {@link withoutCredentials}.
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        json(res, 500, { error: { message: withoutCredentials(String(err)) } });
      })
      ;
  });

  /**
   * A decrypted exchange that turns out to be a model call is recorded as one.
   *
   * This is the reason the feature exists rather than a refinement of it: a harness that ignores
   * base-URL variables produces a trace indistinguishable from one captured the ordinary way,
   * which means replay, fork and compare all work on it. Anything the dialects do not recognise
   * falls through to `net.request` / `net.response`, where it is described but not interpreted.
   */
  function onDecrypted(exchange: NetExchange): void {
    // On the path alone. A dialect matches an endpoint, and a query string is not part of the
    // endpoint -- Azure OpenAI's are all `?api-version=...`, so matching the raw path recorded
    // those runs as opaque network traffic that cannot be replayed or forked, while telling the
    // operator no dialect claimed the path. `onInterceptedRequest` below has always split it off
    // for exactly this reason; the recording side had not.
    const dialect = selectDialect(dialects, exchange.path.split('?')[0] ?? exchange.path);
    // `status === 0` means no response header was ever seen: the client abandoned the call before
    // the origin answered. The request is still worth keeping -- it is what the agent asked --
    // but a model exchange with no response is not one, and inserting it in the replay set gives
    // the matcher an entry that can answer nothing and cannot be forked. It goes below as network
    // traffic instead, which is what it is.
    if (
      dialect &&
      exchange.method === 'POST' &&
      !exchange.requestTruncated &&
      exchange.responseComplete &&
      !exchange.responseTruncated &&
      exchange.status !== 0
    ) {
      try {
        // Codex's HTTPS fallback currently labels this SSE body as application/json. The wire
        // framing is authoritative when the provider header is not, otherwise we lose the
        // canonical response and replay sends the right bytes with the wrong content type.
        const streamed =
          (exchange.responseHeaders['content-type'] ?? '').includes('event-stream') ||
          exchange.responseBody.startsWith('event:');
        const built = buildExchange({
          dialect,
          path: exchange.path,
          rawRequest: exchange.requestBody,
          rawResponse: exchange.responseBody,
          status: exchange.status,
          streamed,
          headers: scalarHeaders(exchange.requestHeaders),
          seq: captured.length,
          requestId: exchange.requestId,
          requestStartedAt: exchange.requestStartedAt,
          durationMs: exchange.durationMs,
          // The two things only the interceptor witnessed. Without them a promoted exchange is
          // indistinguishable from one captured over the base-URL route, which is the point --
          // except where the difference is the thing being debugged.
          alpn: exchange.alpn,
          responseDecodedFrom: exchange.responseDecodedFrom,
          // Under interception agenticreplay did not choose this origin, the agent did — which is the
          // case where "who answered" is least obvious from the command line, and so the one most
          // worth having in the trace. The port is kept only where https does not imply it.
          upstream: `https://${exchange.host}${exchange.port === 443 ? '' : `:${exchange.port}`}`,
        });
        captured.push(built);
        options.onExchange?.(built);
        // Keep the authoritative wire record even when the dialect projection succeeds. The
        // model event is a convenient replay view; the net event retains headers, framing and
        // transport completion details needed to audit capture fidelity.
        options.tls?.onNetExchange?.({ ...exchange, modelDialect: dialect.id });
        return;
      } catch {
        // Not a model call after all — a path that merely looks like one, or a body this dialect
        // cannot read. Describing it as plain network traffic is honest; guessing is not.
      }
    }
    options.tls?.onNetExchange?.(exchange);
  }

  const interception = options.tls
    ? attachTlsIntercept(
        server,
        {
          ...options.tls,
          ...(options.maxCapturedBytes === undefined
            ? {}
            : { maxCapturedBytes: options.maxCapturedBytes }),
          ...(options.maxBufferedBytes === undefined
            ? {}
            : { maxBufferedBytes: options.maxBufferedBytes }),
          onRequestStart: options.onRequestStart,
          onNetExchange: onDecrypted,
        },
        stats,
      )
    : undefined;

  /**
   * The configured extra headers for one outbound call — only when the call is going where they
   * belong.
   *
   * `upstreamHeaders` exist to put a gateway's credential on calls to that gateway. With a
   * forwarded request naming its own destination, "every live call" would put the credential on
   * someone else's origin, so the origin the headers name is attached to them and compared here.
   * Callers that set headers without an origin get the old behaviour: on every call, their
   * responsibility.
   */
  function headersForOrigin(origin: string): Record<string, string> {
    const extra = options.upstreamHeaders;
    if (extra === undefined) return {};
    if (options.upstreamHeadersOrigin === undefined) return extra;
    return sameOrigin(origin, options.upstreamHeadersOrigin) ? extra : {};
  }

  async function goLive(
    dialect: Dialect,
    path: string,
    rawBody: string,
    /** Sent upstream, auth included. */
    headers: Record<string, string>,
    /** Written to the trace, auth removed. */
    recordableHeaders: Record<string, string | string[]>,
    res: ServerResponse,
    startedAt: number,
    requestId: string,
    requestEncoding?: string,
    /**
     * The base URL the request itself names, from a `/forward/` path. It restores the destination
     * agenticreplay took the call away from, so it outranks only the dialect's vendor default — an upstream
     * the operator configured is an instruction and wins. Dropped on a cross-provider fork, where
     * the model asked for is being served by a different origin on purpose.
     */
    forwardBase?: string,
  ): Promise<void> {
    stats.liveCalls += 1;
    const outboundBody = rawBody;
    const origin =
      forwardBase ??
      options.upstream?.[dialect.id] ??
      (dialect.id === 'openai-responses' || dialect.id === 'codex' ? options.upstream?.openai : undefined) ??
      dialect.defaultUpstream;
    const queryAt = path.indexOf('?');
    const query = queryAt === -1 ? '' : path.slice(queryAt);
    const upstreamPath = forwardBase !== undefined ? path : `${dialect.requestPath}${query}`;

    let upstreamRes: Awaited<ReturnType<typeof doFetch>>;
    try {
      upstreamRes = await doFetch(`${origin}${upstreamPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
          ...headersForOrigin(origin),
        },
        body: outboundBody,
      });
    } catch (err) {
      // An upstream that never answered, on the path agenticreplay *does* understand.
      //
      // `passThrough` learned this already; this is the same fact one branch over, and it was the
      // worse half. A call agenticreplay recognised as a model exchange and could not forward left no
      // event at all: `run.start`, a snapshot, `run.end`. The agent got its 500 and the run then
      // warned `capture.empty ... "the agent never called the proxy — it may not read a base-URL
      // variable"` — which is the opposite of what happened, and sends the operator to check
      // environment variables when the upstream is simply unreachable.
      //
      // Recorded as an exchange rather than as network traffic, because that is what it is: the
      // same call, recorded the same way, whether the upstream answered 503 or never answered at
      // all. `status: 500` is what the agent receives from the catch-all above, so a replay of
      // this trace reproduces the failure the way §4 asks — and `>= 400` is what makes
      // `capture.errors` count it, where `0` would have filed a failed call as a healthy one.
      //
      // The body is `reasonFor`'s, not the catch-all's: both name the origin they were given, and
      // this one is the copy that gets written down. See `scrubOrigin`.
      //
      // Answered here rather than rethrown into the catch-all, so the bytes the agent receives
      // and the bytes the trace holds are the same ones. Rethrowing gave the agent the
      // catch-all's `TypeError: fetch failed` while the trace held this scrubbed reason, and a
      // replay then served the trace's version — a recording that did not reproduce itself.
      // The agent also gets the better of the two messages: one that names agenticreplay and the origin.
      const body = JSON.stringify({
        error: { message: `agenticreplay did not forward this call: ${reasonFor(err, origin)}` },
      });
      options.onNetExchange?.({
        requestId,
        requestStartedAt: startedAt,
        ...originParts(origin),
        intercepted: false,
        method: 'POST',
        path,
        requestHeaders: recordableHeaders,
        requestBody: outboundBody,
        requestBytes: Buffer.byteLength(outboundBody),
        requestTruncated: false,
        status: 0,
        responseHeaders: {},
        responseBody: '',
        responseTruncated: false,
        responseComplete: false,
        responseError: reasonFor(err, origin),
        responseBytes: 0,
        durationMs: Date.now() - startedAt,
        transformations: [
          ...captureHeaderTransformations(headers, recordableHeaders),
          ...captureEncodingTransformation('request.body', requestEncoding),
          ...captureUrlTransformations(origin),
          ...binaryBodyTransformation('request.body', outboundBody),
          ...binaryBodyTransformation('response.body', body),
        ],
      });
      recordExchange(body, 500, false);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    const upstreamType = upstreamRes.headers.get('content-type') ?? 'application/json';
    const upstreamStreamed = upstreamType.includes('event-stream');
    const responseEncoding = upstreamRes.headers.get('content-encoding') ?? undefined;
    const responseDecoded = responseEncoding !== undefined && responseEncoding.trim() !== '';

    const contentType = upstreamType;
    const streamed = upstreamStreamed;

    res.writeHead(upstreamRes.status, { 'content-type': contentType });

    // Tee rather than buffer. A model response arrives over seconds, and reading it to completion
    // before writing a byte makes every turn of an interactive session appear to hang for its full
    // duration — the agent's own progressive rendering stops working because there is nothing
    // progressive left to render. Chunks go straight through; the copy we keep is assembled on the
    // way past, so the recording is still the complete body.
    let piped: PipedBody;
    try {
      piped = await pipeThrough(
        upstreamRes,
        res,
        options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES,
        plainBufferLimit,
      );
    } catch (err) {
      const partial =
        err instanceof ResponsePipeAbortedError
          ? err.partial
          : (err as { partial?: PipedBody }).partial;
      emitNetExchange({
        responseHeaders: captureResponseHeaders(upstreamRes.headers, responseDecoded),
        responseBody: partial?.text ?? '',
        responseBytes: partial?.bytes ?? 0,
        status: upstreamRes.status,
        responseComplete: false,
        responseTruncated: partial?.truncated ?? false,
        responseError: String(err),
        streamed,
        abandoned: err instanceof ResponsePipeAbortedError,
      });
      if (err instanceof ResponsePipeAbortedError) return;
      throw err;
    }

    emitNetExchange({
      responseHeaders: captureResponseHeaders(upstreamRes.headers, responseDecoded),
      responseBody: piped.text,
      responseBytes: piped.bytes,
      responseTruncated: piped.truncated,
      status: upstreamRes.status,
      responseComplete: piped.encodingError === undefined,
      ...(piped.encodingError === undefined ? {} : { responseError: piped.encodingError }),
      streamed,
    });

    if (!piped.truncated && piped.encodingError === undefined)
      recordExchange(piped.text, upstreamRes.status, streamed);

    function emitNetExchange(input: {
      responseHeaders: Record<string, string | string[]>;
      path?: string;
      responseBody: string;
      responseBytes: number;
      status: number;
      responseComplete: boolean;
      responseTruncated?: boolean;
      responseError?: string;
      abandoned?: boolean;
      streamed: boolean;
      modelDialect?: string;
      extraTransformations?: CaptureTransformation[];
    }): void {
      options.onNetExchange?.({
        requestId,
        requestStartedAt: startedAt,
        ...originParts(origin),
        intercepted: false,
        method: 'POST',
        path: input.path ?? path,
        requestHeaders: recordableHeaders,
        requestBody: outboundBody,
        requestBytes: Buffer.byteLength(outboundBody),
        requestTruncated: false,
        status: input.status,
        responseHeaders: input.responseHeaders,
        responseBody: input.responseBody,
        responseComplete: input.responseComplete,
        responseTruncated: input.responseTruncated ?? false,
        ...(input.abandoned === true ? { abandoned: true } : {}),
        ...(input.responseError === undefined ? {} : { responseError: input.responseError }),
        responseBytes: input.responseBytes,
        durationMs: Date.now() - startedAt,
        modelDialect: input.modelDialect ?? dialect.id,
        transformations: [
          ...captureHeaderTransformations(headers, recordableHeaders),
          ...captureEncodingTransformation('request.body', requestEncoding),
          ...captureResponseHeaderTransformations(upstreamRes.headers),
          ...captureEncodingTransformation('response.body', responseEncoding),
          ...(input.extraTransformations ?? []),
          ...captureUrlTransformations(origin),
          ...binaryBodyTransformation('request.body', outboundBody),
          ...binaryBodyTransformation('response.body', input.responseBody),
        ],
      });
    }

    /**
     * Recorded whatever the status. A run that died on rate limits used to produce a trace with no
     * evidence of it — and replay would then be short exactly the exchanges that explain the
     * failure you are trying to reproduce.
     *
     * The recorded body is what the *agent* received, so a cross-provider fork replays as a run of
     * the dialect the agent speaks. Recording the other provider's bytes would produce a trace
     * that no adapter could replay.
     */
    function recordExchange(rawResponse: string, status: number, isStreamed: boolean): void {
      const exchange = buildExchange({
        dialect,
        path,
        rawRequest: outboundBody,
        rawResponse,
        status,
        streamed: isStreamed,
        headers: scalarHeaders(recordableHeaders),
        seq: captured.length,
        requestId,
        requestStartedAt: startedAt,
        durationMs: Date.now() - startedAt,
        // The origin resolved above, not the one configured: a relayed call keeps the base the
        // client announced, and a fork's substitution can send it somewhere else again.
        upstream: origin,
      });
      captured.push(exchange);
      options.onExchange?.(exchange);
    }
  }

  /**
   * Where a request agenticreplay could not read should have gone.
   *
   * Explicit first, then the gateway: someone who pointed this run at one origin pointed *all* of
   * it there, and splitting a run across two origins because agenticreplay could not read one call is not a
   * choice they made. Only then the guess — and the guess is narrow, because it is not choosing a
   * destination so much as restoring one. AgenticReplay took this request away from a provider by rewriting
   * a base URL; the client's own headers say which provider that was, and its own credential is
   * already on the request addressed to them.
   */
  function passthroughOrigin(
    headers: Record<string, string | string[]>,
    forwardBase?: string,
  ): string {
    if (options.passthroughUpstream !== undefined) return options.passthroughUpstream;
    // A relayed request's own destination, before anything configured: on a live call with no
    // model substitution, the request says where it was headed, and a gateway picked up from
    // setup is a default for calls agenticreplay would otherwise guess at — not a readdressing of one that
    // announces its own. A fork is a substitution, and its configured origins decide instead.
    //
    // `verbatim` is for a call the fork does *not* substitute anything in. A retrieval call is
    // forwarded byte for byte — same headers, same body, no `withModel` — so the substitution the
    // fork rule exists for never happens to it, and dropping its announced destination on account
    // of one is how a fork's live embedding call left for the chat origin carrying the embedding
    // provider's own key: a 401 at best, and at worst an OpenAI-compatible gateway that answers
    // `/v1/embeddings` from a different model, putting foreign vectors in the fork's index.
    if (forwardBase !== undefined) {
      return forwardBase;
    }
    const configured = [...new Set(Object.values(options.upstream ?? {}))];
    if (configured.length === 1) return configured[0]!;
    const names = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
    // `x-api-key` alongside the version headers: this request carries the caller's own credential,
    // and a wrong guess does not merely fail — it hands one vendor a key issued by another.
    // Anthropic's client is the one that announces itself, so absence of a signal means OpenAI.
    const anthropic =
      names.has('anthropic-version') || names.has('anthropic-beta') || names.has('x-api-key');
    // The origin configured for the family this request belongs to, before any vendor default.
    // Two configured values only means the run has more than one destination — not that this
    // request's own destination is unknown — and picking a vendor default over an origin the
    // operator named is how a run configured with `--upstream-openai <stub>` alongside a gateway
    // left in `~/.agenticreplay/config.json` sent its embedding calls to `api.openai.com`: a third place,
    // neither of the two configured, carrying the agent's own credential. For a team whose
    // gateway is the point of the gateway, that is every retrieval call bypassing it silently.
    const forFamily = anthropic ? options.upstream?.['anthropic'] : options.upstream?.['openai'];
    if (forFamily !== undefined) return forFamily;
    return anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com';
  }

  /**
   * An origin string as a host and a port, for the two places that record one.
   *
   * An origin that does not parse is still worth recording under the string we were given.
   */
  /**
   * Why the call did not go out, with the origin in it made safe first.
   *
   * The message names the request, so it carries the origin — and undici quotes it verbatim:
   * `Failed to parse URL from gw?key=SECRET123/v1/...`. Running only the prose rules over that
   * leaves the key in, for the same shapes `scrubOrigin` exists to handle, so the known origin is
   * replaced by its scrubbed form before the prose pass ever looks at the sentence.
   */
  function originParts(origin: string): { host: string; port: number } {
    try {
      const url = new URL(origin);
      return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443 };
    } catch {
      return { host: redactor.redactString(scrubOrigin(origin)).value, port: 443 };
    }
  }

  function reasonFor(err: unknown, origin: string): string {
    const scrubbed = String(err).split(origin).join(scrubOrigin(origin));
    return redactor.redactString(withoutCredentials(scrubbed)).value;
  }

  async function passThrough(
    path: string,
    rawBody: string,
    headers: Record<string, string>,
    recordableHeaders: Record<string, string | string[]>,
    res: ServerResponse,
    startedAt: number,
    requestId: string,
    forwardBase?: string,
    requestEncoding?: string,
  ): Promise<void> {
    stats.passedThrough += 1;
    const origin = passthroughOrigin(headers, forwardBase);
    let upstreamRes: Awaited<ReturnType<typeof doFetch>>;
    try {
      upstreamRes = await doFetch(`${origin}${path}`, {
        method: 'POST',
        // `upstreamHeaders` too, as `goLive` does. Omitting them sent a gateway the agent's own
        // credential — often the `agenticreplay-recorded` placeholder — and the call came back 401 for a
        // reason nothing in the trace explained.
        headers: {
          'content-type': 'application/json',
          ...headers,
          ...headersForOrigin(origin),
        },
        body: rawBody,
      });
    } catch (err) {
      // An upstream that never answered is still something the agent asked for, and a trace
      // that leaves it out says the run made fewer calls than it did. Before this the throw
      // reached the server's catch-all: the agent got its 500 — which was right — and nothing
      // else happened. No event, no warning, and the replay later blamed "opaque network
      // traffic" that had never been captured.
      //
      // Not an exotic path. `fetchPinned` refuses every redirect on purpose, and a gateway
      // behind a CDN answers an unknown path with one: `api.orcarouter.ai` sends `301` to its
      // own marketing site, and MiniMax Code posts to `/v1/responses/input_tokens` before every
      // call, so two requests per run went missing and said nothing.
      //
      // `status: 0` is the same thing it means for an intercepted exchange: no response header
      // was ever seen. The reason travels in the body, scrubbed, because the message names the
      // origin it was given.
      options.onNetExchange?.({
        requestId,
        requestStartedAt: startedAt,
        ...originParts(origin),
        method: 'POST',
        intercepted: false,
        path,
        requestHeaders: recordableHeaders,
        requestBody: rawBody,
        requestBytes: Buffer.byteLength(rawBody),
        requestTruncated: false,
        status: 0,
        responseHeaders: {},
        responseBody: `agenticreplay did not forward this call: ${reasonFor(err, origin)}`,
        responseTruncated: false,
        responseComplete: false,
        responseError: reasonFor(err, origin),
        responseBytes: 0,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }

    const responseEncoding = upstreamRes.headers.get('content-encoding') ?? undefined;
    const responseHeaders = captureResponseHeaders(
      upstreamRes.headers,
      responseEncoding !== undefined && responseEncoding.trim() !== '',
    );
    res.writeHead(upstreamRes.status, {
      'content-type': responseHeaders['content-type'] ?? 'application/json',
    });
    let piped: PipedBody;
    try {
      piped = await pipeThrough(
        upstreamRes,
        res,
        options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES,
        plainBufferLimit,
      );
    } catch (err) {
      const partial =
        err instanceof ResponsePipeAbortedError
          ? err.partial
          : (err as { partial?: PipedBody }).partial;
      options.onNetExchange?.({
        requestId,
        requestStartedAt: startedAt,
        ...originParts(origin),
        method: 'POST',
        path,
        intercepted: false,
        requestHeaders: recordableHeaders,
        requestBody: rawBody,
        requestBytes: Buffer.byteLength(rawBody),
        requestTruncated: false,
        status: upstreamRes.status,
        responseHeaders,
        responseBody: partial?.text ?? '',
        responseTruncated: partial?.truncated ?? false,
        responseComplete: false,
        responseError: String(err),
        responseBytes: partial?.bytes ?? 0,
        ...(err instanceof ResponsePipeAbortedError ? { abandoned: true } : {}),
        durationMs: Date.now() - startedAt,
      });
      if (err instanceof ResponsePipeAbortedError) return;
      throw err;
    }
    const body = piped.text;

    let host = origin;
    let port = 443;
    try {
      const url = new URL(origin);
      host = url.hostname;
      port = url.port !== '' ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
    } catch {
      // An origin that does not parse is still worth recording under the string we were given.
    }
    options.onNetExchange?.({
      requestId,
      requestStartedAt: startedAt,
      host,
      port,
      method: 'POST',
      path,
      // AgenticReplay decrypted nothing here: the harness sent this in plaintext to the local proxy, and
      // agenticreplay relayed it. Saying otherwise puts a claim about TLS termination in the trace over a
      // host agenticreplay never terminated TLS for.
      intercepted: false,
      // `recordableHeaders`, never `headers`: the auth material was forwarded a moment ago and
      // must not now be written down. §7 says never write it, which is not the same as never relay it.
      requestHeaders: recordableHeaders,
      requestBody: rawBody,
      requestBytes: Buffer.byteLength(rawBody),
      requestTruncated: false,
      status: upstreamRes.status,
      responseHeaders,
      responseBody: body,
      responseTruncated: piped.truncated,
      responseComplete: !piped.truncated && piped.encodingError === undefined,
      ...(piped.truncated
        ? { responseError: 'response exceeded capture limit' }
        : piped.encodingError === undefined
          ? {}
          : { responseError: piped.encodingError }),
      responseBytes: piped.bytes,
      durationMs: Date.now() - startedAt,
      transformations: [
        ...captureHeaderTransformations(headers, recordableHeaders),
        ...captureEncodingTransformation('request.body', requestEncoding),
        ...captureResponseHeaderTransformations(upstreamRes.headers),
        ...captureEncodingTransformation('response.body', responseEncoding),
        ...captureUrlTransformations(origin),
        ...binaryBodyTransformation('request.body', rawBody),
        ...binaryBodyTransformation('response.body', body),
      ],
    });
  }

  /**
   * The host a `/forward/` path names, for a rule that wants to tell two vendors apart.
   *
   * Only where the request announced its own destination. On an ordinary redirected call agenticreplay knows
   * where it is *sending* the request but not where the client thought it was going, and inventing
   * a host would let a rule claim an endpoint on evidence that does not exist.
   */
  function forwardHost(forward: ForwardPath | undefined): string | undefined {
    if (forward === undefined) return undefined;
    try {
      return new URL(forward.base).hostname;
    } catch {
      return undefined;
    }
  }

  /** Did the agent ask for a stream? Both dialects spell it the same way. */
  function requestedStream(rawBody: string): boolean {
    try {
      return (JSON.parse(rawBody) as { stream?: unknown }).stream === true;
    } catch {
      return false;
    }
  }

  /**
   * Forward an upstream body to the client as it arrives, returning the complete text.
   *
   * `Response.body` is absent in a couple of legitimate cases — a 204, and any stubbed Response
   * built without one — so fall back to buffering rather than failing: the point is never to lose
   * the recording.
   */
  interface PipedBody {
    text: string;
    bytes: number;
    truncated: boolean;
    encodingError?: string;
  }

  function recordableUtf8(bytes: Buffer): { text: string; encodingError?: string } {
    const text = bytes.toString('utf8');
    if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) === 0) return { text };
    return {
      text: `${BINARY_BODY_PREFIX}${bytes.toString('base64')}`,
      encodingError: 'unsupported_binary_body',
    };
  }

  class ResponsePipeAbortedError extends Error {
    constructor(
      readonly partial: PipedBody,
      message = 'client closed response',
    ) {
      super(message);
      this.name = 'ResponsePipeAbortedError';
    }
  }

  async function readBoundedResponse(
    upstream: Response,
    captureLimit: number,
    aggregateLimit: number,
  ): Promise<PipedBody> {
    if (!upstream.body) {
      const bytesBuffer = Buffer.from(await upstream.arrayBuffer());
      const bytes = bytesBuffer.byteLength;
      const decoded = recordableUtf8(bytesBuffer.subarray(0, captureLimit));
      return {
        text: decoded.text,
        bytes,
        truncated: bytes > captureLimit,
        ...(decoded.encodingError === undefined ? {} : { encodingError: decoded.encodingError }),
      };
    }
    const reader = upstream.body.getReader();
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        const room = Math.min(captureLimit - capturedBytes, aggregateLimit - plainBufferedBytes);
        if (room > 0) {
          const keep = Math.min(room, value.byteLength);
          chunks.push(Buffer.from(value.subarray(0, keep)));
          capturedBytes += keep;
          plainBufferedBytes += keep;
        }
      }
      const decoded = recordableUtf8(Buffer.concat(chunks));
      return {
        text: decoded.text,
        bytes,
        truncated: bytes > captureLimit || capturedBytes < bytes,
        ...(decoded.encodingError === undefined ? {} : { encodingError: decoded.encodingError }),
      };
    } finally {
      plainBufferedBytes = Math.max(0, plainBufferedBytes - capturedBytes);
    }
  }

  async function pipeThrough(
    upstream: Response,
    res: ServerResponse,
    captureLimit = Number.MAX_SAFE_INTEGER,
    aggregateLimit = Number.MAX_SAFE_INTEGER,
  ): Promise<PipedBody> {
    const body = upstream.body;
    if (!body) {
      const bytesBuffer = Buffer.from(await upstream.arrayBuffer());
      res.end(bytesBuffer);
      const bytes = bytesBuffer.byteLength;
      const decoded = recordableUtf8(bytesBuffer.subarray(0, captureLimit));
      return {
        text: decoded.text,
        bytes,
        truncated: bytes > captureLimit,
        ...(decoded.encodingError === undefined ? {} : { encodingError: decoded.encodingError }),
      };
    }

    const reader = body.getReader();
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let bytes = 0;
    let closed = res.destroyed || res.writableEnded;
    const onClose = () => {
      closed = true;
      void reader.cancel();
    };
    res.once('close', onClose);
    const partial = (): PipedBody => {
      const buffer = Buffer.concat(captured);
      const decoded = recordableUtf8(buffer);
      return {
        text: decoded.text,
        bytes,
        truncated: bytes > captureLimit || capturedBytes < bytes,
        ...(decoded.encodingError === undefined ? {} : { encodingError: decoded.encodingError }),
      };
    };
    try {
      for (;;) {
        if (closed) throw new ResponsePipeAbortedError(partial());
        const { done, value } = await reader.read();
        if (closed) throw new ResponsePipeAbortedError(partial());
        if (done) break;
        bytes += value.byteLength;
        if (capturedBytes < captureLimit) {
          const aggregateRoom = Math.max(0, aggregateLimit - plainBufferedBytes);
          const keep = Math.min(value.byteLength, captureLimit - capturedBytes, aggregateRoom);
          if (keep > 0) {
            captured.push(Buffer.from(value.subarray(0, keep)));
            capturedBytes += keep;
            plainBufferedBytes += keep;
          }
        }
        // Backpressure: if the socket says it is full, wait for it rather than buffering in memory
        // on the agent's behalf.
        if (!res.write(value)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onResponseClose = () => {
              cleanup();
              closed = true;
              reject(new ResponsePipeAbortedError(partial()));
            };
            const cleanup = () => {
              res.off('drain', onDrain);
              res.off('close', onResponseClose);
            };
            res.once('drain', onDrain);
            res.once('close', onResponseClose);
            if (res.destroyed || res.writableEnded) onResponseClose();
          });
        }
      }
    } catch (err) {
      plainBufferedBytes = Math.max(0, plainBufferedBytes - capturedBytes);
      if (err instanceof ResponsePipeAbortedError) throw err;
      if (err instanceof Error) {
        Object.defineProperty(err, 'partial', { value: partial(), enumerable: false });
        throw err;
      }
      const wrapped = new Error(String(err));
      Object.defineProperty(wrapped, 'partial', { value: partial(), enumerable: false });
      throw wrapped;
    } finally {
      res.off('close', onClose);
      reader.releaseLock();
    }
    if (!res.destroyed && !res.writableEnded) res.end();
    const buffer = Buffer.concat(captured);
    const decoded = recordableUtf8(buffer);
    plainBufferedBytes = Math.max(0, plainBufferedBytes - capturedBytes);
    return {
      text: decoded.text,
      bytes,
      truncated: bytes > captureLimit || capturedBytes < bytes,
      ...(decoded.encodingError === undefined ? {} : { encodingError: decoded.encodingError }),
    };
  }

  function buildExchange(input: {
    dialect: Dialect;
    path: string;
    rawRequest: string;
    rawResponse: string;
    status: number;
    streamed: boolean;
    headers: Record<string, string>;
    seq: number;
    requestId?: string;
    requestStartedAt?: number;
    durationMs: number;
    alpn?: string;
    responseDecodedFrom?: string;
    upstream?: string;
  }): RecordedExchange {
    const canonicalRequest = input.dialect.toCanonicalRequest(JSON.parse(input.rawRequest));
    let canonicalResponse: CanonicalResponse | undefined;
    try {
      canonicalResponse = input.streamed
        ? input.dialect.parseStream(input.rawResponse)
        : input.dialect.toCanonicalResponse(JSON.parse(input.rawResponse));
    } catch {
      // An unparseable response is still worth recording verbatim — the raw bytes are the
      // authoritative record, and a canonical view we could not build is not a reason to lose them.
      canonicalResponse = undefined;
    }
    return {
      seq: input.seq,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.requestStartedAt === undefined ? {} : { requestStartedAt: input.requestStartedAt }),
      dialect: input.dialect.id,
      path: input.path,
      rawRequest: input.rawRequest,
      rawResponse: input.rawResponse,
      status: input.status,
      streamed: input.streamed,
      canonicalRequest,
      canonicalResponse,
      usage: canonicalResponse?.usage,
      requestHeaders: input.headers,
      ...(input.alpn === undefined ? {} : { alpn: input.alpn }),
      ...(input.responseDecodedFrom === undefined
        ? {}
        : { responseDecodedFrom: input.responseDecodedFrom }),
      ...(recordableOrigin(input.upstream) === undefined
        ? {}
        : { upstream: recordableOrigin(input.upstream)! }),
      durationMs: input.durationMs,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    // Split, not discarded. Two different questions are asked of a request line here and they
    // want different halves of it: *which endpoint is this* is answered by the path alone —
    // `selectDialect` matches an endpoint and a query is not part of one — while *what do I
    // send upstream* wants the line as the client wrote it. Dropping the query at the top answered
    // the first question and silently lost the second: a client calling
    // `<base>/chat/completions?api-version=2026-02-01` reached its origin as
    // `/v1/chat/completions`, which is `404 Resource not found` on Azure OpenAI, where that
    // parameter is required on every call. The trace lost it too, so nothing in the run said why.
    const rawPath = req.url ?? '/';
    const requestId = randomUUID();
    const path = rawPath.split('?')[0] ?? '/';
    const query = rawPath.slice(path.length);

    if (path === '/__agenticreplay/health') {
      json(res, 200, { ok: true, ...stats });
      return;
    }

    // A `/forward/` path carries the base URL the client was actually given — see
    // `decodeForwardPath`. The dialect reads the real path behind the prefix, and everything
    // recorded below does too, so the trace shows the conversation the agent had, not the
    // envelope agenticreplay wrapped it in.
    const forward: ForwardPath | undefined = decodeForwardPath(path);
    const dialectPath = forward?.path ?? path;
    /** What goes upstream and into the trace: the endpoint agenticreplay resolved, called the way it was. */
    const requestedPath = `${dialectPath}${query}`;

    const dialect = selectDialect(dialects, dialectPath);
    // Only a POST is ever a model call. Relaxing this to `!dialect && …` let a PUT or a DELETE on
    // a dialect path through to `goLive`, which forwarded it upstream and recorded it as a model
    // exchange; and it turned `GET /v1/messages` into a 400 about unreadable JSON rather than the
    // honest answer. Method first, then passthrough decides what to do with a POST agenticreplay cannot read.
    if (req.method !== 'POST' && req.headers.upgrade === undefined) {
      json(res, 404, {
        error: {
          message: `agenticreplay proxy does not handle ${req.method ?? 'GET'} ${dialectPath}`,
        },
      });
      return;
    }

    const startHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(key) || SECRET_REQUEST_HEADERS.has(key) || value === undefined)
        continue;
      startHeaders[key] = value;
    }
    const configuredDialectOrigin = dialect
      ? (options.upstream?.[dialect.id] ??
        (dialect.id === 'openai-responses' || dialect.id === 'codex'
          ? options.upstream?.openai
          : undefined) ??
        dialect.defaultUpstream)
      : undefined;
    const startOrigin = dialect
      ? (forward?.base ?? configuredDialectOrigin)
      : passthroughOrigin(startHeaders, forward?.base);
    if (startOrigin === undefined) throw new Error('unable to resolve request destination');
    const startDestination = originParts(startOrigin);
    const startRequest: NetRequest = {
      requestId,
      requestStartedAt: startedAt,
      host: startDestination.host,
      port: startDestination.port,
      method: req.method ?? 'GET',
      path: requestedPath,
      requestHeaders: startHeaders,
      requestBytes: Buffer.alloc(0),
      requestTruncated: false,
    };
    try {
      await options.onRequestStart?.(startRequest);
    } catch (err) {
      try {
        options.onNetExchange?.({
          ...startRequest,
          requestBytes: 0,
          requestBody: '',
          status: 0,
          responseHeaders: {},
          responseBody: '',
          responseTruncated: false,
          responseComplete: false,
          responseError: `request-start recorder failed: ${String(err)}`,
          responseBytes: 0,
          intercepted: false,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Preserve the recorder failure when terminal persistence cannot itself be recorded.
      }
      throw err;
    }

    if (req.headers.upgrade !== undefined) {
      const message = 'unsupported WebSocket transport';
      const responseBody = JSON.stringify({ error: { message } });
      options.onNetExchange?.({
        ...startRequest,
        requestBytes: 0,
        requestBody: '',
        status: 501,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody,
        responseBytes: Buffer.byteLength(responseBody),
        responseComplete: false,
        responseTruncated: false,
        responseError: message,
        intercepted: false,
        durationMs: Date.now() - startedAt,
        transformations: [
          {
            kind: 'omission',
            location: 'transport',
            rule: 'unsupported_transport',
            count: 1,
            reason: 'WebSocket frames are not captured',
          },
        ],
      });
      json(res, 501, { error: { message } });
      return;
    }

    let rawBody: string;
    let requestBytes: number;
    let requestReservedBytes = 0;
    try {
      const read = await readBody(req, options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES);
      rawBody = decodeBody(
        read.body,
        Array.isArray(req.headers['content-encoding'])
          ? req.headers['content-encoding'].join(', ')
          : req.headers['content-encoding'],
        options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES,
      );
      requestBytes = read.bytes;
      requestReservedBytes = Buffer.byteLength(rawBody);
      if (plainBufferedBytes + requestReservedBytes > plainBufferLimit) {
        throw new BodyLimitError(requestReservedBytes, plainBufferLimit);
      }
      plainBufferedBytes += requestReservedBytes;
    } catch (err) {
      if (!(err instanceof BodyLimitError)) {
        options.onNetExchange?.({
          requestId,
          requestStartedAt: startedAt,
          host: req.headers.host ?? 'local',
          port: 0,
          intercepted: false,
          method: req.method ?? 'POST',
          path: requestedPath,
          requestHeaders: {},
          requestBody: '',
          requestBytes: 0,
          requestTruncated: true,
          status: 0,
          responseHeaders: {},
          responseBody: '',
          responseTruncated: false,
          responseComplete: false,
          responseError: String(err),
          responseBytes: 0,
          durationMs: Date.now() - startedAt,
        });
        json(res, 400, {
          error: { message: `agenticreplay could not decode request body: ${String(err)}` },
        });
        return;
      }
      options.onNetExchange?.({
        requestId,
        requestStartedAt: startedAt,
        host: req.headers.host ?? 'local',
        port: 0,
        intercepted: false,
        method: req.method ?? 'POST',
        path: requestedPath,
        requestHeaders: {},
        requestBody: '',
        requestBytes: err.bytes,
        requestTruncated: true,
        status: 0,
        responseHeaders: {},
        responseBody: '',
        responseTruncated: false,
        responseComplete: false,
        responseError: String(err),
        responseBytes: 0,
        durationMs: Date.now() - startedAt,
      });
      json(res, 413, { error: { message: String(err) } });
      return;
    }
    const inboundRequestHeader = req.headers['content-encoding'] as string | string[] | undefined;
    const inboundRequestEncoding = Array.isArray(inboundRequestHeader)
      ? inboundRequestHeader.join(', ')
      : inboundRequestHeader;
    try {
      const headers: Record<string, string> = {};
      const recordableHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(key)) continue;
        if (v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      // Node's parsed headers combine repeated fields. Keep the raw field order and multiplicity
      // for persisted evidence while retaining the scalar map above for fetch forwarding.
      for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
        const key = req.rawHeaders[index]!.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(key) || SECRET_REQUEST_HEADERS.has(key)) continue;
        const value = req.rawHeaders[index + 1]!;
        const prior = recordableHeaders[key];
        recordableHeaders[key] =
          prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
      }
      // `decodeBody` above gives the origin the serialized JSON rather than the compressed wire
      // bytes. Remove the stale framing headers or the origin will try to decompress plaintext.
      if (headers['content-encoding'] !== undefined) {
        delete headers['content-encoding'];
        delete recordableHeaders['content-encoding'];
        const length = String(Buffer.byteLength(rawBody));
        headers['content-length'] = length;
        recordableHeaders['content-length'] = length;
      }

      if (!dialect) {
        await passThrough(
          requestedPath,
          rawBody,
          headers,
          recordableHeaders,
          res,
          startedAt,
          requestId,
          forward?.base,
          inboundRequestEncoding,
        );
        return;
      }

      // Parsed here rather than inside `goLive`, which read it unguarded — so a body agenticreplay could not
      // read reached the server's catch-all and came back as `500 SyntaxError: …`. To whoever is
      // running the agent that reads as agenticreplay falling over, and sends them to agenticreplay's issue tracker
      // instead of to the line of their own harness that sent it. Replay already answered 400.
      if (!isReadable(rawBody)) {
        const errorBody = {
          error: {
            message:
              `agenticreplay proxy could not read the body of POST ${dialectPath}: expected JSON, got ` +
              `${rawBody === '' ? 'an empty body' : `${rawBody.length} bytes that do not parse`}`,
          },
        };
        options.onNetExchange?.({
          requestId,
          requestStartedAt: startedAt,
          host: req.headers.host ?? 'local',
          port: 0,
          intercepted: false,
          method: req.method ?? 'POST',
          path: requestedPath,
          requestHeaders: recordableHeaders,
          requestBody: rawBody,
          requestBytes,
          requestTruncated: false,
          status: 400,
          responseHeaders: { 'content-type': 'application/json' },
          responseBody: JSON.stringify(errorBody),
          responseTruncated: false,
          responseComplete: true,
          responseBytes: Buffer.byteLength(JSON.stringify(errorBody)),
          durationMs: Date.now() - startedAt,
          transformations: binaryBodyTransformation('request.body', rawBody),
        });
        json(res, 400, errorBody);
        return;
      }

      await goLive(
        dialect,
        requestedPath,
        rawBody,
        headers,
        recordableHeaders,
        res,
        startedAt,
        requestId,
        inboundRequestEncoding,
        forward?.base,
      );
    } finally {
      plainBufferedBytes = Math.max(0, plainBufferedBytes - requestReservedBytes);
    }
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${port}`,
    port,
    stats: () => ({ ...stats }),
    exchanges: () => captured.slice(),
    ...(options.tls && interception
      ? {
          tls: {
            hosts: interception.policy.describe(),
            fingerprint: options.tls.ca.fingerprint,
            caCertPath: options.tls.ca.certPath,
            caBundlePath: options.tls.ca.bundlePath,
          },
        }
      : {}),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Tunnels and decrypted sessions are long-lived by design, and `close` waits for every
        // open connection. Without this a recorded run would hang on exit behind an agent's idle
        // keep-alive socket.
        interception?.close();
        (server as Server).close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
