import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createProxy, type NetExchange } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks();
});

const request = JSON.stringify({ model: 'local', messages: [{ role: 'user', content: 'hello' }] });
const reply = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
const path = '/v1/chat/completions';

function post(url: string, signal?: AbortSignal) {
  return fetch(url, { method: 'POST', body: request, signal });
}

function connectFailure() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('private diagnostic'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
}

it('keeps a model turn pending across connection failures and delivers it once after recovery', async () => {
  const received: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply);
  });
  const listen = (port: number) =>
    new Promise<void>((resolve) => upstream.listen(port, '127.0.0.1', resolve));
  const close = () => new Promise<void>((resolve) => upstream.close(() => resolve()));
  await listen(0);
  const port = (upstream.address() as AddressInfo).port;
  const target = 'http://127.0.0.1:' + port;
  await close();
  closers.push(close);
  let failures = 0;
  const net: NetExchange[] = [];
  const proxy = await createProxy({
    fetchImpl: async (url, init) => {
      try {
        return await fetch(url, init);
      } catch (error) {
        if (++failures === 2) await listen(port);
        throw error;
      }
    },
    onNetExchange: (exchange) => void net.push(exchange),
  });
  closers.push(proxy.close);
  const response = await post(proxy.url + '/forward/' + encodeURIComponent(target) + path);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(reply);
  expect(failures).toBe(2);
  expect(received).toEqual([request]);
  expect(net.map((e) => e.status)).toEqual([200]);
  expect(proxy.exchanges().map((e) => e.rawResponse)).toEqual([reply]);
});

it('cancels a disconnected model turn during backoff without recording a model response', async () => {
  const first = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<NetExchange>();
  const attempt = vi.fn(async () => {
    first.resolve();
    throw connectFailure();
  });
  const proxy = await createProxy({ fetchImpl: attempt, onNetExchange: terminal.resolve });
  closers.push(proxy.close);
  const abort = new AbortController();
  const pending = post(proxy.url + path, abort.signal).catch(() => undefined);
  await first.promise;
  abort.abort();
  await pending;
  expect(await terminal.promise).toMatchObject({ abandoned: true, status: 0 });
  expect(proxy.exchanges()).toHaveLength(0);
  expect(attempt).toHaveBeenCalledTimes(1);
});

it('keeps an ambiguous socket failure terminal and shows the transport code without cause text', async () => {
  const attempt = vi.fn(async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('private diagnostic'), { code: 'UND_ERR_SOCKET' }),
    });
  });
  const terminal = Promise.withResolvers<NetExchange>();
  const proxy = await createProxy({
    upstream: { openai: 'http://user:secret@up.example:8888' },
    fetchImpl: attempt,
    onNetExchange: terminal.resolve,
  });
  closers.push(proxy.close);
  const text = await (await post(proxy.url + path)).text();
  expect(text).toContain('UND_ERR_SOCKET');
  expect(text).toContain('up.example:8888');
  expect(text).not.toMatch(/secret|private diagnostic/);
  expect((await terminal.promise).responseError).toContain('UND_ERR_SOCKET');
  expect(attempt).toHaveBeenCalledTimes(1);
});

it('ends repeated connect timeouts with the last transport code and one recorded error', async () => {
  const clock = vi.spyOn(performance, 'now');
  const attempt = vi.fn(async () => {
    if (attempt.mock.calls.length === 2) clock.mockReturnValue(Infinity);
    throw connectFailure();
  });
  const proxy = await createProxy({ fetchImpl: attempt });
  closers.push(proxy.close);
  const response = await post(proxy.url + path);
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).toContain('2 attempts');
  expect(text).toContain('UND_ERR_CONNECT_TIMEOUT');
  expect(proxy.exchanges().map((e) => e.rawResponse)).toEqual([text]);
});

it('does not resend a streamed upload or a POST with an uncertain delivery outcome', async () => {
  const mixed = new AggregateError([
    Object.assign(new Error(), { code: 'ENETUNREACH', syscall: 'connect' }),
    Object.assign(new Error(), { code: 'ECONNRESET', syscall: 'read' }),
  ]);
  const attempt = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('fetch failed', { cause: mixed }))
    .mockRejectedValue(connectFailure());
  const proxy = await createProxy({ fetchImpl: attempt, maxCapturedBytes: 256 });
  closers.push(proxy.close);
  expect((await post(proxy.url + path)).status).toBe(500);
  expect(attempt).toHaveBeenCalledTimes(1);
  const streamed = await fetch(proxy.url + path, { method: 'POST', body: 'x'.repeat(512) });
  expect(streamed.status).toBe(500);
  expect(await streamed.text()).toContain('UND_ERR_CONNECT_TIMEOUT');
  expect(attempt).toHaveBeenCalledTimes(2);
});

it('drains an accepted model call when the recorder closes while waiting for its headers', async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const ready = Promise.withResolvers<void>();
  const proxy = await createProxy({
    fetchImpl: async (_url, init) => {
      started.resolve(init!.signal!);
      await ready.promise;
      init!.signal!.throwIfAborted();
      return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = post(proxy.url + path);
  await started.promise;
  const closed = proxy.close();
  ready.resolve();
  expect(await (await response).text()).toBe(reply);
  await closed;
});
