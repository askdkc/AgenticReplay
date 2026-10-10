#!/usr/bin/env node
/**
 * Smoke-test the packed public surface in a clean consumer directory.
 *
 * This deliberately installs every workspace tarball in one npm invocation. Installing only the
 * CLI tarball can accidentally resolve renamed internal packages from the registry and therefore
 * does not prove that the release is self-contained.
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packDir = await mkdtemp(join(tmpdir(), 'agenticreplay-smoke-pack-'));
const consumerDir = await mkdtemp(join(tmpdir(), 'agenticreplay-smoke-consumer-'));
const npmCache =
  process.env.AGENTICREPLAY_SMOKE_NPM_CACHE ?? join(tmpdir(), 'agenticreplay-npm-cache');
const node = process.execPath;

async function run(command, args, options = {}) {
  return exec(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    timeout: 30_000,
    killSignal: 'SIGTERM',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function commandOptions(cwd, env = {}) {
  return {
    cwd,
    env: { ...process.env, ...env },
    timeout: 30_000,
    killSignal: 'SIGTERM',
    maxBuffer: 16 * 1024 * 1024,
  };
}

await mkdir(packDir, { recursive: true });
await mkdir(consumerDir, { recursive: true });

const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packageDirs = (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, 'packages', entry.name));
const manifests = await Promise.all(
  packageDirs.map(async (dir) => {
    try {
      return { dir, manifest: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) };
    } catch {
      return undefined;
    }
  }),
);
const packages = manifests.filter((item) => item?.manifest?.name && item.manifest.private !== true);
if (packages.length === 0 || !rootManifest.workspaces)
  throw new Error('no public workspace packages found');

for (const item of packages) {
  await run('npm', [
    'pack',
    '--workspace',
    item.manifest.name,
    '--pack-destination',
    packDir,
    '--cache',
    npmCache,
    '--silent',
  ]);
}
const tarballs = (await readdir(packDir))
  .filter((name) => name.endsWith('.tgz'))
  .map((name) => join(packDir, name));
if (tarballs.length !== packages.length)
  throw new Error(`packed ${tarballs.length} packages, expected ${packages.length}`);

await writeFile(
  join(consumerDir, 'package.json'),
  JSON.stringify({ name: 'agenticreplay-installed-smoke', private: true, type: 'module' }, null, 2),
);
await exec('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs], {
  ...commandOptions(consumerDir, { npm_config_cache: npmCache }),
});

const bin = join(consumerDir, 'node_modules', '.bin', 'agenticreplay');
const smokeEnv = {
  HOME: join(consumerDir, 'home'),
  XDG_CONFIG_HOME: join(consumerDir, 'config'),
  XDG_DATA_HOME: join(consumerDir, 'data'),
};
const help = await exec(bin, ['--help'], commandOptions(consumerDir, smokeEnv));
if (!help.stdout.includes('agenticreplay record') || !help.stdout.includes('agenticreplay mcp'))
  throw new Error('installed CLI help is incomplete');

const cliPackage = JSON.parse(
  await readFile(join(consumerDir, 'node_modules', 'agenticreplay', 'package.json'), 'utf8'),
);
for (const item of packages) {
  const packagePath = join(
    consumerDir,
    'node_modules',
    ...item.manifest.name.split('/'),
    'package.json',
  );
  const installedManifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const dependencyNames = Object.keys({
    ...installedManifest.dependencies,
    ...installedManifest.optionalDependencies,
    ...installedManifest.peerDependencies,
    ...installedManifest.bin,
  });
  if (
    installedManifest.name.toLowerCase().includes('orca') ||
    dependencyNames.some((name) => name.toLowerCase().includes('orca'))
  ) {
    throw new Error(`packed metadata contains an old package identity: ${installedManifest.name}`);
  }
}

const endpointRequests = [];
const sseBody =
  'data: {"id":"smoke","choices":[{"delta":{"content":"captured"}}]}\n\ndata: [DONE]\n\n';
const endpoint = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  endpointRequests.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(sseBody.slice(0, 17));
  response.end(sseBody.slice(17));
});
let endpointClosed = false;
let mcpProcess;
let cleaning = false;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (mcpProcess && mcpProcess.exitCode === null) mcpProcess.kill('SIGTERM');
  if (!endpointClosed)
    await new Promise((resolve) =>
      endpoint.close(() => {
        endpointClosed = true;
        resolve();
      }),
    );
}
process.on('uncaughtException', (error) => {
  void cleanup().finally(() => {
    console.error(error);
    process.exit(1);
  });
});
process.on('unhandledRejection', (error) => {
  void cleanup().finally(() => {
    console.error(error);
    process.exit(1);
  });
});
await new Promise((resolve, reject) => {
  endpoint.once('error', reject);
  endpoint.listen(0, '127.0.0.1', resolve);
});
const endpointPort = endpoint.address().port;
const agent = join(consumerDir, 'agent.mjs');
await writeFile(
  agent,
  `
  const response = await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({model:'smoke', system:'system sentinel', messages:[{role:'user',content:'tool sentinel'}], tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}], tool_result:{id:'tool-1',content:'result sentinel'}, credential:'sk-test-secret-1234567890'})
  });
  for await (const chunk of response.body) void chunk;
`,
);
const recordEnv = {
  ...process.env,
  ...smokeEnv,
  AGENTICREPLAY_UPSTREAM_OPENAI: `http://127.0.0.1:${endpointPort}/v1`,
};
const recorded = await exec(
  bin,
  ['record', 'generic-openai', '--json', '--no-fs', '--no-shell', '--', node, agent],
  commandOptions(consumerDir, recordEnv),
);
const recordResult = JSON.parse(recorded.stdout);
const runId = recordResult.run_id ?? recordResult.runId;
if (
  typeof runId !== 'string' ||
  endpointRequests.length !== 1 ||
  !endpointRequests[0].body.includes('system sentinel') ||
  !endpointRequests[0].body.includes('tool sentinel')
) {
  throw new Error(
    `installed record did not capture the independent endpoint request: ${recorded.stdout}`,
  );
}
const shown = await exec(bin, ['show', runId, '--json'], commandOptions(consumerDir, smokeEnv));
if (!shown.stdout.includes(runId))
  throw new Error('installed show did not return the recorded run');
const exportPath = join(consumerDir, 'run.html');
await exec(bin, ['export', runId, '-o', exportPath], commandOptions(consumerDir, smokeEnv));
const exported = await readFile(exportPath, 'utf8');
if (
  !exported.includes(runId) ||
  !exported.includes('system sentinel') ||
  exported.includes('sk-test-secret-1234567890')
)
  throw new Error('installed export is incomplete or contains the credential');
const runDir = join(consumerDir, '.agenticreplay', 'runs', runId);
const eventLines = (await readFile(join(runDir, 'events.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const requestEvent = eventLines.find(
  (event) => event.type === 'net.request' && event.attrs?.phase === 'body',
);
const responseEvent = eventLines.find((event) => event.type === 'net.response');
if (
  typeof requestEvent?.payload !== 'string' ||
  requestEvent.payload.includes('sk-test-secret-1234567890') ||
  !requestEvent.payload.includes('<secret:')
)
  throw new Error('stored request body did not prove explicit redaction');
if (responseEvent?.payload !== sseBody)
  throw new Error('stored response body did not preserve the complete SSE sentinel');
await new Promise((resolve) =>
  endpoint.close(() => {
    endpointClosed = true;
    resolve();
  }),
);
const replayed = await exec(
  bin,
  ['replay', runId, '--in-place', '--no-trace', '--no-fs', '--json'],
  commandOptions(consumerDir, smokeEnv),
);
const replayResult = JSON.parse(replayed.stdout);
const canonicalExact = replayResult.canonical_exact ?? replayResult.canonicalExact;
const liveCalls = replayResult.live_calls ?? replayResult.liveCalls ?? 0;
if (typeof canonicalExact !== 'number' || liveCalls !== 0)
  throw new Error(`installed replay did not report an offline verdict: ${replayed.stdout}`);

mcpProcess = spawn(bin, ['mcp'], {
  cwd: consumerDir,
  env: { ...process.env, ...smokeEnv },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let mcpOutput = '';
let mcpError = '';
mcpProcess.stdout.setEncoding('utf8');
mcpProcess.stderr.setEncoding('utf8');
mcpProcess.stderr.on('data', (chunk) => {
  mcpError += chunk;
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`installed MCP tools/list timed out: ${mcpError}`)),
    30000,
  );
  const finish = (error) => {
    clearTimeout(timer);
    error ? reject(error) : resolve();
  };
  mcpProcess.once('error', finish);
  mcpProcess.once('close', (code) => {
    if (!mcpOutput.includes('agenticreplay_'))
      finish(new Error(`installed MCP exited ${code} before tools/list: ${mcpError}`));
  });
  mcpProcess.stdout.on('data', (chunk) => {
    mcpOutput += chunk;
    for (const line of mcpOutput.split('\n').slice(0, -1)) {
      const message = JSON.parse(line);
      if (message.id !== 1) continue;
      if (!message.result?.tools?.some((tool) => tool.name.startsWith('agenticreplay_')))
        return finish(
          new Error(`installed MCP tool identity is missing AgenticReplay names: ${line}`),
        );
      return finish();
    }
  });
  // Keep stdin open until the response arrives; EOF can terminate a stdio server before work drains.
  mcpProcess.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
  );
});
mcpProcess.stdin.end();
if (!mcpProcess.killed) mcpProcess.kill('SIGTERM');

console.log(
  JSON.stringify(
    {
      packages: packages.map((item) => item.manifest.name),
      tarballs: tarballs.map((path) => path.split('/').pop()),
      consumerDir,
      runId,
      checks: [
        'installed CLI help',
        'packed metadata identity',
        'record endpoint body',
        'show',
        'export',
        'replay',
        'MCP tool identity',
      ],
    },
    null,
    2,
  ),
);
