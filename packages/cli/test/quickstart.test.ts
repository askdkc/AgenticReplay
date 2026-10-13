import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quickstartCommand } from '../src/commands/quickstart.js';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';

function capture(): { out: Output; lines: () => string } {
  let text = '';
  const out = new Output({ write: (s) => void (text += s), color: false, ci: true });
  return { out, lines: () => text };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agenticreplay-qs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('recording quickstart', () => {
  it('installs the sample project and an existing trace for inspection without running an agent', async () => {
    const { out, lines } = capture();
    const result = await quickstartCommand(parseArgs(['quickstart']), out, dir);
    const runDir = join(result.dir, '.agenticreplay', 'runs', result.runId);
    await expect(readFile(join(runDir, 'manifest.json'), 'utf8')).resolves.toContain(result.runId);
    await expect(readFile(join(runDir, 'events.jsonl'), 'utf8')).resolves.toContain('model.response');
    await expect(readFile(join(result.dir, 'src', 'schedule.js'), 'utf8')).resolves.toContain('nextOccurrence');
    expect(result.turns).toBeGreaterThan(0);
    expect(lines()).toContain('quickstart.ready');
    expect(lines()).toContain('agenticreplay show');
    expect(lines()).not.toMatch(/replay|fork|compare/i);
  });

  it('shows the recorded timeline on request', async () => {
    const { out, lines } = capture();
    await quickstartCommand(parseArgs(['quickstart', '--full']), out, dir);
    expect(lines()).toContain('SEQ');
    expect(lines()).toContain('model.response');
  });

  it('refuses to overwrite a non-empty destination', async () => {
    const { out } = capture();
    await expect(quickstartCommand(parseArgs(['quickstart']), out, dir)).rejects.toThrow(/already exists/);
    await expect(quickstartCommand(parseArgs(['quickstart']), out, dir)).rejects.toThrow(/already exists/);
  });
});
