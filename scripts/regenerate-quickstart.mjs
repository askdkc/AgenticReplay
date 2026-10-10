// Re-record the shipped demo using historical response bodies and the current normal writers.
// Requires npm run build. No credentials or live provider connection are used.
import { createServer } from 'node:http';
import { format } from 'prettier';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const asset = join(root, 'packages/cli/quickstart');
const { responses } = JSON.parse(await readFile(join(asset, 'responses.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'agenticreplay-fixture-'));
const bin = await mkdtemp(join(tmpdir(), 'agenticreplay-fixture-bin-'));
let attempt = 0;
const server = createServer(async (req, res) => {
  for await (const _ of req) {
    /* independently consume the serialized request */
  }
  const body = responses[attempt++];
  res.writeHead(body === undefined ? 500 : 200, { 'content-type': 'application/json' });
  res.end(body ?? '{"error":"fixture response exhausted"}');
});
try {
  await cp(join(asset, 'project'), scratch, { recursive: true });
  await symlink(process.execPath, join(bin, 'node'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(
    process.execPath,
    [
      join(root, 'packages/cli/dist/cli.js'),
      'record',
      'node',
      '--upstream-openai',
      origin,
      '--',
      'node',
      'agent.mjs',
    ],
    {
      cwd: scratch,
      stdio: 'inherit',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: scratch,
        TMPDIR: scratch,
        XDG_CONFIG_HOME: join(scratch, 'config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        NO_COLOR: '1',
      },
    },
  );
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0 || attempt !== responses.length)
    throw new Error(`fixture recording failed: exit=${code}, requests=${attempt}`);
  const runs = join(scratch, '.agenticreplay/runs');
  const [run] = await readdir(runs);
  if (!run) throw new Error('no recording produced');
  // Neutralize operational metadata in this published fixture; event/blob hashes remain writer-produced.
  const manifestPath = join(runs, run, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.cwd = '/workspace/quickstart';
  manifest.env_allowlisted = { HOME: '/home/you', PATH: '/usr/local/bin:/usr/bin:/bin' };
  await writeFile(manifestPath, await format(JSON.stringify(manifest), { parser: 'json' }));
  // Bootstrap scripts contain machine-local executable paths and are regenerated on replay.
  for (const name of ['shims', 'py', 'agenticreplay-fetch-hook.cjs', 'fs/hooks']) {
    await rm(join(runs, run, name), { recursive: true, force: true });
  }
  await rm(join(asset, 'trace'), { recursive: true, force: true });
  await cp(join(runs, run), join(asset, 'trace'), { recursive: true });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
}
