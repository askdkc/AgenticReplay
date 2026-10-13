import { afterEach, describe, expect, it } from 'vitest';
import type { NetExchange } from '../src/intercept.js';
import { createProxy } from '../src/server.js';
import { decodeForwardPath, forwardBasePath } from '../src/forward.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * A `/forward/` path is how an adapter hands the proxy a request whose real destination agenticreplay
 * rewrote away: the harness's base URL was pointed here with the true base encoded into the path,
 * so every request arrives naming where it was headed. The assertions are about restoring that
 * faithfully — same bytes, same path, same wire shape — and about the prefix never firing on a
 * path that merely looks like one.
 */

const ZEN_GO = 'https://opencode.ai/zen/go/v1';

describe('decodeForwardPath', () => {
  it('decodes an encoded base and keeps the appended path', () => {
    const decoded = decodeForwardPath(`${forwardBasePath(ZEN_GO)}/chat/completions`);
    expect(decoded).toEqual({ base: ZEN_GO, path: '/chat/completions' });
  });

  it('decodes a base with no appended path to the root', () => {
    expect(decodeForwardPath(forwardBasePath('https://api.example.com'))).toEqual({
      base: 'https://api.example.com',
      path: '/',
    });
  });

  it('strips a trailing slash from the base', () => {
    const decoded = decodeForwardPath(`${forwardBasePath(`${ZEN_GO}/`)}/chat/completions`);
    expect(decoded?.base).toBe(ZEN_GO);
  });

  it('refuses a path that only begins with the prefix', () => {
    expect(decodeForwardPath('/forward/plain')).toBeUndefined();
    expect(decodeForwardPath('/forward/https%3A%2F%2F')).toBeUndefined();
    expect(decodeForwardPath('/forward/%E0%A4%A')).toBeUndefined();
    expect(decodeForwardPath('/forward/a%2Fb/v1/embeddings')).toBeUndefined();
  });

  it('refuses anything that is not a bare http(s) base', () => {
    expect(decodeForwardPath(forwardBasePath('ftp://opencode.ai/x'))).toBeUndefined();
    expect(
      decodeForwardPath(forwardBasePath('https://user:pw@opencode.ai/zen/go/v1')),
    ).toBeUndefined();
    expect(decodeForwardPath(forwardBasePath('https://opencode.ai/x?key=1'))).toBeUndefined();
    expect(decodeForwardPath(forwardBasePath('https://opencode.ai/x#frag'))).toBeUndefined();
  });
});

function stubUpstream(reply: unknown, status = 200) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: String(init.body ?? ''),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
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
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const TURN = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('record mode — a forwarded origin', () => {
  it('forwards to the base the request named and records the real path', async () => {
    const up = stubUpstream({
      id: 'c1',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
    const exchange = proxy.exchanges()[0]!;
    expect(exchange.dialect).toBe('openai');
    expect(exchange.path).toBe('/chat/completions');
    expect(exchange.canonicalRequest.model).toBe('glm-5.3-flash');
  });

  it('keeps the caller auth header upstream and out of the trace', async () => {
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN, {
      authorization: 'Bearer sk-live-9',
    });

    expect(up.calls[0]!.headers['authorization']).toBe('Bearer sk-live-9');
    expect(JSON.stringify(proxy.exchanges()[0])).not.toContain('sk-live-9');
  });

  it('outranks a configured gateway on a live call, because the request names its own destination', async () => {
    // A gateway picked up from `agenticreplay setup` is a default for calls agenticreplay would otherwise have to
    // guess at. A forwarded request announces where it was headed — and the recorded run that
    // exposed this answered every turn with the gateway's website 404 page, because
    // `https://gateway/chat/completions` is not an API path anything serves.
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
  });

  it('does not carry a gateway key to the destination the request named', async () => {
    // `upstreamHeaders` are the gateway's credential. Attaching them to every outbound call used
    // to be harmless because every outbound call went to the gateway; with forwarded requests
    // going to their own origin, it would hand a third party a key they were never meant to see.
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
      upstreamHeaders: { authorization: 'Bearer sk-gateway-key' },
      upstreamHeadersOrigin: 'https://api.orcarouter.ai',
    });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
    expect(up.calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('preserves the explicit origin and model even when obsolete substitution fields are supplied', async () => {
    // Retired runtime fields must not rewrite a recorded client's destination, model or key.
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({
      mode: 'hybrid',
      exchanges: [],
      forkAt: 0,
      forkModel: 'gpt-5.6-luna',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
      upstreamHeaders: { authorization: 'Bearer sk-gateway-key' },
      upstreamHeadersOrigin: 'https://api.orcarouter.ai',
    });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, {
      ...TURN,
      model: 'glm-5.3-flash',
    });

    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
    expect(up.calls[0]!.headers['authorization']).toBeUndefined();
    expect(JSON.parse(up.calls[0]!.body).model).toBe('glm-5.3-flash');
  });

  // `/v1/moderations`, not `/v1/embeddings`, and that is the whole point of these two: an
  // embeddings path is claimed by a retrieval rule now, so a test written about an *unclaimed*
  // tail that keeps using one stops asking its own question. The retrieval half is asserted where
  // it belongs, in `retrieval.test.ts`.
  it('sends an unclaimed tail through passthrough to the forwarded base, past a configured gateway', async () => {
    const up = stubUpstream({ object: 'list', data: [] });
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/v1/moderations`, {
      input: 'hello',
    });

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/v1/moderations`);
    expect(seen[0]).toMatchObject({ host: 'opencode.ai', path: '/v1/moderations', status: 200 });
    expect(proxy.stats().passedThrough).toBe(1);
  });

  it('treats an undecodable /forward/ path as an ordinary unclaimed path', async () => {
    const up = stubUpstream({ ok: true });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/forward/plain`, { input: 'x' });

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe('https://api.openai.com/forward/plain');
  });

  it('answers 404 to a GET on a forwarded path, as to any other', async () => {
    const up = stubUpstream({ ok: true });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('GET');
    expect(up.calls).toHaveLength(0);
  });
});
