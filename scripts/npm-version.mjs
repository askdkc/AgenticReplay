#!/usr/bin/env node
/** Synchronize release metadata after npm has bumped the root version. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, [join(root, 'scripts/set-version.mjs'), version, '--lock'], {
  cwd: root,
  stdio: 'inherit',
});

// npm commits only the root metadata itself. Include the synchronized workspace manifests in
// that same release commit, while honoring its opt-out and leaving manual npm run version unstaged.
// npm serializes a false boolean config as an empty lifecycle environment value.
const gitTagVersion = process.env.npm_config_git_tag_version;
if (
  process.env.npm_command === 'version' &&
  gitTagVersion !== 'false' &&
  gitTagVersion !== '' &&
  existsSync(join(root, '.git'))
) {
  const directories = await readdir(join(root, 'packages'), { withFileTypes: true });
  const manifests = directories
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'package.json'));
  execFileSync('git', ['add', '--', 'package.json', 'package-lock.json', ...manifests], {
    cwd: root,
    stdio: 'inherit',
  });
}
