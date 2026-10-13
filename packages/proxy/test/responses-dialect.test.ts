import { afterEach, describe, expect, it } from 'vitest';
import { defaultDialects, selectDialect } from '../src/index.js';
import type { RecordedExchange, RouteDecision } from '../src/server.js';
import { createProxy } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * The Responses API is the default wire format for the OpenAI Agents SDK and the Codex CLI.
 * Before this dialect existed the proxy claimed exactly two shapes — `/v1/messages` and anything
 * ending `/chat/completions` — and answered `404` to everything else, so `agenticreplay record codex`
 * killed the agent on its first turn rather than merely failing to capture it.
 */

const RESPONSES_BODY = {
  model: 'gpt-5.2',
  instructions: 'be careful',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'fix the auth test' }] }],
  tools: [{ type: 'function', name: 'edit_file', parameters: { type: 'object' } }],
};

const RESPONSES_REPLY = {
  id: 'resp_01',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.2',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'editing auth.ts now' }],
    },
  ],
  usage: { input_tokens: 12, output_tokens: 7 },
};

function stubUpstream(reply: unknown, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? '') });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

describe('the responses dialect is wired into the default set', () => {
  it('claims /v1/responses', () => {
    expect(selectDialect(defaultDialects(), '/v1/responses')?.id).toBe('openai-responses');
  });

  it('claims the path however the SDK joined the base url', () => {
    const dialects = defaultDialects();
    expect(selectDialect(dialects, '/responses')?.id).toBe('openai-responses');
    expect(selectDialect(dialects, '/openai/v1/responses')?.id).toBe('openai-responses');
  });

  it('does not steal the paths the other dialects already claimed', () => {
    const dialects = defaultDialects();
    expect(selectDialect(dialects, '/v1/messages')?.id).toBe('anthropic');
    expect(selectDialect(dialects, '/v1/chat/completions')?.id).toBe('openai');
  });

  
});

describe('recording a responses run', () => {
  it('forwards and returns the upstream reply instead of answering 404', async () => {
    const up = stubUpstream(RESPONSES_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/responses`, RESPONSES_BODY);

    expect(res.status).toBe(200);
    expect(res.json).toEqual(RESPONSES_REPLY);
    expect(up.calls[0]!.url).toContain('/v1/responses');
  });

  it('records the exchange with both raw bytes and the canonical form', async () => {
    const up = stubUpstream(RESPONSES_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/responses`, RESPONSES_BODY);

    expect(seen).toHaveLength(1);
    const ex = seen[0]!;
    expect(ex.dialect).toBe('openai-responses');
    expect(ex.rawRequest).toContain('fix the auth test');
    expect(ex.canonicalRequest.model).toBe('gpt-5.2');
    expect(ex.canonicalRequest.system).toBe('be careful');
    expect(ex.canonicalResponse?.content[0]).toEqual({
      type: 'text',
      text: 'editing auth.ts now',
    });
    expect(ex.usage?.input_tokens).toBe(12);
  });
});




