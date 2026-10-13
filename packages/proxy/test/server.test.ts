import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { AUTH_REQUEST_HEADERS } from '@agenticreplay/core';
import type { RecordedExchange } from '../src/server.js';
import { createProxy } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

it('records unsupported WebSocket attempts as incomplete instead of silent 404s', async () => {
  const seen: import('../src/server.js').NetExchange[] = [];
  const proxy = await createProxy({
    mode: 'record',
    onNetExchange: (e) => {
      seen.push(e);
    },
  });
  closers.push(proxy.close);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      `${proxy.url}/v1/responses`,
      { headers: { connection: 'Upgrade', upgrade: 'websocket' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(501);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    responseComplete: false,
    responseError: 'unsupported WebSocket transport',
    method: 'GET',
  });
});

const ANTHROPIC_BODY = {
  model: 'claude-opus-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'fix the auth test' }],
};

const ANTHROPIC_REPLY = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'looking at auth.ts now' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 7 },
};

function stubUpstream(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-secret-key', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('proxy — record mode', () => {
  it('forwards to upstream and returns the upstream response unchanged', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(res.status).toBe(200);
    expect(res.json).toEqual(ANTHROPIC_REPLY);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toContain('/v1/messages');
  });

  it('emits authoritative network evidence for an ordinary model call', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onNetExchange: (exchange) => seen.push(exchange),
    });
    closers.push(proxy.close);

    const serialized = JSON.stringify(ANTHROPIC_BODY);
    await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ordinary-test-secret',
      },
      body: serialized,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      requestBody: serialized,
      requestBytes: Buffer.byteLength(serialized),
      status: 200,
      responseBody: JSON.stringify(ANTHROPIC_REPLY),
      responseComplete: true,
      responseBytes: Buffer.byteLength(JSON.stringify(ANTHROPIC_REPLY)),
      modelDialect: 'anthropic',
    });
    expect(seen[0]!.requestId).toEqual(expect.any(String));
    expect(seen[0]!.transformations?.some((t) => t.kind === 'header_excluded')).toBe(true);
    expect(JSON.stringify(seen[0])).not.toContain('ordinary-test-secret');
  });

  it('matches the captured exchange against an independent origin log', async () => {
    const originRequests: Array<{
      path: string;
      body: string;
      headers: Record<string, string | string[]>;
    }> = [];
    const origin = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        originRequests.push({
          path: req.url ?? '/',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers as Record<string, string | string[]>,
        });
        res.writeHead(200, { 'content-type': 'application/json', 'x-origin-proof': 'yes' });
        res.end(JSON.stringify(ANTHROPIC_REPLY));
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const address = origin.address() as AddressInfo;
    closers.push(async () => new Promise<void>((resolve) => origin.close(() => resolve())));

    const seen: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { anthropic: `http://127.0.0.1:${address.port}` },
      onNetExchange: (exchange) => seen.push(exchange),
    });
    closers.push(proxy.close);
    const serialized = JSON.stringify({ ...ANTHROPIC_BODY, metadata: { unknown: 'preserve-me' } });
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: serialized,
    });
    expect(response.status).toBe(200);
    const captured = seen.find((exchange) => exchange.modelDialect === 'anthropic');
    expect(originRequests).toHaveLength(1);
    expect(captured).toBeDefined();
    expect(originRequests[0]!.path).toBe('/v1/messages');
    expect(originRequests[0]!.body).toBe(serialized);
    expect(captured!.requestBody).toBe(originRequests[0]!.body);
    expect(captured!.responseBody).toBe(JSON.stringify(ANTHROPIC_REPLY));
    expect(captured!.responseHeaders['x-origin-proof']).toBe('yes');
  });

  it('preserves repeated non-secret request fields in plain transport evidence', async () => {
    const origin = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-origin-repeat': ['one', 'two'],
        });
        res.end(JSON.stringify(ANTHROPIC_REPLY));
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const address = origin.address() as AddressInfo;
    closers.push(async () => new Promise<void>((resolve) => origin.close(() => resolve())));

    const seen: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { anthropic: `http://127.0.0.1:${address.port}` },
      onNetExchange: (exchange) => seen.push(exchange),
    });
    closers.push(proxy.close);
    const body = JSON.stringify(ANTHROPIC_BODY);
    const response = await new Promise<{
      status: number;
      headers: import('node:http').IncomingHttpHeaders;
    }>((resolve, reject) => {
      const request = httpRequest(
        `${proxy.url}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-repeat': ['one', 'two'],
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      );
      request.on('error', reject);
      request.end(body);
    });

    expect(response.status).toBe(200);
    const captured = seen.find((exchange) => exchange.modelDialect === 'anthropic');
    expect(captured?.requestHeaders['x-repeat']).toEqual(['one', 'two']);
    expect(captured?.responseHeaders['x-origin-repeat']).toBe('one, two');
    expect(captured?.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'encoding',
          location: 'response.headers',
          rule: 'fetch-headers-boundary-normalization',
        }),
      ]),
    );
  });

  it('audits plain request decoding, response decoding, and excluded response headers', async () => {
    const origin = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        expect(Buffer.concat(chunks).toString('utf8')).toBe(JSON.stringify(ANTHROPIC_BODY));
        const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(ANTHROPIC_REPLY)));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(encoded.length),
          'set-cookie': 'session=origin-secret',
          'x-repeat': 'first',
        });
        res.end(encoded);
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const address = origin.address() as AddressInfo;
    closers.push(async () => new Promise<void>((resolve) => origin.close(() => resolve())));

    const seen: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { anthropic: `http://127.0.0.1:${address.port}` },
      onNetExchange: (exchange) => seen.push(exchange),
    });
    closers.push(proxy.close);
    const requestBytes = zlib.gzipSync(Buffer.from(JSON.stringify(ANTHROPIC_BODY)));
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        `${proxy.url}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': requestBytes.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      request.on('error', reject);
      request.end(requestBytes);
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(ANTHROPIC_REPLY);
    expect(seen).toHaveLength(1);
    const transformations = seen[0]!.transformations ?? [];
    expect(transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'decompression', location: 'request.body', count: 1 }),
        expect.objectContaining({ kind: 'decompression', location: 'response.body', count: 1 }),
        expect.objectContaining({
          kind: 'header_excluded',
          location: 'response.headers',
          reason: expect.stringContaining('set-cookie'),
        }),
      ]),
    );
    expect(seen[0]!.responseHeaders['content-encoding']).toBeUndefined();
    expect(seen[0]!.responseHeaders['set-cookie']).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain('origin-secret');
  });

  it('streams the full live response while bounding the retained model body', async () => {
    const full = JSON.stringify({
      id: 'msg-large',
      type: 'message',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'tail-' + 'x'.repeat(512) }],
      unknown_provider_field: { preserve: true },
    });
    const up = stubUpstream(JSON.parse(full));
    const network: import('../src/server.js').NetExchange[] = [];
    const exchanges: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      maxCapturedBytes: 256,
      fetchImpl: up.fetchImpl,
      onNetExchange: (exchange) => network.push(exchange),
      onExchange: (exchange) => exchanges.push(exchange),
    });
    closers.push(proxy.close);

    const response = await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);
    expect(response.status).toBe(200);
    expect(network).toHaveLength(1);
    expect(network[0]).toMatchObject({
      responseBytes: Buffer.byteLength(full),
      responseTruncated: true,
      responseComplete: true,
      modelDialect: 'anthropic',
    });
    expect(network[0]!.responseBody).toBe(full.slice(0, 256));
    expect(exchanges).toHaveLength(0);
  });

  it('keeps invalid UTF-8 response bytes and marks transport evidence incomplete', async () => {
    const invalid = Uint8Array.from([0xc3, 0x28, 0xff, 0x00]);
    const seen: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: (async () =>
        new Response(invalid, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })) as typeof fetch,
      onNetExchange: (exchange) => seen.push(exchange),
    });
    closers.push(proxy.close);

    const body = JSON.stringify(ANTHROPIC_BODY);
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(invalid));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.responseComplete).toBe(false);
    expect(seen[0]!.responseError).toBe('unsupported_binary_body');
    expect(seen[0]!.responseBody).toBe(
      `agenticreplay-base64:${Buffer.from(invalid).toString('base64')}`,
    );
  });

  it('records the resolved destination at request start and reports recorder failure', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const starts: import('../src/server.js').NetRequest[] = [];
    const network: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { anthropic: 'https://gateway.example' },
      fetchImpl: up.fetchImpl,
      onRequestStart: (request) => starts.push(request),
      onNetExchange: (exchange) => network.push(exchange),
    });
    closers.push(proxy.close);
    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);
    expect(starts[0]).toMatchObject({ host: 'gateway.example', port: 443, path: '/v1/messages' });
    expect(starts[0]!.requestHeaders['content-type']).toBe('application/json');

    const failed: import('../src/server.js').NetExchange[] = [];
    const blocked = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onRequestStart: () => {
        throw new Error('persist failed');
      },
      onNetExchange: (exchange) => failed.push(exchange),
    });
    closers.push(blocked.close);
    const response = await post(`${blocked.url}/v1/messages`, ANTHROPIC_BODY);
    expect(response.status).toBe(500);
    expect(failed[0]).toMatchObject({
      responseComplete: false,
      responseError: expect.stringContaining('persist failed'),
    });
  });

  it('records URL scrubbing as a transport transformation', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const network: import('../src/server.js').NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { anthropic: 'https://user:password@gateway.example?key=secret' },
      fetchImpl: up.fetchImpl,
      onNetExchange: (exchange) => network.push(exchange),
    });
    closers.push(proxy.close);
    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);
    expect(network[0]!.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'url_scrubbed', location: 'destination.url' }),
      ]),
    );
  });

  it('emits one exchange carrying both raw bytes and the canonical form', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(seen).toHaveLength(1);
    const ex = seen[0]!;
    expect(ex.dialect).toBe('anthropic');
    // Raw bytes are what make exact replay exact; canonical is what makes forking possible.
    expect(ex.rawRequest).toContain('fix the auth test');
    expect(ex.rawResponse).toContain('looking at auth.ts now');
    expect(ex.canonicalRequest.model).toBe('claude-opus-5');
    expect(ex.canonicalResponse?.content[0]).toMatchObject({ type: 'text' });
    expect(ex.usage?.input_tokens).toBe(12);
  });

  it('sends the query the client wrote, on the endpoint agenticreplay resolved', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { anthropic: 'https://res.openai.azure.com/openai/deployments/dep' },
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages?api-version=2026-02-01`, ANTHROPIC_BODY);

    // The path is agenticreplay's to normalise -- it chose this origin, and the incoming path cannot be
    // trusted to carry the version segment. The query is not: the client set it, and Azure OpenAI
    // requires `api-version` on every call, so losing it is `404 Resource not found` with nothing
    // in the run to explain it.
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toBe(
      'https://res.openai.azure.com/openai/deployments/dep/v1/messages?api-version=2026-02-01',
    );
  });

  it('adds no query to a request that had none', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(up.calls[0]!.url).not.toContain('?');
  });

  it('forwards the caller auth header upstream but never records it', async () => {
    // Both halves matter. Claude Code under a subscription login authenticates with its own
    // `authorization: Bearer` header and ignores any injected key, so a proxy that drops it
    // breaks the agent outright. §7 says never *write* auth material — not never forward it.
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY, {
      authorization: 'Bearer oauth-subscription-token',
    });

    const forwarded = up.calls[0]!.init.headers as Record<string, string>;
    expect(forwarded.authorization).toBe('Bearer oauth-subscription-token');
    // The whole exchange, not just its header map: `?? {}` on a field nobody populated would have
    // made this pass over an exchange carrying the token somewhere else entirely.
    expect(JSON.stringify(seen[0]!)).not.toContain('oauth-subscription-token');
  });

  it('answers the agent-proxy probes Claude Code makes, without touching the recording', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    const res = await fetch(`${proxy.url}/v1/code/agent-proxy/ca-cert`);
    expect([200, 404]).toContain(res.status);
    expect(up.calls).toHaveLength(0);
  });

  it('never records the caller auth header', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(JSON.stringify(seen[0]!)).not.toContain('sk-secret-key');
  });

  // Driven off the list itself, so a header added to core is exercised here without anyone
  // remembering to. Three copies of this set had drifted apart before it was unified, and the two
  // names only one copy knew about were an Azure key and a Google one — which meant the same
  // credential was stripped on the intercepted path and written on the recorded one.
  for (const header of AUTH_REQUEST_HEADERS) {
    it(`forwards ${header} upstream and records none of it`, async () => {
      const up = stubUpstream(ANTHROPIC_REPLY);
      const seen: RecordedExchange[] = [];
      const proxy = await createProxy({
        mode: 'record',
        fetchImpl: up.fetchImpl,
        onExchange: (e) => void seen.push(e),
      });
      closers.push(proxy.close);

      const secret = `secret-value-for-${header}`;
      await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY, { [header]: secret });

      const forwarded = up.calls[0]!.init.headers as Record<string, string>;
      expect(forwarded[header], 'an agent that cannot authenticate cannot run').toBe(secret);
      expect(JSON.stringify(seen[0]!), 'spec §7: never written').not.toContain(secret);
    });
  }

  it('routes OpenAI chat completions and labels the dialect', async () => {
    const up = stubUpstream({
      id: 'chatcmpl-1',
      model: 'gpt-5.2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/chat/completions`, {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(seen[0]!.dialect).toBe('openai');
  });

  it('propagates an upstream error status instead of masking it', async () => {
    const up = stubUpstream({ error: { message: 'rate limited' } }, 429);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    expect((await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY)).status).toBe(429);
  });

  it('records a failed exchange rather than dropping it', async () => {
    // Recording used to be guarded by `if (upstreamRes.ok)`. A run that died on rate limits then
    // produced a trace with no evidence of why — and replay came up short exactly the exchanges
    // that explain the failure you opened the trace to understand.
    const up = stubUpstream({ error: { message: 'rate limited' } }, 429);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe(429);
    expect(seen[0]!.rawResponse).toContain('rate limited');
  });

  it('binds loopback only — a trace is sensitive', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('proxy — streaming', () => {
  /**
   * A model response arrives as SSE over seconds. The proxy used to `await upstreamRes.text()`
   * before writing a single byte, so the agent got the whole response at once, after the model had
   * finished — every turn of an interactive session appeared to hang for its full duration, and
   * `docs/architecture.md` claimed the opposite ("tees a canonical copy while streaming through").
   *
   * The test is built so buffering cannot pass it by luck: the upstream withholds its second chunk
   * until the *client* has actually received the first. A proxy that buffers deadlocks, which the
   * race below turns into a legible failure instead of a timeout.
   */
  function gatedUpstream() {
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode('event: message_start\ndata: {"type":"message_start"}\n\n'),
            );
            await gate;
            controller.enqueue(
              enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch;
    return { fetchImpl, releaseSecond };
  }

  it('forwards the first chunk before the upstream has finished', async () => {
    const up = gatedUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANTHROPIC_BODY),
    });
    const reader = res.body!.getReader();

    const first = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('proxy buffered: no chunk reached the client')), 2000),
      ),
    ]);
    expect(first).toContain('message_start');

    // Only now does the upstream produce the rest, proving the first chunk was genuinely early.
    up.releaseSecond();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('message_stop');
  });

  it('records the whole streamed body, not just the part it forwarded first', async () => {
    const up = gatedUpstream();
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANTHROPIC_BODY),
    });
    const reader = res.body!.getReader();
    // Same guard as above: without it a buffering proxy hangs the suite instead of failing it.
    await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('proxy buffered: no chunk reached the client')), 2000),
      ),
    ]);
    up.releaseSecond();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    // The exchange is finished only once the stream ends, so give the tee a turn to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.streamed).toBe(true);
    expect(seen[0]!.rawResponse).toContain('message_start');
    expect(seen[0]!.rawResponse).toContain('message_stop');
  });
});

