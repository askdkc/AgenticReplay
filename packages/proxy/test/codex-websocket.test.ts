import type { IncomingMessage } from 'node:http';
import { setImmediate as tick } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { responseCapture } from '../src/codex-websocket.js';
import type { NetExchange, WebSocketObservation } from '../src/intercept.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const create = () => encode({ type: 'response.create', model: 'fixture', input: [] });
const terminal = (id: string) =>
  encode({ type: 'response.completed', response: { id, status: 'completed', output: [] } });
function fixture(
  maxCaptured = 4096,
  available = 1e6,
  save?: (event: WebSocketObservation) => Promise<void>,
) {
  const exchanges: NetExchange[] = [];
  const observations: WebSocketObservation[] = [];
  let held = 0;
  const capture = responseCapture({ headers: {}, url: '/responses' } as IncomingMessage, {
    target: { host: 'fixture.invalid', port: 443 },
    ca: undefined,
    maxCaptured,
    secretHeaders: new Set(),
    capture: true,
    budget: {
      reserve(bytes) {
        const n = Math.min(bytes, available - held);
        held += n;
        return n;
      },
      release(bytes) {
        held -= bytes;
      },
    },
    callbacks: {
      onNetExchange(exchange) {
        exchanges.push(exchange);
      },
      onWebSocketObservation(event) {
        observations.push(event);
        return save?.(event);
      },
    },
  });
  return { capture, exchanges, observations, held: () => held };
}

it('drains a normal cancellation by its known response ID and retains the incomplete exchange', async () => {
  const { capture, exchanges, observations, held } = fixture();
  capture.request(create(), false);
  capture.response(encode({ type: 'response.created', response: { id: 'old' } }), false);
  capture.request(encode({ type: 'response.cancel', response_id: 'old' }), false);
  capture.response(
    encode({ type: 'response.incomplete', response: { id: 'old', status: 'cancelled' } }),
    false,
  );
  capture.request(create(), false);
  capture.response(terminal('new'), false);
  capture.close();
  capture.close();
  capture.frameFailure('server', Buffer.from('late parser shutdown'));
  await tick();
  expect(exchanges).toHaveLength(2);
  expect(exchanges[0]).toMatchObject({
    correlation: 'matched',
    responseComplete: false,
    captureReasons: ['cancel_observed'],
  });
  expect(exchanges[0]!.abandoned).toBeUndefined();
  expect(exchanges[1]).toMatchObject({ correlation: 'matched', responseComplete: true });
  expect(observations.find((o) => o.recovery === 'cancel_terminal')?.state).toBe('ready');
  expect(observations.filter((o) => o.kind === 'close')).toHaveLength(1);
  expect(observations.at(-1)?.kind).toBe('close');
  expect(held()).toBe(0);
});

it('bounds queued metadata under a stalled writer and drains an explicit omission range before close', async () => {
  const release = Promise.withResolvers<void>();
  const { capture, observations, held } = fixture(4096, 1e6, () => release.promise);
  for (let n = 0; n < 1000; n++) capture.response(terminal('unsolicited'), false);
  capture.close();
  expect(observations).toHaveLength(256);
  release.resolve();
  await capture.drained;
  expect(observations).toHaveLength(258);
  expect(observations.at(-2)).toMatchObject({
    kind: 'diagnostic',
    reason: 'buffer_limit',
    omission: 'buffer_limit',
    sequence: 257,
    throughSequence: 1002,
    omittedObservations: 746,
  });
  expect(observations.at(-1)).toMatchObject({ kind: 'close', sequence: 1003 });
  expect(held()).toBe(0);
});

