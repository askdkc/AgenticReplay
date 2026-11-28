import { describe, expect, it } from 'vitest';
import type { RecordedExchange } from '@agenticreplay/proxy';
import { appendDerivedEvents, ExchangeEventDeriver } from '../src/exchange-events.js';

function exchange(over: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    seq: 0,
    dialect: 'anthropic',
    path: '/v1/messages',
    rawRequest: '{}',
    rawResponse: '{}',
    status: 200,
    streamed: false,
    canonicalRequest: {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fix it' }] }],
    },
    canonicalResponse: {
      id: 'msg_0',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 3 },
    },
    ...over,
  };
}

describe('ExchangeEventDeriver', () => {
  it('releases completed tool payloads after writing their causal edges, without duplicating resent results', async () => {
    const deriver = new ExchangeEventDeriver();
    const written: Array<{ type: string; causes?: number[] }> = [];
    const writer = {
      append: async (event: { type: string; causes?: number[] }) => {
        written.push({ type: event.type, causes: event.causes });
        return { ...event, seq: written.length - 1 };
      },
    };
    for (let turn = 0; turn < 64; turn++) {
      const id = `tool-${turn}`;
      await appendDerivedEvents(
        writer as never,
        deriver,
        exchange({
          canonicalResponse: {
            model: 'fixture',
            content: [
              {
                type: 'tool_use',
                id,
                name: 'write_file',
                input: { content: 'x'.repeat(64 * 1024) },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        turn * 2,
      );
      const callSeq = deriver.seqOf(id);
      const reply = exchange({
        canonicalRequest: {
          model: 'fixture',
          messages: [
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
          ],
        },
      });
      await appendDerivedEvents(writer as never, deriver, reply, turn * 2 + 1);
      expect(written.findLast((event) => event.type === 'tool.result')?.causes).toEqual([callSeq]);
      expect(
        deriver.seqOf(id),
        'completed calls must no longer retain their input payload',
      ).toBeUndefined();
      expect(deriver.unresolved()).toHaveLength(0);
      expect(
        deriver.derive(reply, turn * 2 + 2).some((event) => event.type === 'tool.result'),
      ).toBe(false);
    }
  });

  it('derives a request and a response for a plain exchange', () => {
    const events = new ExchangeEventDeriver().derive(exchange(), 1);
    expect(events.map((e) => e.type)).toEqual(['model.request', 'model.response']);
    expect(events[1]!.attrs.input_tokens).toBe(10);
  });

  it('links the response back to the request it answered', () => {
    const events = new ExchangeEventDeriver().derive(exchange(), 0);
    const requestAt = events.findIndex((e) => e.type === 'model.request');
    const response = events.find((e) => e.type === 'model.response')!;
    // Without this edge `agenticreplay graph --to <a model.response>` finds nothing to walk and reports
    // that the run has no causal edges, however many tool calls it has.
    expect(response.causesIndex).toEqual([requestAt]);
  });

  it('decodes the response thinking into a model.thinking event pointing at its response', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', text: 'The build is red, so run the tests.' },
            { type: 'thinking', text: 'Then fix the import.' },
            { type: 'text', text: 'On it.' },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    const responseAt = events.findIndex((e) => e.type === 'model.response');
    const thinking = events.find((e) => e.type === 'model.thinking');
    expect(thinking, 'a reply that reasoned must log its reasoning').toBeDefined();
    expect(thinking!.actor).toBe('model');
    expect(thinking!.causesIndex).toEqual([responseAt]);
    expect(thinking!.payload).toBe('The build is red, so run the tests.\nThen fix the import.');
    expect(thinking!.attrs['chars']).toBe(56);
  });

  it('derives a tool.call from a tool_use in the response', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'npm test' } }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    expect(events.map((e) => e.type)).toContain('tool.call');
    expect(events.at(-1)!.attrs.name).toBe('bash');
  });

  it('closes a tool call using the result carried by the NEXT request', () => {
    const d = new ExchangeEventDeriver();

    d.restore({ type: 'tool.call', seq: 7, attrs: { tool_use_id: 'tu_1', name: 'bash' } });
    expect(d.unresolved().map((p) => p.id)).toEqual(['tu_1']);

    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'FAIL', is_error: true },
              ],
            },
          ],
        },
      }),
      2,
    );

    expect(next[0]!.type).toBe('tool.result');
    expect(next[0]!.attrs.name).toBe('bash');
    expect(next[0]!.attrs.is_error).toBe(true);
    expect(next[0]!.payload).toBe('FAIL');
    d.restore({ type: 'tool.result', seq: 8, causes: [7], attrs: next[0]!.attrs });
    expect(d.unresolved()).toHaveLength(0);
  });

  it.each([
    ['{"status":"error","output":"[READ_FAILED] failed"}', undefined, true],
    ['{"status":"ok","output":"example: error"}', undefined, false],
    ['{"status":"error","output":"example"}', false, false],
    ['{"status":"error","data":"application result"}', undefined, false],
    ['not JSON', undefined, false],
  ] as const)('classifies a tool receipt %s with provider flag %s', (content, flag, expected) => {
    const events = new ExchangeEventDeriver().deriveToolResults(
      {
        model: 'fixture',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content,
                ...(flag === undefined ? {} : { is_error: flag }),
              },
            ],
          },
        ],
      },
      'trailing',
    );
    expect(events[0]?.attrs.is_error).toBe(expected);
    expect(events[0]?.payload).toBe(content);
  });

  it('links a tool result back to the call that produced it', () => {
    // `causes` is the only thing that turns a flat event list into a chain you can walk, and it was
    // never set on a `tool.result`: `derive()` dropped the pending entry in the same loop that
    // built the event, so by the time the recorder asked for the call's seq there was nothing left
    // to answer with. The recorder does that lookup *after* derive returns, which is why deleting
    // early broke it silently — no error, just an empty field on every tool result ever recorded.
    const d = new ExchangeEventDeriver();

    // The writer assigns the seq and hands it back, exactly as `record` does.
    d.restore({ type: 'tool.call', seq: 7, attrs: { tool_use_id: 'tu_1', name: 'bash' } });

    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
            },
          ],
        },
      }),
      2,
    );

    const result = next.find((e) => e.type === 'tool.result');
    expect(result).toBeDefined();
    expect(d.seqOf('tu_1'), 'the call seq must still be resolvable after derive returns').toBe(7);
  });

  it('emits tool.result before the request that carried it, since the work came first', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'm',
          model: 'm',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      1,
    );
    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'm',
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
            },
          ],
        },
      }),
      2,
    );
    expect(next.map((e) => e.type)).toEqual(['tool.result', 'model.request', 'model.response']);
  });

  it('does not re-emit results for calls already closed on an earlier turn', () => {
    const d = new ExchangeEventDeriver();

    const withResult = {
      model: 'm',
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'ok' }],
        },
      ],
    };
    d.restore({ type: 'tool.call', seq: 7, attrs: { tool_use_id: 'tu_1' } });
    d.restore({
      type: 'tool.result',
      seq: 8,
      causes: [7],
      attrs: { tool_use_id: 'tu_1' },
      payload: 'ok',
    });
    const third = d.derive(exchange({ canonicalRequest: withResult }), 3);
    expect(third.filter((e) => e.type === 'tool.result')).toHaveLength(0);
  });

  it('reports a tool call whose result never arrived rather than dropping it', () => {
    const d = new ExchangeEventDeriver();

    d.restore({ type: 'tool.call', seq: 7, attrs: { tool_use_id: 'tu_orphan' } });
    expect(d.unresolved().map((p) => p.id)).toEqual(['tu_orphan']);
  });

  it('survives an exchange whose response could not be canonicalized', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({ canonicalResponse: undefined, rawResponse: 'not json' }),
      1,
    );
    expect(events.map((e) => e.type)).toEqual(['model.request', 'model.response']);
    expect(events[1]!.attrs.stop_reason).toBe('unknown');
  });
});

