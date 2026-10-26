import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redaction.js';

const token = 'Zx81Qp0vR7mT2sL9wK4yH6nB3cF5jD';
const marker = /<secret:high_entropy:[0-9a-f]{8}>/;

describe('entropy redaction next to JSON escapes', () => {
  for (const escape of [
    '\\b',
    '\\f',
    '\\n',
    '\\r',
    '\\t',
    '\\u001b',
    '\\u200B',
    '\\\\',
    '\\"',
    '',
  ]) {
    for (const wrappers of [0, 1, 2]) {
      it(`preserves ${escape} through ${wrappers} JSON string wrappers`, () => {
        const body = ` { "content" : "${escape}${token}", "keep" : true } `;
        let input = body;
        for (let i = 0; i < wrappers; i++) input = JSON.stringify(input);
        let output = new Redactor({ salt: 'test' }).redactString(input).value;
        for (let i = 0; i < wrappers; i++) output = JSON.parse(output) as string;
        expect(() => JSON.parse(output)).not.toThrow();
        expect(output).not.toContain(token);
        expect(output.replace(marker, token)).toBe(body);
      });
    }
  }

  it.each(['b', 'f', 'n', 'r', 't', 'u', 'uABCD'])(
    'still redacts a token starting with %s after an escaped backslash',
    (prefix) => {
      const secret = prefix + 'Zx81Qp0vR7mT2sL9wK4'.slice(0, 20 - prefix.length);
      expect(secret).toHaveLength(20);
      const body = JSON.stringify({ content: '\\' + secret });
      const output = new Redactor({ salt: 'test' }).redactString(JSON.stringify(body)).value;
      const decoded = JSON.parse(output) as string;
      expect(() => JSON.parse(decoded)).not.toThrow();
      expect(decoded).not.toContain(secret);
      expect(decoded).toMatch(marker);
    },
  );

  for (const prefix of ['\\n\u200B', '\\nZx81\u200B', '\\u001b\u200B']) {
    for (const wrappers of [0, 1, 2]) {
      it(`retains hidden-token detection after ${prefix} through ${wrappers} wrappers`, () => {
        const tail = 'Qp0vR7mT2sL9wK4yH6n';
        expect(tail).toHaveLength(19);
        let input = `{"content":"${prefix}${tail}"}`;
        for (let i = 0; i < wrappers; i++) input = JSON.stringify(input);
        let output = new Redactor({ salt: 'test' }).redactString(input).value;
        for (let i = 0; i < wrappers; i++) output = JSON.parse(output) as string;
        expect(() => JSON.parse(output)).not.toThrow();
        expect(output).not.toContain(tail);
        expect(output).toMatch(marker);
      });
    }
  }

  it('preserves protocol identifiers and signatures', () => {
    const body = JSON.stringify({
      id: token,
      tool_use_id: token,
      tool_call_id: token,
      signature: token + '+/=',
    });
    const stored = JSON.stringify(body);
    expect(new Redactor({ salt: 'test' }).redactString(stored).value).toBe(stored);
  });

  it('still removes a named secret next to a newline', () => {
    const key = 'sk-abcdefghijklmnop0123456789';
    const body = JSON.stringify({ content: '\n' + key });
    const result = new Redactor({ salt: 'test' }).redactString(JSON.stringify(body));
    expect(() => JSON.parse(JSON.parse(result.value) as string)).not.toThrow();
    expect(result.value).not.toContain(key);
    expect(result.hits.some((hit) => hit.rule === 'sk_api_key')).toBe(true);
  });

  it.each(['', 'ordinary text', '{not json', JSON.stringify({ content: 'ordinary\ntext' })])(
    'leaves unchanged clean input %s',
    (input) => {
      expect(new Redactor({ salt: 'test' }).redactString(input).value).toBe(input);
    },
  );
});
