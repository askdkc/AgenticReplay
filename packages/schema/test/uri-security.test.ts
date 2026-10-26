import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// Exercise the URI resolver actually used by schema validation.
const uri = createRequire(require.resolve('ajv'))('fast-uri');

describe('Ajv URI resolver security regressions', () => {
  it('does not decode percent-encoded schemes into executable schemes', () => {
    for (const input of ['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)']) {
      expect(uri.parse(input).scheme).not.toBe('javascript');
      expect(uri.normalize(input)).not.toMatch(/^javascript:/i);
    }
    expect(uri.equal('%68ttp://a/', 'http://a/')).toBe(false);
  });

  it('rejects host input that WHATWG canonicalization would silently rewrite', () => {
    for (const input of ['http://a@b@evil.example/', 'http://exa\tmple.com/']) {
      expect(uri.parse(input).error).toBeTruthy();
    }
  });

  it('keeps first-segment colons inert when serializing suffix references', () => {
    const suffix = uri.serialize({ path: 'javascript:alert(1)' }, { reference: 'suffix' });
    expect(new URL(suffix, 'https://example.test/').protocol).toBe('https:');
  });

  it('preserves the target of relative references during normalization', () => {
    const base = 'https://example.test/dir/base';
    for (const ref of ['../x', 'a/../b']) {
      expect(uri.resolve(base, uri.normalize(ref))).toBe(uri.resolve(base, ref));
    }
    expect(uri.equal('../x', 'x')).toBe(false);
  });
});