/**
 * A `tool_use` block is physically inside the response that emitted it, and a `tool_result` block
 * is physically inside the request that carried it back. Neither is an inference, so both belong
 * in `causes` — but the deriver has no seqs, which only exist once the writer has appended. It
 * names positions in its own batch instead, and the recorder resolves them.
 */
describe('ExchangeEventDeriver causal references', () => {
  const withToolUse = exchange({
    canonicalResponse: {
      id: 'msg_0',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'npm test' } }],
      usage: { input_tokens: 10, output_tokens: 3 },
    },
  });

  it('points a tool.call at the model.response that emitted it', () => {
    const events = new ExchangeEventDeriver().derive(withToolUse, 1);
    const responseAt = events.findIndex((e) => e.type === 'model.response');
    const call = events.find((e) => e.type === 'tool.call');
    expect(call?.causesIndex).toEqual([responseAt]);
  });

  it('points a model.request at the tool.result it carried back', () => {
    const d = new ExchangeEventDeriver();
    d.derive(withToolUse, 1);
    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
            },
          ],
        },
      }),
      2,
    );
    const resultAt = next.findIndex((e) => e.type === 'tool.result');
    const request = next.find((e) => e.type === 'model.request');
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(request?.causesIndex).toEqual([resultAt]);
  });

  it('leaves the reference off a request that carried no result, rather than naming nothing', () => {
    const events = new ExchangeEventDeriver().derive(exchange(), 1);
    expect(events.find((e) => e.type === 'model.request')?.causesIndex).toBeUndefined();
  });

  it('names every result when one request carries several', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
            { type: 'tool_use', id: 'tu_2', name: 'edit', input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'a' },
                { type: 'tool_result', tool_use_id: 'tu_2', content: 'b' },
              ],
            },
          ],
        },
      }),
      2,
    );
    expect(next.find((e) => e.type === 'model.request')?.causesIndex).toEqual([0, 1]);
  });

  it('points both tool.calls of one response at that same response', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
            { type: 'tool_use', id: 'tu_2', name: 'edit', input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    const responseAt = events.findIndex((e) => e.type === 'model.response');
    const calls = events.filter((e) => e.type === 'tool.call');
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.causesIndex).toEqual([responseAt]);
  });
});

