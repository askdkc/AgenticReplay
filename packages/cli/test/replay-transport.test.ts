import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TraceReader, TraceWriter } from '@agenticreplay/core';
import { loadExchanges } from '../src/commands/replay.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function writer() {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-wire-'));
  dirs.push(dir);
  return TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: [],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
  });
}
const request = JSON.stringify({
  model: 'test',
  messages: [{ role: 'user', content: 'wire sentinel' }],
  unknown_field: { keep: true },
});

it('never fabricates a replay response from a logical request without transport evidence', async () => {
  const w = await writer();
  await w.append({
    type: 'model.request',
    actor: 'agent',
    attrs: { dialect: 'openai' },
    payload: request,
  });
  await w.close(0);
  expect(await loadExchanges(await TraceReader.open(w.runDir))).toEqual([]);
});

it('pairs complete transport bodies by identity and rejects interrupted attempts', async () => {
  const w = await writer();
  const requests = [];
  for (let i = 0; i < 3; i++)
    requests.push(
      await w.append({
        type: 'net.request',
        actor: 'agent',
        attrs: {
          phase: 'body',
          request_id: `attempt-${i}`,
          model_dialect: 'openai',
          path: '/v1/chat/completions',
          capture_incomplete: false,
        },
        payload: request,
      }),
    );
  for (const i of [2, 1, 0])
    await w.append({
      type: 'net.response',
      actor: 'agenticreplay',
      causes: [requests[i]!.seq],
      attrs: {
        request_id: `attempt-${i}`,
        status: i === 0 ? 500 : 200,
        response_complete: i !== 1,
        capture_incomplete: i === 1,
      },
      payload: JSON.stringify({ sentinel: `response-${i}` }),
    });
  await w.close(0);
  const exchanges = await loadExchanges(await TraceReader.open(w.runDir));
  expect(exchanges).toHaveLength(2);
  expect(exchanges.map((e) => e.status)).toEqual([500, 200]);
  expect(exchanges.map((e) => e.rawResponse)).toEqual([
    JSON.stringify({ sentinel: 'response-0' }),
    JSON.stringify({ sentinel: 'response-2' }),
  ]);
  expect(exchanges[0]!.rawRequest).toBe(request);
});

it('does not replay origin bytes that were translated before reaching the client', async () => {
  const w = await writer();
  const req = await w.append({
    type: 'net.request',
    actor: 'agent',
    attrs: {
      phase: 'body',
      request_id: 'translated-attempt',
      model_dialect: 'openai',
      path: '/v1/chat/completions',
    },
    payload: request,
  });
  await w.append({
    type: 'net.response',
    actor: 'agenticreplay',
    causes: [req.seq],
    attrs: { request_id: 'translated-attempt', status: 200, response_complete: true },
    transformations: [
      {
        kind: 'encoding',
        location: 'response.body',
        rule: 'provider-protocol-translation',
        count: 1,
        reason: 'openai response translated to anthropic for the client',
      },
    ],
    payload: '{"choices":[{"message":{"content":"origin body"}}]}',
  });
  await w.close(0);
  expect(await loadExchanges(await TraceReader.open(w.runDir))).toEqual([]);
});
