// Native Codex acceptance: synthetic credentials, isolated config, independent endpoint.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const root = await mkdtemp('/private/tmp/ar-codex-native-');
await mkdir(join(root, 'codex'));
const requests = [];
const body = {
  id: 'resp_fixture',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.4',
  output: [
    {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'CODEX_TRAILING_SENTINEL', annotations: [] }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
};
const response = `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...body, status: 'in_progress', output: [] } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ url: req.url, body, authorization: req.headers.authorization });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(response);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
await writeFile(join(root, 'codex/config.toml'), 'model="gpt-5.4"\n');
await writeFile(
  join(root, 'codex/auth.json'),
  JSON.stringify({ OPENAI_API_KEY: 'fixture-api-key' }),
);
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: root,
  CODEX_HOME: join(root, 'codex'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  OPENAI_API_KEY: 'fixture-api-key',
  AGENTICREPLAY_UPSTREAM_OPENAI: base,
};
const child = spawn(
  process.execPath,
  [
    process.env.AGENTICREPLAY_TEST_CLI ?? join(process.cwd(), 'packages/cli/dist/cli.js'),
    'record',
    'codex',
    '--no-fs',
    '--no-shell',
    '--json',
    '--',
    'exec',
    '--skip-git-repo-check',
    'CODEX_SYSTEM_REQUEST_SENTINEL. Reply briefly without tools.',
  ],
  { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let stdout = '',
  stderr = '';
child.stdout.on('data', (c) => (stdout += c));
child.stderr.on('data', (c) => (stderr += c));
const timer = setTimeout(() => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
}, 60000);
const result = await new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
clearTimeout(timer);
server.closeAllConnections();
server.close();
assert.ok([0, 2].includes(result.code), stderr);
assert.ok(requests.length > 0, 'native Codex bypassed capture');
const run = JSON.parse(stdout.trim());
const { TraceReader } = await import(
  pathToFileURL(
    process.env.AGENTICREPLAY_TEST_TRACE_READER ??
      join(process.cwd(), 'packages/core/dist/index.js'),
  ).href
);
const reader = await TraceReader.open(run.runDir);
const events = await reader.events();
const captured = events.filter(
  (e) => e.type === 'net.request' && e.attrs.phase === 'body' && e.attrs.method === 'POST',
);
const responses = events.filter(
  (e) =>
    e.type === 'net.response' &&
    captured.some((request) => request.attrs.request_id === e.attrs.request_id),
);
const unsupported = events.filter((e) => e.type === 'net.response' && e.attrs.capture_incomplete);
assert.equal(result.code, unsupported.length ? 2 : 0);
assert.equal(captured.length, requests.length);
assert.equal(responses.length, requests.length);
for (let i = 0; i < requests.length; i++) {
  assert.equal(requests[i].authorization, 'Bearer fixture-api-key');
  // The random temporary directory name can trigger high-entropy redaction in Codex's
  // system skill paths. Permit only that explicit fixture-path transformation.
  const comparable = (text) =>
    text
      .replaceAll(root, '/private/tmp/<fixture-root>')
      .replace(/\/private\/tmp\/<secret:high_entropy:[0-9a-f]{8}>/g, '/private/tmp/<fixture-root>');
  const actual = comparable(await reader.resolvePayload(captured[i]));
  const expected = comparable(requests[i].body);
  assert.ok(actual === expected, 'captured request differs after expected fixture-path redaction');
  assert.equal(await reader.resolvePayload(responses[i]), response);
  const parsed = JSON.parse(requests[i].body);
  assert.ok(parsed.instructions.length > 0);
  assert.ok(parsed.tools.length > 0);
  assert.ok(requests[i].body.includes('CODEX_SYSTEM_REQUEST_SENTINEL'));
}
assert.ok(!JSON.stringify(events).includes('fixture-api-key'));
console.log(
  JSON.stringify({
    root,
    ...result,
    requests: requests.length,
    unsupportedAttempts: unsupported.length,
    exactAfterExpectedRedaction: true,
    system: true,
    tools: true,
    runDir: run.runDir,
  }),
);
