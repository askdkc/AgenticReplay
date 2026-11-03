import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceReader } from '@agenticreplay/core';
import * as proxyModule from '@agenticreplay/proxy';
import { parseArgs } from '../src/args.js';
import { recordCommand } from '../src/commands/record.js';
import { Output } from '../src/out.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});

describe('recording diagnostics while a harness owns the terminal', () => {
  it('continues the child session across capture overflow and records the omission without printing into its terminal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agenticreplay-terminal-overflow-'));
    cleanup.push(() => rm(cwd, { recursive: true, force: true }));
    const model = await startFakeModel();
    cleanup.push(model.close);
    const active = join(cwd, 'harness-active');
    const duringChild: string[] = [];
    const lines: string[] = [];
    const result = await recordCommand(
      parseArgs([
        'record',
        'generic-openai',
        '--no-fs',
        '--no-shell',
        '--no-agent-spans',
        '--max-body-bytes',
        '1024',
        '--max-buffered-bytes',
        '4096',
        '--upstream-anthropic',
        model.url,
        '--upstream-openai',
        model.url,
        '--',
        process.execPath,
        '-e',
        `
        const fs = require('node:fs');
        fs.writeFileSync('harness-active', '');
        (async () => {
          for (const length of [64, 4096, 64]) {
            const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'x'.repeat(length) }] })
            });
            if (response.status !== 200 || !(await response.text()).includes('msg_0')) process.exit(3);
          }
          fs.unlinkSync('harness-active');
        })().catch(() => process.exit(4));
      `,
      ]),
      new Output({
        isTTY: true,
        write: (line) => {
          lines.push(line);
          if (existsSync(active)) duringChild.push(line);
        },
      }),
      cwd,
    );
    expect(result.childExitCode).toBe(0);
    expect(model.calls).toHaveLength(3);
    expect(duringChild).toEqual([]);
    expect(lines.join('')).toContain('proxy.request_too_large');
    const reader = await TraceReader.open(result.runDir);
    const events = await reader.events();
    expect(events.filter((event) => event.type === 'model.request')).toHaveLength(2);
    expect(
      events.some((event) => event.type === 'net.request' && event.attrs['truncated'] === true),
    ).toBe(true);
    expect(await reader.verifyIntegrity()).toMatchObject({ ok: true });
  });

  it.each([true, false])(
    'protects terminal output and preserves pipe output (TTY=%s)',
    async (isTTY) => {
      const cwd = await mkdtemp(join(tmpdir(), 'agenticreplay-terminal-'));
      cleanup.push(() => rm(cwd, { recursive: true, force: true }));
      const model = await startFakeModel();
      cleanup.push(model.close);
      const active = join(cwd, 'harness-active');
      const lines: string[] = [];
      const duringChild: string[] = [];
      const diagnostics: string[] = [];
      const createProxy = proxyModule.createProxy;
      let handle: proxyModule.ProxyHandle | undefined;
      vi.spyOn(proxyModule, 'createProxy').mockImplementation(async (options) => {
        handle = await createProxy(options);
        return handle;
      });
      const out = new Output({
        isTTY,
        color: false,
        write: (line) => {
          lines.push(line);
          if (existsSync(active)) duringChild.push(line);
        },
        sink: (entry) => {
          if (existsSync(active)) diagnostics.push(entry.event);
        },
      });
      const script = `
      const fs = require('node:fs');
      fs.writeFileSync('harness-active', '');
      (async () => {
        for (let turn = 0; turn < 32; turn++) {
          const response = await fetch(process.env.ANTHROPIC_BASE_URL + (turn === 31 ? '/v1/unknown' : '/v1/messages'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'x'.repeat(128 * (turn + 1)) }] })
          });
          if (response.status !== 200 || !(await response.text()).includes('msg_0')) process.exit(3);
        }
        fs.unlinkSync('harness-active');
      })().catch(() => process.exit(4));
    `;
      const result = await recordCommand(
        parseArgs([
          'record',
          'generic-openai',
          '--no-fs',
          '--no-shell',
          '--no-agent-spans',
          '--upstream-anthropic',
          model.url,
          '--upstream-openai',
          model.url,
          '--',
          process.execPath,
          '-e',
          script,
        ]),
        out,
        cwd,
      );

      expect(result.childExitCode).toBe(0);
      expect(model.calls).toHaveLength(32);
      expect(handle?.exchanges().length).toBe(0);
      expect(diagnostics).toContain('proxy.unclaimed_path');
      expect(lines.join('')).toContain('proxy.unclaimed_path');
      if (isTTY) expect(duringChild).toEqual([]);
      else expect(duringChild.join('')).toContain('proxy.unclaimed_path');
      out.info('after.child');
      expect(lines.at(-1)).toContain('after.child');
      const reader = await TraceReader.open(result.runDir);
      const events = await reader.events();
      expect(events.filter((event) => event.type === 'model.request')).toHaveLength(31);
      expect(await reader.verifyIntegrity()).toMatchObject({ ok: true });
    },
  );
});