it('releases a known OpenAI call when a separate image observation follows its result', async () => {
  const deriver = new ExchangeEventDeriver();
  const events: Array<{ type: string; causes?: number[] }> = [];
  const writer = {
    append: async (event: { type: string; causes?: number[] }) => ({
      ...event,
      seq: events.push(event) - 1,
    }),
  };
  const call = exchange({
    dialect: 'openai',
    canonicalResponse: {
      ...exchange().canonicalResponse!,
      content: [
        { type: 'tool_use', id: 'frame', name: 'view_image', input: { path: 'frame.png' } },
      ],
    },
  });
  await appendDerivedEvents(writer as never, deriver, call, 1);
  const callSeq = deriver.seqOf('frame');
  const reply = exchange({
    dialect: 'openai',
    canonicalRequest: {
      model: 'fixture',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old' }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'frame', content: 'frame.png' }],
        },
        { role: 'user', content: [{ type: 'image', media_type: 'image/png', data: 'AA==' }] },
      ],
    },
  });
  await appendDerivedEvents(writer as never, deriver, reply, 2);
  await appendDerivedEvents(writer as never, deriver, reply, 3);
  expect(
    events.filter((event) => event.type === 'tool.result').map((event) => event.causes),
  ).toEqual([[callSeq]]);
  expect(deriver.seqOf('frame')).toBeUndefined();
  expect(deriver.unresolved()).toEqual([]);
});

describe('persisted tool calls', () => {
  const call = exchange({
    canonicalResponse: {
      ...exchange().canonicalResponse!,
      content: [{ type: 'tool_use', id: 'call_1', name: 'command', input: {} }],
    },
  });
  const result = exchange({
    canonicalRequest: {
      model: 'fixture',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'observed' }],
        },
      ],
    },
  });
  it.each(['tool.call', 'tool.result'])(
    'bases pending calls on disk when %s fails',
    async (failure) => {
      const d = new ExchangeEventDeriver();
      let seq = 0;
      const writer = {
        append: async (event: { type: string }) => {
          if (event.type === failure) throw new Error('write failed');
          return { ...event, seq: seq++ };
        },
      };
      if (failure === 'tool.call') {
        await expect(appendDerivedEvents(writer as never, d, call, 1)).rejects.toThrow(
          'write failed',
        );
        expect(d.unresolved()).toEqual([]);
      } else {
        await appendDerivedEvents(writer as never, d, call, 1);
        await expect(appendDerivedEvents(writer as never, d, result, 2)).rejects.toThrow(
          'write failed',
        );
        expect(d.unresolved().map((c) => c.id)).toEqual(['call_1']);
      }
    },
  );
});

