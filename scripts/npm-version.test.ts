import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('npm version lifecycle', () => {
  let work: string;
  let paths: string[];
  let next: string;
  const run = (command: string, args: string[]) => {
    // Exercise terminal commands even when Vitest was launched through an npm lifecycle.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    };
    delete env.npm_config_allow_scripts;
    delete env.NPM_CONFIG_ALLOW_SCRIPTS;
    return exec(command, args, {
      cwd: work,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      shell: process.platform === 'win32',
    });
  };
  const json = async (path: string) => JSON.parse(await readFile(join(work, path), 'utf8'));

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'agenticreplay-npm-version-'));
    paths = [
      'package.json',
      'package-lock.json',
      ...(await readdir(join(repo, 'packages'))).map((dir) => `packages/${dir}/package.json`),
    ];
    const files = [
      ...paths,
      'scripts/set-version.mjs',
      'scripts/publish-order.mjs',
      'scripts/npm-version.mjs',
      'bin/agenticreplay.js',
    ];
    for (const path of files.filter((path) => existsSync(join(repo, path)))) {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await cp(join(repo, path), join(work, path));
    }
    const current = (await json('package.json')).version;
    const [major, minor, patch] = current.split('-')[0].split('.');
    next = `${major}.${minor}.${Number(patch) + (current.includes('-') ? 0 : 1)}`;
    await run('git', ['init']);
    await run('git', ['config', 'user.name', 'Release fixture']);
    await run('git', ['config', 'user.email', 'release-fixture@example.invalid']);
    await run('git', ['config', 'commit.gpgsign', 'false']);
    await run('git', ['config', 'tag.gpgsign', 'false']);
    await mkdir(join(work, 'empty-hooks'));
    await run('git', ['config', 'core.hooksPath', join(work, 'empty-hooks')]);
    await run('git', ['add', '.']);
    await run('git', ['commit', '-m', 'fixture']);
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function expectSynchronized() {
    for (const path of paths.filter((path) => path !== 'package-lock.json')) {
      const pkg = await json(path);
      expect(pkg.version, path).toBe(next);
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        for (const [name, pin] of Object.entries(pkg[field] ?? {})) {
          if (name.startsWith('@agenticreplay/')) expect(pin, `${path}: ${name}`).toBe(next);
        }
      }
    }
    const lock = await json('package-lock.json');
    expect(lock.version).toBe(next);
    expect(lock.packages[''].version).toBe(next);
    for (const path of paths.filter((path) => path.startsWith('packages/'))) {
      const dir = dirname(path);
      expect(lock.packages[dir].version, dir).toBe(next);
      const pkg = await json(path);
      expect(lock.packages[`node_modules/${pkg.name}`].link, pkg.name).toBe(true);
    }
    await run(process.execPath, ['scripts/publish-order.mjs', '--quiet']);
    await run('npm', [
      'ci',
      '--dry-run',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  }

  it('synchronizes all metadata without staging or committing when Git tags are disabled', async () => {
    const before = (await run('git', ['rev-parse', 'HEAD'])).stdout;
    await run('npm', ['version', 'patch', '--no-git-tag-version']);
    await expectSynchronized();
    expect((await run('git', ['rev-parse', 'HEAD'])).stdout).toBe(before);
    expect((await run('git', ['diff', '--cached', '--name-only'])).stdout).toBe('');
    expect((await run('git', ['tag'])).stdout).toBe('');
  });

  it('includes every synchronized manifest and lockfile in the release commit and tag', async () => {
    await run('npm', ['version', 'patch', '-m', 'chore(release): v%s']);
    await expectSynchronized();
    expect((await run('git', ['log', '-1', '--format=%s'])).stdout.trim()).toBe(
      `chore(release): v${next}`,
    );
    expect((await run('git', ['tag'])).stdout.trim()).toBe(`v${next}`);
    expect(
      (await run('git', ['show', '--format=', '--name-only', 'HEAD'])).stdout
        .trim()
        .split('\n')
        .sort(),
    ).toEqual([...paths].sort());
    expect((await run('git', ['status', '--porcelain'])).stdout).toBe('');
  });

  it('refuses a dirty checkout before modifying release metadata', async () => {
    const before = await Promise.all(paths.map((path) => readFile(join(work, path), 'utf8')));
    await writeFile(join(work, 'scripts/publish-order.mjs'), '// user edit\n');
    await expect(run('npm', ['version', 'patch', '-m', 'chore(release): v%s'])).rejects.toThrow();
    expect(await Promise.all(paths.map((path) => readFile(join(work, path), 'utf8')))).toEqual(
      before,
    );
    expect((await run('git', ['tag'])).stdout).toBe('');
  });
});
