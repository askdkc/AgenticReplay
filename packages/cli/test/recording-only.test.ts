import { describe, expect, it } from 'vitest';
import { AgenticReplay } from '../src/api.js';
import { MCP_TOOLS } from '../src/mcp-server.js';
import { main } from '../src/main.js';
import * as proxy from '@agenticreplay/proxy';
import { ShadowIndex } from '@agenticreplay/fs-capture';
import { CONTRACT_CHECKS } from '@agenticreplay/adapters';

describe('recording-only product surface', () => {
  it('has no model substitution or workspace restoration API', () => {
    expect('betasForModelChange' in proxy).toBe(false);
    expect('materialize' in ShadowIndex.prototype).toBe(false);
    expect(CONTRACT_CHECKS).not.toContain('artifacts-resettable');
    expect(CONTRACT_CHECKS).not.toContain('deterministic');
  });
  it('keeps replay, fork, compare, and checkpoint actions out of the programmatic API', () => {
    const api = AgenticReplay.prototype as Record<string, unknown>;
    for (const name of ['replay', 'fork', 'compare', 'checkpoints']) {
      expect(api[name], name).toBeUndefined();
    }
  });

  it('does not advertise replay or re-execution tools over MCP', () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain('agenticreplay_replay');
    expect(names).not.toContain('agenticreplay_checkpoints');
    expect(names).not.toContain('agenticreplay_compare');
    expect(names).toContain('agenticreplay_list_runs');
    expect(names).toContain('agenticreplay_show_run');
    expect(names).toContain('agenticreplay_graph');
  });

  it('keeps the CLI help focused on recording and reading runs', async () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await main(['--help']);
    } finally {
      process.stdout.write = write;
    }
    const help = chunks.join('');
    expect(help).toContain('agenticreplay record');
    expect(help).toContain('agenticreplay show');
    expect(help).not.toMatch(/agenticreplay (replay|fork|compare|checkpoints)\b/);
  });
});
