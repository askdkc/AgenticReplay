import { openCodexWorktreeCapture } from '../../dist/codex-turn-capture.js';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.argv[2];
const capture = await openCodexWorktreeCapture(root + '/turn.sock', new Map([[root, root]]));
const request = {
  requestId: 'req-1',
  requestStartedAt: Date.now(),
  host: 'chatgpt.com',
  port: 443,
  method: 'POST',
  path: '/responses',
  requestHeaders: {
    'x-codex-turn-metadata': JSON.stringify({
      thread_id: 'chat',
      turn_id: 'turn',
      workspaces: { [root]: {} },
    }),
  },
  requestBytes: Buffer.from('{}'),
  requestTruncated: false,
};
capture.start(request);
capture.model({
  seq: 1,
  requestId: 'req-1',
  dialect: 'codex',
  path: '/responses',
  rawRequest: '{}',
  rawResponse: '{}',
  status: 200,
  streamed: false,
  canonicalRequest: { model: 'test', messages: [] },
  canonicalResponse: {
    id: 'resp',
    model: 'test',
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
capture.finish({
  ...request,
  requestBytes: 2,
  requestBody: '{}',
  responseBody: '{}',
  responseBytes: 2,
  responseHeaders: {},
  status: 200,
  responseComplete: true,
  responseTruncated: false,
  modelDialect: 'codex',
  durationMs: 1,
});
for (let i = 0; i < 100; i++) {
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter(
    (d) => d.isDirectory() && !d.name.startsWith('.'),
  );
  if (
    dirs.length &&
    (
      await fs.readFile(root + '/' + dirs[0].name + '/events.jsonl', 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      })
    ).includes('net.response')
  )
    break;
  await delay(20);
}
process.send?.('recorded');
