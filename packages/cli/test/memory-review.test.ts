import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeConfig } from '../src/config.js';
import { main } from '../src/main.js';

const exec = promisify(execFile);
let workspace: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agenticreplay-memory-review-'));
  await exec('git', ['init', '-q'], { cwd: workspace });
  await writeConfig({});
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (value) => (stdout.push(String(value)), true),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (value) => (stderr.push(String(value)), true),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

async function record(script: string) {
  stdout.length = 0;
  const code = await main(
    ['record', 'exec', '--json', '--no-shell', '--no-fs', '--', process.execPath, '-e', script],
    workspace,
  );
  return { code, ...JSON.parse(stdout.join('')) };
}

it('queues a finalized CLI recording without an elicitation client and reopens its exact run', async () => {
  await writeConfig({ memory_review: { enabled: true } });
  const result = await record('process.exit(7)');
  expect(result.code).toBe(7);
  expect(stderr.join('')).toContain('memory_review.pending');
  stdout.length = 0;
  expect(await main(['review', result.runId, '--status'], workspace)).toBe(0);
  expect(stdout.join('')).toContain(result.runId);
  expect(stdout.join('')).toContain('Kiokuko review integration is unavailable');
});

it('does not queue when disabled or when recording is interrupted', async () => {
  const disabled = await record('process.exit(7)');
  expect(stderr.join('')).not.toContain('memory_review.pending');
  expect(await main(['review', disabled.runId, '--status'], workspace)).toBe(1);

  await writeConfig({ memory_review: { enabled: true } });
  stderr.length = 0;
  const interrupted = await record("process.kill(process.pid, 'SIGINT')");
  expect(stderr.join('')).not.toContain('memory_review.pending');
  expect(await main(['review', interrupted.runId, '--status'], workspace)).toBe(1);
});
