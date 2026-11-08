/**
 * Node-TAP acceptance check for the `model.thinking` event, run with `node --test` so the
 * completion gate can observe plain Node TAP output. It imports the built implementation
 * (packages/cli/dist) rather than the vitest sources, so it doubles as a check that the
 * shipped artifact emits the decoded-thinking event.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExchangeEventDeriver } from '../dist/exchange-events.js';

function exchange(over = {}) {
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

test('a reasoned reply logs its decoded thinking as a model.thinking event', () => {
  const events = new ExchangeEventDeriver().derive(
    exchange({
      canonicalResponse: {
        id: 'msg_0',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', text: 'The build is red, so run the tests.' },
          { type: 'text', text: 'On it.' },
        ],
        usage: { input_tokens: 10, output_tokens: 3 },
      },
    }),
    1,
  );
  const responseAt = events.findIndex((e) => e.type === 'model.response');
  const thinking = events.find((e) => e.type === 'model.thinking');
  assert.ok(thinking, 'a reply that reasoned must log its reasoning');
  assert.equal(thinking.actor, 'model');
  assert.deepEqual(thinking.causesIndex, [responseAt]);
  assert.equal(thinking.payload, 'The build is red, so run the tests.');
  assert.equal(thinking.attrs.chars, 35);
});

test('a reply without reasoning logs no model.thinking event', () => {
  const events = new ExchangeEventDeriver().derive(exchange(), 1);
  assert.deepEqual(
    events.map((e) => e.type),
    ['model.request', 'model.response'],
  );
});
