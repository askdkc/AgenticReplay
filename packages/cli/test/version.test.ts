import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENTICREPLAY_VERSION } from '../src/version.js';

/**
 * `npm version --workspaces` moves package.json and nothing else, so the constant the CLI prints
 * — and stamps into every trace's `agenticreplay_version` — silently keeps the previous release's number.
 * 0.2.0 shipped saying 0.1.2.
 *
 * The existing assertion in api.test.ts compares the constant against itself, so it cannot catch
 * this. This one compares it against the manifest npm actually publishes.
 */
describe('AGENTICREPLAY_VERSION', () => {
  it('matches the version npm publishes', () => {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    expect(AGENTICREPLAY_VERSION).toBe(version);
  });
});
