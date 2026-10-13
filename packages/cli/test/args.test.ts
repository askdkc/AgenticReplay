import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('flags that never take a value', () => {
  // Boolean flags must not swallow a following run selector or harness name.
  it('leaves the positional alone and reads as true', () => {
    for (const flag of [
      '--full',
      '--json',
      '--drop-fs',
      '--ui',
      '--dry-run',
      '--verbose',
      '--force',
    ]) {
      const args = parseArgs(['show', flag, 'last']);
      expect(args.positionals, `${flag} ate the positional`).toEqual(['last']);
      expect(args.bool(flag.slice(2)), `${flag} did not read as true`).toBe(true);
    }
  });

  it('keeps the agent name when interception is asked for', () => {
    const args = parseArgs(['record', '--tls-intercept', 'codex']);
    expect(args.positionals).toEqual(['codex']);
    expect(args.bool('tls-intercept')).toBe(true);
  });

  it('still lets a value-taking flag take its value', () => {
    const args = parseArgs(['list', '--source', 'recorded', '--limit', '4']);
    expect(args.positionals).toEqual([]);
    expect(args.str('source')).toBe('recorded');
    expect(args.num('limit')).toBe(4);
  });

  it('still honours an explicit --flag=value for a boolean', () => {
    expect(parseArgs(['list', '--verbose=false', 'last']).bool('verbose')).toBe(false);
    expect(parseArgs(['record', '--no-fs', 'generic-openai']).bool('fs', true)).toBe(false);
  });
});

describe('parseArgs', () => {
  it('reads the command and its positionals', () => {
    const a = parseArgs(['record', 'claude']);
    expect(a.command).toBe('record');
    expect(a.positionals).toEqual(['claude']);
  });

  it('parses long flags with = and with a following value', () => {
    expect(parseArgs(['setup', '--gateway=https://gateway.example']).flags.gateway).toBe(
      'https://gateway.example',
    );
    expect(parseArgs(['setup', '--gateway', 'https://gateway.example']).flags.gateway).toBe(
      'https://gateway.example',
    );
  });

  it('parses booleans and --no- negation', () => {
    expect(parseArgs(['record', '--ui']).flags.ui).toBe(true);
    expect(parseArgs(['record', '--no-fs']).flags.fs).toBe(false);
  });

  it('parses numbers where the value is numeric', () => {
    expect(parseArgs(['graph', 'last', '--to', '17']).flags.to).toBe(17);
  });

  it('splits comma lists', () => {
    expect(parseArgs(['scrub', 'last', '--matches', 'a,b,c']).list('matches')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps everything after -- as passthrough argv for the child agent', () => {
    const a = parseArgs(['record', 'claude', '--ui', '--', '--dangerously-skip', '-p', 'hi']);
    expect(a.flags.ui).toBe(true);
    expect(a.passthrough).toEqual(['--dangerously-skip', '-p', 'hi']);
    expect(a.positionals).toEqual(['claude']);
  });

  it('supports short flags', () => {
    expect(parseArgs(['export', 'last', '-o', 'bug.html']).flags.o).toBe('bug.html');
  });

  it('treats a bare invocation as the help command', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('does not swallow a negative number as a flag value', () => {
    expect(parseArgs(['graph', 'last', '--to', '-1']).flags.to).toBe(-1);
  });
});

/*
THE VALUE-LESS SET IS DERIVED, NOT TRUSTED.

Several flags have shipped value-taking by accident, including `--tls-intercept` and `--force` — and each time the fix was to add one more string to a hand-written list, and each time
the NEXT flag missed it. The list and the flags are edited in different files by different changes,
so nothing makes them agree.

A flag is boolean by the way it is READ: `args.bool('x')`. That call is the declaration, so this
derives the set from every such call across the CLI source and asserts each one is value-less. A
flag added tomorrow is covered the day it is written, without anyone remembering this file.

The failure it prevents is not cosmetic. A boolean flag that takes a value reads as FALSE while
eating the next token, so the feature silently does not happen AND the argument disappears —
`--tls-intercept` captured a different harness,
`--force` pushed a different recording to a shared gateway and called it success.
*/
describe('every boolean flag is value-less', () => {
  const SRC = join(import.meta.dirname, '..', 'src');

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      return e.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  it('derives the set from every args.bool() call in the CLI', async () => {
    const { VALUELESS } = await import('../src/args.js');
    const read: { flag: string; file: string }[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.bool\(\s*['"]([a-z][a-z0-9-]*)['"]/g)) {
        read.push({ flag: m[1], file });
      }
    }

    // A guard on the guard: a regex that stops matching would make this pass over nothing.
    expect(read.length, 'found no args.bool() calls — the pattern has drifted').toBeGreaterThan(5);

    const missing = read.filter((r) => !VALUELESS.has(r.flag));
    expect(
      missing.map((r) => `${r.flag} (${r.file.slice(SRC.length + 1)})`),
      'these flags are read as booleans but can swallow the next token',
    ).toEqual([]);
  });
});
