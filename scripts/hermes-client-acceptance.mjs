// Native Hermes TLS acceptance. Set AGENTICREPLAY_TEST_HERMES to the isolated executable.
// Uses synthetic credentials and a loopback origin; nip.io DNS requires network access.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = await mkdtemp('/private/tmp/ar-hermes-native-');
const home = join(root, 'home');
await mkdir(home);
const hermes = process.env.AGENTICREPLAY_TEST_HERMES;
assert.ok(hermes, 'AGENTICREPLAY_TEST_HERMES must name an isolated Hermes installation');
const host = '127.0.0.1.nip.io';
const cert = join(root, 'cert.pem');
const key = join(root, 'key.pem');
await promisify(execFile)('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  key,
  '-out',
  cert,
  '-days',
  '1',
  '-subj',
  `/CN=${host}`,
  '-addext',
  `subjectAltName=DNS:${host}`,
]);
const calls = [];
const stream = `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'HERMES_TRAILING_SENTINEL' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'stub-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\ndata: [DONE]\n\n`;
const server = createServer(
  { key: await readFile(key), cert: await readFile(cert) },
  async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const response =
      req.url === '/v1/models'
        ? JSON.stringify({
            object: 'list',
            data: [{ id: 'stub-model', object: 'model', owned_by: 'fixture' }],
          })
        : stream;
    calls.push({ path: req.url, body, response });
    res.writeHead(200, {
      'content-type': req.url === '/v1/models' ? 'application/json' : 'text/event-stream',
    });
    res.write(response.slice(0, -12));
    setTimeout(() => res.end(response.slice(-12)), 10);
  },
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await writeFile(
  join(home, 'config.yaml'),
  `_config_version: 12\nmodel:\n  provider: custom\n  default: stub-model\n  base_url: https://${host}:${server.address().port}/v1\n  api_key: fixture-key\n  context_length: 64000\n`,
);
const cli = process.env.AGENTICREPLAY_TEST_CLI ?? join(process.cwd(), 'packages/cli/dist/cli.js');
const env = {
  PATH: `${dirname(process.execPath)}:${dirname(hermes)}:/opt/homebrew/bin:/usr/bin:/bin`,
  HOME: home,
  HERMES_HOME: home,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  PYTHONNOUSERSITE: '1',
  PYTHONUNBUFFERED: '1',
  NODE_EXTRA_CA_CERTS: cert,
  OPENAI_API_KEY: 'fixture-key',
};
const child = spawn(
  process.execPath,
  [
    cli,
    'record',
    'hermes',
    '--tls-intercept',
    '--tls-hosts',
    `+${host}`,
    '--no-agent-spans',
    '--no-fs',
    '--no-shell',
    '--json',
    '--',
    '--provider',
    'custom',
    '--model',
    'stub-model',
    '--no-restore-cwd',
    '-z',
    'HERMES_SYSTEM_REQUEST_SENTINEL',
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
}, 45000);
const outcome = await new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
clearTimeout(timer);
server.closeAllConnections();
server.close();
assert.ok([0, 2].includes(outcome.code), stderr);
assert.ok(stderr.includes('HERMES_TRAILING_SENTINEL'), stderr);
const run = JSON.parse(stdout.trim());
assert.equal(run.childExitCode, 0);
const { TraceReader } = await import(
  pathToFileURL(
    process.env.AGENTICREPLAY_TEST_TRACE_READER ??
      join(process.cwd(), 'packages/core/dist/index.js'),
  ).href
);
const reader = await TraceReader.open(run.runDir);
const events = await reader.events();
const requests = events.filter((e) => e.type === 'net.request' && e.attrs.phase === 'body');
const responses = events.filter((e) => e.type === 'net.response');
assert.equal(requests.length, calls.length, 'missing transport evidence');
assert.equal(responses.length, calls.length);
const remaining = [...calls];
for (const request of requests) {
  const body = await reader.resolvePayload(request);
  const index = remaining.findIndex((c) => c.body === body && c.path === request.attrs.path);
  assert.ok(index >= 0, 'request differs from independent endpoint');
  const [expected] = remaining.splice(index, 1);
  const response = responses.find((e) => e.attrs.request_id === request.attrs.request_id);
  assert.equal(await reader.resolvePayload(response), expected.response);
  assert.equal(response.attrs.capture_incomplete, false);
}
assert.ok(
  calls.some(
    (c) =>
      c.body.includes('HERMES_SYSTEM_REQUEST_SENTINEL') && JSON.parse(c.body).tools?.length > 0,
  ),
);
const manifest = JSON.parse(await readFile(join(run.runDir, 'manifest.json'), 'utf8'));
assert.equal(outcome.code, manifest.capture.status === 'complete' ? 0 : 2);
console.log(
  JSON.stringify({
    root,
    ...outcome,
    requests: calls.length,
    exactBodies: true,
    system: true,
    tools: true,
    capture: manifest.capture,
    runDir: run.runDir,
  }),
);
