import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { resolveServiceNode } from '../src/codex-service-launch.js';

it.skipIf(process.platform === 'win32')(
  'keeps the stable launcher working after its old target is removed',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ar-node-update-'));
    try {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const oldRuntime = join(root, 'old-node');
      const newRuntime = join(root, 'new-node');
      await writeFile(oldRuntime, '#!/bin/sh\necho old\n');
      await writeFile(newRuntime, '#!/bin/sh\necho new\n');
      await chmod(oldRuntime, 0o755);
      await chmod(newRuntime, 0o755);
      const stable = join(bin, 'node');
      await symlink(oldRuntime, stable);
      const selected = await resolveServiceNode(bin);
      expect(selected).toBe(stable);
      expect((await promisify(execFile)(selected)).stdout.trim()).toBe('old');
      await rm(stable);
      await symlink(newRuntime, stable);
      await rm(oldRuntime);
      expect((await promisify(execFile)(selected)).stdout.trim()).toBe('new');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('never falls back to the resolved current runtime or a versioned PATH entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-node-path-'));
  try {
    const versioned = join(root, 'Cellar', 'node', 'old-release', 'bin');
    await mkdir(versioned, { recursive: true });
    await writeFile(join(versioned, 'node'), '', { mode: 0o755 });
    await expect(
      resolveServiceNode([versioned, join(root, 'missing')].join(delimiter)),
    ).rejects.toThrow(/stable.*node/iu);
    await expect(resolveServiceNode('')).rejects.toThrow(/stable.*node/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
