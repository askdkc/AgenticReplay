import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NUMERIC, VALUELESS, parseArgs } from '../src/args.js';
import { assertKnownFlags } from '../src/flags.js';

/** Active CLI flags must reject missing, conflicting and malformed values. */
describe('flags whose value cannot be honoured', () => {
  const check = (argv: string[]) => () => assertKnownFlags(parseArgs(argv));

  describe('a value that was not given', () => {
    it('refuses a value-taking flag left empty at the end of the line', () => {
      expect(check(['record', 'generic-openai', '--upstream-openai'])).toThrow(
        /--upstream-openai needs a value/,
      );
    });

    it('refuses one whose value is the next flag, which is the same mistake', () => {
      expect(check(['record', 'generic-openai', '--upstream-openai', '--json'])).toThrow(
        /--upstream-openai needs a value/,
      );
    });

    /**
     * A missing port must not silently select a random listener instead of the requested one.
     */
    it('says what the flag is for, so the message is enough to act on', () => {
      expect(check(['ui', 'last', '--port'])).toThrow(/--port needs a number/);
    });

    it('leaves a flag given a real value alone', () => {
      expect(check(['record', 'generic-openai', '--upstream-openai', 'x'])).not.toThrow();
      expect(check(['record', 'generic-openai', '--upstream-openai=x'])).not.toThrow();
      // An explicitly empty value is a value: the person said so.
      expect(check(['record', 'generic-openai', '--upstream-openai='])).not.toThrow();
    });

    /** A negation is not a missing value; it is the value `false`. */
    it('leaves a negated flag alone', () => {
      expect(check(['record', 'claude', '--no-fs'])).not.toThrow();
    });

    /** And a flag that never takes one is not missing anything. */
    it('leaves a valueless flag alone', () => {
      expect(check(['list', '--json', '--verbose'])).not.toThrow();
    });
  });

  describe('a flag given twice', () => {
    /**
     * Repeating a flag is how most CLIs take a list, so people write it. Here the second assignment
     * overwrote the first without a word: `agenticreplay scrub last --match a --match b --match c` redacted
     * only `c`, and reported the count for `c` as though that were the whole job.
     */
    it('refuses conflicting repeats rather than keeping the last', () => {
      expect(check(['scrub', 'last', '--match', 'a', '--match', 'b'])).toThrow(
        /--match given more than once/,
      );
    });

    it('points at the form that does take a list', () => {
      expect(check(['scrub', 'last', '--match', 'a', '--match', 'b'])).toThrow(/--matches a,b/);
    });

    it('catches the equals form and the mixture too', () => {
      expect(check(['scrub', 'last', '--match=a', '--match=b'])).toThrow(/given more than once/);
      expect(check(['scrub', 'last', '--match', 'a', '--match=b'])).toThrow(/given more than once/);
    });

    /** Repeating a flag with the same value asks for nothing contradictory, so it is allowed. */
    it('allows a repeat that says the same thing twice', () => {
      expect(check(['scrub', 'last', '--match', 'a', '--match', 'a'])).not.toThrow();
      expect(check(['list', '--json', '--json'])).not.toThrow();
    });
  });

  describe('a value of the wrong shape', () => {
    /**
     * `num()` returns its fallback for a word, so a malformed port must be rejected
     * before a random port is bound.
     */
    it('refuses a word where a number belongs', () => {
      expect(check(['ui', 'last', '--port', 'four'])).toThrow(/--port needs a number/);
      expect(check(['ui', 'last', '--port', 'eighty'])).toThrow(/--port needs a number/);
    });

    it('takes a number in either form, including a negative one', () => {
      expect(check(['ui', 'last', '--port', '4'])).not.toThrow();
      expect(check(['ui', 'last', '--port=4'])).not.toThrow();
      expect(check(['ui', 'last', '--port', '-1'])).not.toThrow();
    });

    /**
     * `bool()` returns its fallback for a string, so `--json=maybe` turned JSON output *off* while
     * the person was asking for it — and a script reading stdout got a human table.
     */
    it('refuses a value on a flag that is only ever on or off', () => {
      expect(check(['list', '--json=maybe'])).toThrow(/--json takes no value/);
    });

    it('allows the spellings that do mean on and off', () => {
      expect(check(['list', '--json'])).not.toThrow();
      expect(check(['replay', 'last', '--json=true'])).not.toThrow();
      expect(check(['replay', 'last', '--no-json'])).not.toThrow();
    });
  });

  /**
   * The three sets are the whole of the classification, and a flag read one way and declared
   * another is a hole in it. Read from the source, because a hand-kept list drifts the moment the
   * code moves — which is exactly how `--quiet` and `--full` came to be missing from `VALUELESS`.
   */
  describe('the classification against the source it mirrors', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

    function readAs(accessor: string): Set<string> {
      const found = new Set<string>();
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name.endsWith('.ts')) {
            const re = new RegExp(`args\\.(?:${accessor})\\('([^']+)'`, 'g');
            for (const m of readFileSync(path, 'utf8').matchAll(re)) found.add(m[1]!);
          }
        }
      };
      walk(SRC);
      return found;
    }

    it('declares every flag the code reads as a number', () => {
      const missing = [...readAs('num')].filter((n) => !NUMERIC.has(n)).sort();
      expect(missing).toEqual([]);
    });

    it('never declares a flag both valueless and numeric', () => {
      const both = [...NUMERIC].filter((n) => VALUELESS.has(n)).sort();
      expect(both).toEqual([]);
    });

    it('never declares a numeric flag that the code reads as a string or a list', () => {
      const contradictory = [...readAs('str|list')].filter((n) => NUMERIC.has(n)).sort();
      expect(contradictory).toEqual([]);
    });
  });
});
