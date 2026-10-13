import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';

/**
 * Through `main()`, because that is where a thrown message is cut into `what` and `why` — and where
 * the line breaks a message was composed with came out spelled `\x0a`, one line with the choices of
 * a flag, the install command or the order settings are read in run together inside it.
 */
describe('a failure prints as the lines it was written in', () => {
  let cwd: string;
  let printed: string[];
  const real = { out: process.stdout.write, err: process.stderr.write };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'agenticreplay-failure-lines-'));
    printed = [];
    const capture = ((s: string | Uint8Array) => (
      printed.push(String(s)),
      true
    )) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
  });

  afterEach(async () => {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
    await rm(cwd, { recursive: true, force: true });
  });

  it('prints multiline recovery advice as separate lines', async () => {
    const target = join(cwd, 'occupied');
    await mkdir(target);
    await writeFile(join(target, 'user.txt'), 'keep');
    const code = await main(['quickstart', '--dir', target], cwd);
    const lines = printed.join('').split('\n');
    expect(code).toBe(1);
    expect(
      lines.some((line) => line.includes('already exists and is not an empty directory')),
    ).toBe(true);
    expect(
      lines.some(
        (line) => line.trim() === 'pick somewhere else: agenticreplay quickstart --dir <path>',
      ),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain('\\x0a');
  });
});