describe('proxy — health', () => {
  it('answers /__agenticreplay/health without touching the recording', async () => {
    const proxy = await createProxy({ mode: 'replay', exchanges: [] });
    closers.push(proxy.close);
    const res = await fetch(`${proxy.url}/__agenticreplay/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, liveCalls: 0, passedThrough: 0 });
    expect(proxy.exchanges()).toEqual([]);
  });
});

describe('proxy — compressed plain HTTP requests', () => {
  it('decodes gzip before parsing and removes stale encoding headers upstream', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    const serialized = JSON.stringify(ANTHROPIC_BODY);
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: zlib.gzipSync(Buffer.from(serialized)),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(String(up.calls[0]!.init.body))).toEqual(ANTHROPIC_BODY);
    const headers = new Headers(up.calls[0]!.init.headers);
    expect(headers.has('content-encoding')).toBe(false);
    expect(headers.get('content-length')).toBe(String(Buffer.byteLength(serialized)));
  });
});

// A failure after headers must remain an incomplete response, never a second HTTP response.
it.each(['/v1/messages', '/v1/custom', '/v1/embeddings'])(
  'survives an upstream body failure on %s and serves the next request',
  async (endpoint) => {
    const seen: import('../src/server.js').NetExchange[] = [];
    const recorded: RecordedExchange[] = [];
    let calls = 0;
    const proxy = await createProxy({
      mode: 'record',
      onNetExchange: (e) => seen.push(e),
      onExchange: (e) => recorded.push(e),
      fetchImpl: (async () => {
        if (++calls > 1) return new Response(JSON.stringify(ANTHROPIC_REPLY));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: partial\n\n'));
              setTimeout(() => controller.error(new Error('fixture body failure')), 30);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }) as typeof fetch,
    });
    closers.push(proxy.close);
    const response = await fetch(`${proxy.url}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANTHROPIC_BODY),
    });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(seen[0]).toMatchObject({
      responseComplete: false,
      responseBody: 'data: partial\n\n',
      responseBytes: 15,
      responseError: expect.stringContaining('fixture body failure'),
    });
    expect(recorded).toHaveLength(0);
    expect((await post(`${proxy.url}${endpoint}`, ANTHROPIC_BODY)).json).toEqual(ANTHROPIC_REPLY);
    expect(seen[1]?.responseComplete).toBe(true);
    expect(calls).toBe(2);
  },
);

