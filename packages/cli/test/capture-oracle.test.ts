import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TraceReader, TraceWriter } from '@agenticreplay/core';
import { createProxy } from '@agenticreplay/proxy';
import { persistNetExchange, persistNetRequestStart } from '../src/tls-capture.js';

// The expected bodies come from the endpoint's own log, not a recorder translator/redactor.
const secret = 'sk-' + 'a'.repeat(32);
const protocols = [
  {
    name: 'Responses',
    path: '/v1/responses',
    body: {
      instructions: 'SYSTEM_SENTINEL',
      input: [
        { role: 'user', content: 'question' },
        { type: 'function_call_output', call_id: 'call_one', output: 'TOOL_RESULT_SENTINEL' },
      ],
      tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }],
    },
  },
  {
    name: 'Chat Completions',
    path: '/v1/chat/completions',
    body: {
      messages: [
        { role: 'system', content: 'SYSTEM_SENTINEL' },
        { role: 'tool', tool_call_id: 'call_one', content: 'TOOL_RESULT_SENTINEL' },
      ],
      tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object' } } }],
    },
  },
  ...['Anthropic Messages', 'DeepSeek Messages'].map((name) => ({
    name,
    path: '/v1/messages',
    body: {
      system: 'SYSTEM_SENTINEL',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_one', content: 'TOOL_RESULT_SENTINEL' },
          ],
        },
      ],
      tools: [{ name: 'probe', input_schema: { type: 'object' } }],
    },
  })),
];

for (const protocol of protocols)
  for (const streamed of [false, true]) {
    it(`retains independent endpoint bytes for ${protocol.name} ${streamed ? 'SSE' : 'JSON'}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ar-oracle-'));
      const received: string[] = [];
      const response = JSON.stringify({
        id: 'response_one',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'TRAILING_SENTINEL' }],
        output: [],
        choices: [],
        usage: { input_tokens: 9 },
        reasoning: 'RETURNED_REASONING',
        unknown: { credential: secret },
      });
      const sent = streamed ? `event: message\ndata: ${response}\n\ndata: [DONE]\n\n` : response;
      const origin = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': streamed ? 'text/event-stream' : 'application/json' });
        const split = sent.indexOf(secret) + 8;
        res.write(sent.slice(0, split));
        setImmediate(() => res.end(sent.slice(split)));
      });
      await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
      const port = (origin.address() as { port: number }).port;
      const writer = await TraceWriter.create(dir, {
        adapter: { id: 'oracle' },
        cwd: dir,
        argv: [],
        agenticreplayVersion: '0.5.0',
        envAllowlist: [],
      });
      const writes: Promise<void>[] = [];
      const proxy = await createProxy({
        mode: 'record',
        upstream: {
          openai: `http://127.0.0.1:${port}`,
          'openai-responses': `http://127.0.0.1:${port}`,
          anthropic: `http://127.0.0.1:${port}`,
        },
        fetchImpl: ((url, init) => {
          if (new URL(String(url)).origin !== `http://127.0.0.1:${port}`)
            throw new Error('oracle refuses non-local egress');
          return fetch(url, init);
        }) as typeof fetch,
        onRequestStart: (request) => persistNetRequestStart(writer, 1, request),
        onNetExchange: (exchange) => {
          writes.push(persistNetExchange(writer, 1, exchange));
        },
      });
      try {
        const request = JSON.stringify(
          {
            model: protocol.name === 'DeepSeek Messages' ? 'deepseek-chat' : 'stub',
            max_tokens: 10,
            stream: streamed,
            ...protocol.body,
            unknown: { preserved: 'context '.repeat(140_000), credential: secret },
          },
          null,
          1,
        );
        const response = await fetch(`${proxy.url}${protocol.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer hidden-header' },
          body: request,
        });
        expect(await response.text()).toBe(sent);
        await Promise.all(writes);
        await writer.close(0);
        expect(received).toEqual([request]);
        const reader = await TraceReader.open(writer.runDir);
        const events = await reader.events();
        const req = events.find(
          (event) => event.type === 'net.request' && event.attrs?.phase === 'body',
        )!;
        const res = events.find((event) => event.type === 'net.response')!;
        expect(req.attrs?.boundary).toBe('http-proxy');
        expect(req.attrs?.intercepted).toBe(false);
        // Only the explicitly planted credential may change. Salt/hash output is deliberately ignored.
        const normalize = (text: string) =>
          text.replace(/<secret:sk_api_key:[a-f0-9]{8}>/g, '[REMOVED]');
        expect(normalize((await reader.resolvePayload(req)) as string)).toBe(
          received[0]!.replaceAll(secret, '[REMOVED]'),
        );
        expect(normalize((await reader.resolvePayload(res)) as string)).toBe(
          sent.replaceAll(secret, '[REMOVED]'),
        );
        expect(res.attrs?.response_complete).toBe(true);
        expect(res.attrs?.capture_incomplete).toBe(false);
        expect(JSON.stringify(events)).not.toContain('hidden-header');
        expect(req.transformations).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: 'redaction', count: 1 })]),
        );
      } finally {
        await proxy.close();
        await Promise.allSettled(writes);
        await writer.close(0);
        origin.closeAllConnections();
        await new Promise<void>((resolve) => origin.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
