import { describe, expect, it } from 'vitest';
import { createProxy, defaultDialects, type RecordedExchange } from '@agenticreplay/proxy';
import { ExchangeEventDeriver } from '../src/exchange-events.js';

const custom = {
  type: 'custom_tool_call',
  id: 'ctc_item',
  call_id: 'call_custom',
  name: 'apply_patch',
  input: '*** Begin Patch\n日本語\n*** End Patch\n',
};
const fn = {
  type: 'function_call',
  id: 'fc_item',
  call_id: 'call_function',
  name: 'read_file',
  arguments: '{"path":"a.ts"}',
};
const output = [custom, fn];
const response = {
  id: 'resp_tools',
  model: 'fixture',
  status: 'completed',
  output,
  usage: { input_tokens: 3, output_tokens: 4 },
};
const expected = [
  { type: 'tool_use', id: 'call_custom', name: 'apply_patch', input: custom.input },
  { type: 'tool_use', id: 'call_function', name: 'read_file', input: { path: 'a.ts' } },
];
const frame = (type: string, fields: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
function stream() {
  return (
    frame('response.created', { response: { ...response, status: 'in_progress', output: [] } }) +
    output
      .map((item, output_index) => {
        const field = item.type === 'custom_tool_call' ? 'input' : 'arguments';
        const prefix =
          item.type === 'custom_tool_call'
            ? 'response.custom_tool_call_input'
            : 'response.function_call_arguments';
        const value = item.type === 'custom_tool_call' ? custom.input : fn.arguments;
        return (
          frame('response.output_item.added', { output_index, item: { ...item, [field]: '' } }) +
          frame(prefix + '.delta', { output_index, item_id: item.id, delta: value.slice(0, 5) }) +
          frame(prefix + '.delta', { output_index, item_id: item.id, delta: value.slice(5) }) +
          frame(prefix + '.done', { output_index, item_id: item.id, [field]: value }) +
          frame('response.output_item.done', { output_index, item }) +
          frame('response.output_item.done', { output_index, item })
        );
      })
      .join('')
  );
}

for (const id of ['openai-responses', 'codex'])
  describe(id + ' custom tool recording', () => {
    const dialect = defaultDialects().find((d) => d.id === id)!;
    it('preserves call IDs, names and raw custom input in JSON and request history', () => {
      for (const [index, item] of output.entries()) {
        expect(dialect.toCanonicalResponse({ ...response, output: [item] })).toMatchObject({
          stop_reason: 'tool_use',
          content: [expected[index]],
        });
      }
      expect(dialect.toCanonicalResponse(response)).toMatchObject({
        stop_reason: 'tool_use',
        content: expected,
      });
      const req = dialect.toCanonicalRequest({
        model: 'fixture',
        input: [
          ...output,
          { type: 'custom_tool_call_output', call_id: custom.call_id, output: 'ok' },
        ],
      });
      expect(req.messages.flatMap((m) => m.content)).toEqual([
        ...expected,
        { type: 'tool_result', tool_use_id: custom.call_id, content: 'ok' },
      ]);
      for (const input of ['', '{"looks":"json"}'])
        expect(
          dialect.toCanonicalResponse({ ...response, output: [{ ...custom, input }] }).content[0],
        ).toMatchObject({ input });
    });
    it('uses done snapshots without duplicating deltas or repeated item.done, with or without terminal output', () => {
      for (const suffix of [
        '',
        frame('response.completed', { response }),
        frame('response.completed', { response: { ...response, output: undefined } }),
      ]) {
        expect(dialect.parseStream(stream() + suffix)).toMatchObject({
          stop_reason: 'tool_use',
          content: expected,
        });
      }
    });
    it('retains delta-only partial tool input when transport ends before done', () => {
      const body =
        frame('response.output_item.added', { output_index: 0, item: { ...custom, input: '' } }) +
        frame('response.custom_tool_call_input.delta', {
          item_id: custom.id,
          output_index: 0,
          delta: 'partial\n',
        });
      expect(dialect.parseStream(body).content).toEqual([{ ...expected[0], input: 'partial\n' }]);
    });
    it('deduplicates replayed SSE sequence numbers without dropping equal distinct deltas', () => {
      const added = frame('response.output_item.added', {
        output_index: 0,
        item: { ...custom, input: '' },
      });
      const delta = frame('response.custom_tool_call_input.delta', {
        sequence_number: 8,
        output_index: 0,
        item_id: custom.id,
        delta: 'x',
      });
      const next = frame('response.custom_tool_call_input.delta', {
        sequence_number: 9,
        output_index: 0,
        item_id: custom.id,
        delta: 'x',
      });
      expect(dialect.parseStream(added + delta + delta + next).content).toEqual([
        { ...expected[0], input: 'xx' },
      ]);
    });
    it('recovers done-only items and does not duplicate text snapshots', () => {
      const done = frame('response.output_item.done', { output_index: 0, item: custom });
      expect(dialect.parseStream(done + done).content).toEqual([expected[0]]);
      const body =
        frame('response.output_text.delta', { output_index: 0, delta: 'hello' }) +
        frame('response.output_item.done', {
          output_index: 0,
          item: { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
        });
      expect(dialect.parseStream(body).content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(
        dialect.toCanonicalResponse({
          ...response,
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        }).stop_reason,
      ).toBe('error');
    });
    it('preserves failure status even if the terminal event is labelled completed', () => {
      expect(
        dialect.parseStream(
          stream() + frame('response.completed', { response: { ...response, status: 'failed' } }),
        ).stop_reason,
      ).toBe('error');
      expect(
        dialect.parseStream(
          stream() +
            frame('response.incomplete', {
              response: { id: response.id, incomplete_details: { reason: 'max_output_tokens' } },
            }),
        ),
      ).toMatchObject({ stop_reason: 'max_tokens', content: expected });
    });
    it('gives incomplete and error terminal states priority over tool_use', () => {
      expect(
        dialect.parseStream(
          stream() +
            frame('response.incomplete', {
              response: {
                ...response,
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
              },
            }),
        ),
      ).toMatchObject({ stop_reason: 'max_tokens', content: expected });
      expect(
        dialect.parseStream(
          stream() +
            frame('response.failed', {
              response: { ...response, status: 'failed', error: { message: 'failure' } },
            }),
        ).stop_reason,
      ).toBe('error');
      expect(
        dialect.parseStream(stream() + frame('error', { message: 'stream failure' })).stop_reason,
      ).toBe('error');
      expect(
        dialect.toCanonicalResponse({ ...response, error: { message: 'failure' } }).stop_reason,
      ).toBe('error');
      expect(
        dialect.toCanonicalResponse({
          ...response,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        }).stop_reason,
      ).toBe('end_turn');
    });
    it('forwards SSE unchanged and derives exactly one tool.call per call', async () => {
      const body = stream() + frame('response.completed', { response });
      const seen: RecordedExchange[] = [];
      const proxy = await createProxy({
        mode: 'record',
        fetchImpl: (async () =>
          new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
        onExchange: (ex) => {
          seen.push(ex);
        },
      });
      try {
        const res = await fetch(proxy.url + dialect.requestPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fixture', input: 'test', stream: true }),
        });
        expect(await res.text()).toBe(body);
        await expect.poll(() => seen.length).toBe(1);
        const events = new ExchangeEventDeriver().derive(seen[0]!, 0);
        expect(events.find((e) => e.type === 'model.response')?.attrs.stop_reason).toBe('tool_use');
        expect(events.filter((e) => e.type === 'tool.call').map((e) => e.attrs)).toEqual(
          expected.map((e) =>
            expect.objectContaining({ tool_use_id: e.id, name: e.name, input: e.input }),
          ),
        );
      } finally {
        await proxy.close();
      }
    });
  });
