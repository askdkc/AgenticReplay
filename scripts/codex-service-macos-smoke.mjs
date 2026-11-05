#!/usr/bin/env node
// Exercise the installed CLI against the real user LaunchAgent and a disposable Codex config.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (process.platform !== 'darwin' || !cli)
  throw new Error('Run on macOS with an installed CLI path.');
const exec = promisify(execFile);
const domain = `gui/${process.getuid()}/io.github.askdkc.agenticreplay.codex-dock`;
async function command(cwd, ...args) {
  const { stdout } = await exec(process.execPath, [cli, 'codex-service', ...args, '--json'], {
    cwd,
    timeout: 40_000,
  });
  return JSON.parse(stdout);
}
const dir = await realpath(await mkdtemp('/tmp/ar-service-smoke-'));
const profile = join(dir, 'config.toml');
const first = join(dir, 'one');
const second = join(dir, 'two');
const original =
  'model_provider = "openai"\nmodel = "before"\nchatgpt_base_url = "https://chatgpt.com/backend-api/"\n';
let own = false;

async function pid() {
  const { stdout } = await exec('/bin/launchctl', ['print', domain], { timeout: 5000 });
  return /^\s*pid = (\d+)$/mu.exec(stdout)?.[1];
}
try {
  assert.deepEqual(await command(dir, 'status'), { status: 'disabled' });
  for (const cwd of [first, second]) {
    await mkdir(cwd);
    await exec('/usr/bin/git', ['init', '--quiet'], { cwd });
  }
  const custom = 'openai_base_url = "https://gateway.example/v1"\n' + original;
  await writeFile(profile, custom, { mode: 0o600 });
  await assert.rejects(command(first, 'register', '--config', profile));
  assert.equal(await readFile(profile, 'utf8'), custom);
  assert.deepEqual(await command(dir, 'status'), { status: 'disabled' });
  await writeFile(profile, original);
  own = true;
  const registered = await command(first, 'register', '--config', profile);
  assert.equal(registered.status, 'running');
  assert.deepEqual(registered.worktrees, [first]);
  const socket = await lstat(registered.socketPath);
  assert(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal(socket.uid, process.getuid());
  const configured = `openai_base_url = "${registered.baseUrl}"\n`;
  assert.equal(await readFile(profile, 'utf8'), configured + original);
  assert.deepEqual(await command(first, 'register', '--config', profile), registered);
  const expanded = await command(second, 'register', '--config', profile);
  assert.equal(expanded.status, 'running');
  assert.deepEqual(expanded.worktrees, [first, second]);
  assert.equal(expanded.socketPath, registered.socketPath);
  assert.equal(expanded.baseUrl, registered.baseUrl);
  const old = await pid();
  assert(old);
  await exec('/bin/launchctl', ['kill', 'SIGTERM', domain], { timeout: 5000 });
  let restarted = false;
  for (let i = 0; i < 60; i++) {
    const current = await pid();
    if (current && current !== old && (await command(dir, 'status')).status === 'running') {
      restarted = true;
      break;
    }
    await delay(200);
  }
  assert(restarted, 'launchd restarted the service and the same socket is responsive');
  assert.deepEqual(await command(dir, 'status'), expanded);
  const changed = original.replace('before', 'after');
  await writeFile(profile, configured + changed);
  assert.deepEqual(await command(dir, 'disable'), { status: 'disabled' });
  own = false;
  assert.equal(await readFile(profile, 'utf8'), changed);
  await assert.rejects(lstat(registered.socketPath), { code: 'ENOENT' });
  await assert.rejects(exec('/bin/launchctl', ['print', domain], { timeout: 5000 }));
  console.log(
    'macOS installed service: conflict, register, add worktree, restart, disable passed.',
  );
} finally {
  if (own) await command(dir, 'disable');
  await rm(dir, { recursive: true, force: true });
}