it.each(['/v1/messages', '/v1/custom', '/v1/embeddings'])(
  'keeps client cancellation on %s incomplete and serves the next request',
  async (endpoint) => {
    let report!: (value: import('../src/server.js').NetExchange) => void;
    const reported = new Promise<import('../src/server.js').NetExchange>((resolve) => {
      report = resolve;
    });
    let cancelled = false;
    let calls = 0;
    const proxy = await createProxy({
      mode: 'record',
      onNetExchange: report,
      fetchImpl: (async () => {
        if (++calls > 1) return new Response(JSON.stringify(ANTHROPIC_REPLY));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }) as typeof fetch,
    });
    closers.push(proxy.close);
    const abort = new AbortController();
    const response = await fetch(`${proxy.url}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANTHROPIC_BODY),
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('partial');
    abort.abort();
    const exchange = await reported;
    expect(exchange).toMatchObject({
      responseComplete: false,
      abandoned: true,
      responseBody: 'partial',
      responseBytes: 7,
    });
    expect(cancelled).toBe(true);
    expect((await post(`${proxy.url}${endpoint}`, ANTHROPIC_BODY)).json).toEqual(ANTHROPIC_REPLY);
    expect(calls).toBe(2);
  },
);

it.each(['/v1/messages', '/v1/custom', '/v1/embeddings'])(
  'returns one JSON error before headers on %s and survives',
  async (endpoint) => {
    const seen: import('../src/server.js').NetExchange[] = [];
    let calls = 0;
    const proxy = await createProxy({
      mode: 'record',
      onNetExchange: (exchange) => seen.push(exchange),
      fetchImpl: (async () => {
        if (++calls === 1) throw new Error('fixture connection failure');
        return new Response(JSON.stringify(ANTHROPIC_REPLY));
      }) as typeof fetch,
    });
    closers.push(proxy.close);
    const failure = await post(`${proxy.url}${endpoint}`, ANTHROPIC_BODY);
    expect(failure.status).toBe(500);
    expect(failure.json.error.message).toContain('fixture connection failure');
    expect(seen[0]).toMatchObject({
      responseComplete: false,
      responseBytes: 0,
      responseError: expect.stringContaining('fixture connection failure'),
    });
    expect((await post(`${proxy.url}${endpoint}`, ANTHROPIC_BODY)).json).toEqual(ANTHROPIC_REPLY);
    expect(calls).toBe(2);
  },
);