it('keeps attempts with a reused ID independent, including after restoring the persisted events', async () => {
  const d = new ExchangeEventDeriver();
  const events: Array<{
    seq: number;
    type: string;
    attrs?: Record<string, unknown>;
    causes?: number[];
  }> = [];
  const writer = {
    append: async (init: (typeof events)[number]) => {
      const event = { ...init, seq: events.length };
      events.push(event);
      return event;
    },
  };
  const use = (attempt: number) => ({
    type: 'tool_use' as const,
    id: 'reused',
    name: 'lookup',
    input: { attempt },
  });
  const receipt = {
    role: 'user' as const,
    content: [{ type: 'tool_result' as const, tool_use_id: 'reused', content: 'done' }],
  };
  for (const attempt of [1, 2]) {
    const e = exchange({
      canonicalResponse: { ...exchange().canonicalResponse!, content: [use(attempt)] },
    });
    await appendDerivedEvents(writer as never, d, e, attempt);
  }
  const reply = (attempt?: number) =>
    exchange({
      canonicalRequest: {
        model: 'fixture',
        messages: [
          ...(attempt ? [{ role: 'assistant' as const, content: [use(attempt)] }] : []),
          receipt,
        ],
      },
    });
  await appendDerivedEvents(writer as never, d, reply(), 3);
  expect(d.unresolved()).toHaveLength(2);
  expect(events.find((e) => e.type === 'tool.result')).toMatchObject({
    attrs: { correlation: 'ambiguous' },
  });
  const recovered = new ExchangeEventDeriver();
  for (const event of events) recovered.restore(event);
  await appendDerivedEvents(writer as never, recovered, reply(2), 4);
  await appendDerivedEvents(writer as never, recovered, reply(2), 5);
  const calls = events.filter((e) => e.type === 'tool.call');
  expect(recovered.unresolved().map((c) => c.seq)).toEqual([calls[0]!.seq]);
  await appendDerivedEvents(writer as never, recovered, reply(1), 6);
  expect(events.filter((e) => e.type === 'tool.result').map((e) => e.causes)).toEqual([
    undefined,
    [calls[1]!.seq],
    [calls[0]!.seq],
  ]);
  expect(recovered.unresolved()).toEqual([]);
});

it.each(['tool.call', 'tool.result'])(
  'ignores a saved %s when the writer receipt has no correlation key',
  async (type) => {
    const d = new ExchangeEventDeriver();
    d.restore({ type: 'tool.call', seq: 8, attrs: { tool_use_id: 'original' } });
    const writer = {
      append: async () => ({
        type,
        seq: 9,
        attrs: { payload_omitted: 'event_storage_limit' },
        causes: [8],
      }),
    };
    const e = exchange({
      canonicalResponse: {
        ...exchange().canonicalResponse!,
        content: [{ type: 'tool_use', name: 'lookup', id: 'new', input: {} }],
      },
      canonicalRequest: {
        model: 'fixture',
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'original', content: 'done' }],
          },
        ],
      },
    });
    await appendDerivedEvents(writer as never, d, e, 1);
    expect(d.unresolved().map((c) => c.id)).toEqual(['original']);
  },
);

it('recovers legacy ID-only results only for a unique saved call', () => {
  const d = new ExchangeEventDeriver();
  const attrs = { tool_use_id: 'legacy' };
  d.restore({ type: 'tool.call', seq: 1, attrs });
  d.restore({ type: 'tool.result', seq: 2, attrs });
  expect(d.unresolved()).toEqual([]);
  d.restore({ type: 'tool.call', seq: 3, attrs });
  d.restore({ type: 'tool.result', seq: 4, attrs });
  expect(d.unresolved().map((c) => c.seq)).toEqual([3]);
});

it('leaves indistinguishable attempts open even when the request echoes their tool arguments', () => {
  const d = new ExchangeEventDeriver();
  const attrs = { tool_use_id: 'same', name: 'lookup', input: { q: 'q' } };
  for (const turn of [1, 2]) d.restore({ type: 'tool.call', seq: turn, turn, attrs });
  const [result] = d.deriveToolResults(
    {
      model: 'fixture',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'same', name: 'lookup', input: attrs.input }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'reply' }] },
      ],
    },
    'known',
  );
  expect(result?.attrs.correlation).toBe('ambiguous');
  expect(result?.callSeq).toBeUndefined();
  d.restore({ type: 'tool.result', seq: 3, attrs: result!.attrs, payload: 'reply' });
  expect(d.unresolved().map((c) => c.seq)).toEqual([1, 2]);
});
