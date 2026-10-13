import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FsCapture, gitAvailable, runGit } from '../src/index.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

const hasGit = await gitAvailable();
const itGit = it.skipIf(!hasGit);

afterAll(cleanupTempDirs);

interface Fixture {
  root: string;
  cwd: string;
  runDir: string;
  capture: FsCapture;
}

/** The run dir lives under the workspace, exactly as `.agenticreplay/runs/<run_id>/` does in the spec. */
async function fixture(): Promise<Fixture> {
  const root = await makeTempDir();
  const cwd = join(root, 'ws');
  const runDir = join(cwd, '.agenticreplay', 'runs', 'run_abc123');
  await mkdir(cwd, { recursive: true });
  const capture = await FsCapture.start({ runDir, cwd });
  return { root, cwd, runDir, capture };
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

describe('FsCapture.start', () => {
  itGit('keeps its diff index out of the recorded run', async () => {
    const { runDir } = await fixture();
    await expect(stat(join(runDir, 'fs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('snapshotTurn', () => {
  itGit('reports the first snapshot with no changes', async () => {
    const { cwd, capture } = await fixture();
    await write(cwd, 'a.txt', 'one\n');
    const first = await capture.snapshotTurn(0);
    expect(first.changes).toEqual([]);
    expect(first).not.toHaveProperty('tree');
  });

  itGit('diffs each later turn against the previous tree', async () => {
    const { cwd, capture } = await fixture();
    await write(cwd, 'a.txt', 'one\n');
    await capture.snapshotTurn(0);
    await write(cwd, 'a.txt', 'one\ntwo\n');
    await write(cwd, 'b.txt', 'new file\n');
    const second = await capture.snapshotTurn(1);
    expect(second).not.toHaveProperty('tree');
    expect([...second.changes].sort((l, r) => l.path.localeCompare(r.path))).toEqual([
      { path: 'a.txt', status: 'modified', insertions: 1, deletions: 0 },
      { path: 'b.txt', status: 'added', insertions: 1, deletions: 0 },
    ]);
  });

  itGit('reports no changes and the same tree for an untouched turn', async () => {
    const { cwd, capture } = await fixture();
    await write(cwd, 'a.txt', 'one\n');
    await capture.snapshotTurn(0);
    const second = await capture.snapshotTurn(1);
    expect(second.changes).toEqual([]);
  });

  itGit('records a deletion between turns', async () => {
    const { cwd, capture } = await fixture();
    await write(cwd, 'doomed.txt', 'bye\n');
    await capture.snapshotTurn(0);
    await rm(join(cwd, 'doomed.txt'));
    const second = await capture.snapshotTurn(1);
    expect(second.changes).toEqual([
      { path: 'doomed.txt', status: 'deleted', insertions: 0, deletions: 1 },
    ]);
  });

  // events.jsonl is a total order, so a turn that moves backwards is a recorder bug, not data.
  itGit('rejects a turn number that goes backwards', async () => {
    const { capture } = await fixture();
    await capture.snapshotTurn(3);
    await expect(capture.snapshotTurn(2)).rejects.toThrow(/turn/i);
    await expect(capture.snapshotTurn(-1)).rejects.toThrow(/turn/i);
    await expect(capture.snapshotTurn(1.5)).rejects.toThrow(/turn/i);
    await expect(capture.snapshotTurn(3)).resolves.toBeDefined();
  });

  itGit('never captures the run dir it writes into, nor secrets', async () => {
    const { cwd, runDir, capture } = await fixture();
    await write(cwd, 'src/app.ts', 'export const ok = 1;\n');
    await write(cwd, '.env', 'API_KEY=sk-live-secret\n');
    await write(cwd, 'id_rsa', 'PRIVATE KEY\n');
    await write(runDir, 'events.jsonl', '{"seq":0}\n');
    await capture.snapshotTurn(0);
    await write(cwd, 'src/app.ts', 'export const ok = 2;\n');
    const next = await capture.snapshotTurn(1);
    expect(next.changes.map((change) => change.path)).toEqual(['src/app.ts']);
  });
});

describe('gitInfo', () => {
  itGit('returns an empty object for a directory that is not a repo', async () => {
    const { cwd, capture } = await fixture();
    await expect(capture.gitInfo(cwd)).resolves.toEqual({});
  });

  itGit('returns an empty object for a directory that does not exist', async () => {
    const { root, capture } = await fixture();
    await expect(capture.gitInfo(join(root, 'nowhere'))).resolves.toEqual({});
  });

  itGit("does not count agenticreplay's own runs as changes to the user's tree", async () => {
    // The exclusion only covered *this* run's directory, so the second run in a workspace reported
    // dirty: true because the first run's directory was sitting there untracked. That is exactly
    // the failure the exclusion exists to prevent, just one run later — and it makes the flag
    // useless, since almost nobody records only once.
    const { cwd, capture } = await fixture();
    await runGit(['init', '-q', '-b', 'trunk'], { cwd });
    await write(cwd, 'a.txt', 'one\n');
    await runGit(['add', 'a.txt'], { cwd });
    await runGit(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'first'], {
      cwd,
    });
    expect((await capture.gitInfo(cwd)).dirty).toBe(false);

    // A previous run's directory, which agenticreplay wrote and the user did not.
    await write(cwd, '.agenticreplay/runs/run_deadbeef0001/events.jsonl', '{}\n');
    expect((await capture.gitInfo(cwd)).dirty).toBe(false);

    // Anything the user actually changed still counts.
    await write(cwd, 'b.txt', 'theirs\n');
    expect((await capture.gitInfo(cwd)).dirty).toBe(true);
  });

  itGit("reads the user's real repo, not the shadow store", async () => {
    const { cwd, capture } = await fixture();
    await runGit(['init', '-q', '-b', 'trunk'], { cwd });
    await write(cwd, 'a.txt', 'one\n');
    await runGit(['add', 'a.txt'], { cwd });
    await runGit(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'first'], {
      cwd,
    });

    const clean = await capture.gitInfo(cwd);
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.branch).toBe('trunk');
    expect(clean.dirty).toBe(false);

    await write(cwd, 'a.txt', 'one\ntwo\n');
    expect((await capture.gitInfo(cwd)).dirty).toBe(true);

    // Snapshotting must not disturb what the real repo reports.
    await capture.snapshotTurn(0);
    const after = await capture.gitInfo(cwd);
    expect(after.head).toBe(clean.head);
    expect(after.branch).toBe('trunk');
  });

  itGit('omits head for a repo with no commits yet', async () => {
    const { cwd, capture } = await fixture();
    await runGit(['init', '-q', '-b', 'trunk'], { cwd });
    const info = await capture.gitInfo(cwd);
    expect(info.head).toBeUndefined();
    expect(info.branch).toBe('trunk');
    expect(info.dirty).toBe(false);
  });

  // The run dir normally lives inside the workspace, so agenticreplay's own files must not be what makes
  // the user's repo look dirty in the manifest.
  itGit('ignores its own run dir when deciding whether the workspace is dirty', async () => {
    const { cwd, runDir, capture } = await fixture();
    await runGit(['init', '-q', '-b', 'trunk'], { cwd });
    await write(cwd, 'a.txt', 'one\n');
    await runGit(['add', 'a.txt'], { cwd });
    await runGit(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'first'], {
      cwd,
    });
    await capture.snapshotTurn(0);
    await write(runDir, 'events.jsonl', '{"seq":0}\n');
    expect((await capture.gitInfo(cwd)).dirty).toBe(false);

    await write(cwd, 'untracked-by-the-user.txt', 'mine\n');
    expect((await capture.gitInfo(cwd)).dirty).toBe(true);
  });

  itGit('omits branch when HEAD is detached', async () => {
    const { cwd, capture } = await fixture();
    await runGit(['init', '-q'], { cwd });
    await write(cwd, 'a.txt', 'one\n');
    await runGit(['add', 'a.txt'], { cwd });
    await runGit(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'first'], {
      cwd,
    });
    const head = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await runGit(['checkout', '-q', head], { cwd });
    const info = await capture.gitInfo(cwd);
    expect(info.head).toBe(head);
    expect(info.branch).toBeUndefined();
  });

  itGit('defaults to the captured cwd', async () => {
    const { cwd, capture } = await fixture();
    await runGit(['init', '-q', '-b', 'trunk'], { cwd });
    expect((await capture.gitInfo()).branch).toBe('trunk');
  });
});