it.each([
  'overlap',
  'cancel-overlap',
  'mismatch',
  'duplicate',
  'unsolicited',
  'invalid-json',
  'binary',
  'missing-id',
  'cancel-mismatch',
])('keeps %s loss sticky and never gives a delayed reply to the next request', async (scenario) => {
  const { capture, exchanges, observations } = fixture();
  if (scenario === 'unsolicited') capture.response(terminal('old'), false);
  else if (scenario === 'invalid-json') capture.request(Buffer.from('{'), false);
  else if (scenario === 'binary') capture.request(Buffer.from('binary'), true);
  else {
    capture.request(create(), false);
    capture.response(encode({ type: 'response.created', response: { id: 'old' } }), false);
    if (scenario === 'overlap') capture.request(create(), false);
    if (scenario === 'cancel-overlap') {
      capture.request(encode({ type: 'response.cancel' }), false);
      capture.request(create(), false);
    }
    if (scenario === 'mismatch') capture.response(terminal('other'), false);
    if (scenario === 'missing-id') capture.response(encode({ type: 'error' }), false);
    if (scenario === 'cancel-mismatch')
      capture.request(encode({ type: 'response.cancel', response_id: 'other' }), false);
    if (scenario === 'duplicate') {
      capture.response(terminal('old'), false);
      capture.request(create(), false);
      capture.response(terminal('old'), false);
    }
  }
  const boundary = observations.find((o) => o.lostAt !== undefined)!;
  expect(boundary.state).toBe('lost');
  capture.request(create(), false);
  capture.response(terminal('old'), false);
  capture.response(terminal('new'), false);
  await tick();
  const last = exchanges.at(-1)!;
  expect(last.correlation).toBe('lost');
  expect(last.requestBody).toBe(create().toString());
  expect(last.captureReasons).toContain('correlation_lost');
  expect(last.requestTruncated).toBe(false);
  expect(last.abandoned).toBeUndefined();
  const after = observations.filter((o) => o.sequence >= boundary.sequence);
  expect(after.every((o) => o.state === 'lost' && o.lostAt === boundary.sequence)).toBe(true);
  expect(after.filter((o) => o.direction === 'server').at(-1)?.payload).toBe(
    terminal('new').toString(),
  );
});

it('rejects reuse of any completed ID, including one older than the last response', async () => {
  const { capture, exchanges } = fixture();
  for (const id of ['first', 'second', 'first']) {
    capture.request(create(), false);
    capture.response(terminal(id), false);
    await tick();
  }
  expect(exchanges.map((e) => e.correlation)).toEqual(['matched', 'matched', 'lost']);
});

it('correlates standard item-ID deltas after response.created and rejects delayed items from the old response', async () => {
  const { capture, exchanges } = fixture();
  capture.request(create(), false);
  capture.response(encode({ type: 'response.created', response: { id: 'first' } }), false);
  capture.response(
    encode({ type: 'response.output_item.added', item: { id: 'item_old', type: 'message' } }),
    false,
  );
  capture.response(
    encode({ type: 'response.output_text.delta', item_id: 'item_old', delta: 'hello' }),
    false,
  );
  capture.response(terminal('first'), false);
  await tick();
  expect(exchanges[0]?.responseComplete).toBe(true);
  expect(exchanges[0]?.responseBody).toContain('hello');
  capture.request(create(), false);
  capture.response(encode({ type: 'response.created', response: { id: 'second' } }), false);
  capture.response(
    encode({ type: 'response.output_text.delta', item_id: 'item_old', delta: 'late' }),
    false,
  );
  capture.response(terminal('second'), false);
  await tick();
  expect(exchanges[1]?.correlation).toBe('lost');
  expect(exchanges[1]?.responseBody).not.toContain('late');
});

it('initializes independent connections without old response IDs or correlation loss', async () => {
  const first = fixture();
  first.capture.response(terminal('same'), false);
  first.capture.close();
  const second = fixture();
  second.capture.request(create(), false);
  second.capture.response(terminal('same'), false);
  await tick();
  expect(second.exchanges[0]?.responseComplete).toBe(true);
  expect(second.observations[0]).toMatchObject({ state: 'ready', recovery: 'new_connection' });
  expect(second.observations[0]?.connectionId).not.toBe(first.observations[0]?.connectionId);
});

it('does not claim a request with no observed response was matched or client-aborted', async () => {
  const { capture, exchanges } = fixture();
  capture.request(create(), false);
  capture.close();
  await capture.drained;
  expect(exchanges[0]).toMatchObject({
    correlation: 'unconfirmed',
    requestBody: create().toString(),
    responseComplete: false,
    captureReasons: ['connection_closed'],
  });
  expect(exchanges[0]?.abandoned).toBeUndefined();
});

it.each(['body_limit', 'buffer_limit'] as const)(
  'distinguishes %s from correlation loss',
  async (reason) => {
    const { capture, observations, exchanges, held } = fixture(
      reason === 'body_limit' ? 20 : 4096,
      reason === 'buffer_limit' ? 10 : 1e6,
    );
    capture.request(create(), false);
    capture.response(terminal('one'), false);
    await tick();
    expect(observations.find((o) => o.kind === 'message')?.omission).toBe(reason);
    expect(exchanges[0]?.captureReasons).toContain(reason);
    expect(exchanges[0]?.correlation).toBe('matched');
    expect(held()).toBe(0);
  },
);
