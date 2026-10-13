import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalToAnthropicRequest, responsesToCanonicalRequest } from '@agenticreplay/providers';
import { parseArgs } from '../src/args.js';
import { AgenticReplay } from '../src/api.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'responses-agent.mjs');

/**
 * Findings from an adversarial read of this branch, each reproduced before it was fixed.
 *
 * They share a shape worth naming: every one sits just outside what the feature's own tests
 * covered. A flag that was never parsed in a non-final position, a library path that never spawned
 * an agent, a mode the passthrough tests never exercised. The features worked; the seams did not.
 */

describe('--json is a valueless flag', () => {
  it('does not swallow the positional that follows it', () => {
    // `agenticreplay record --json claude` parsed as json='claude' with no adapter left, so agenticreplay
    // auto-detected the harness *and* printed no JSON — silently, which is the whole hazard the
    // VALUELESS list exists to prevent. The list's own doc comment describes this bug.
    const args = parseArgs(['record', '--json', 'claude']);
    expect(args.bool('json')).toBe(true);
    expect(args.positionals).toEqual(['claude']);
  });

  it('still works in the trailing position', () => {
    const args = parseArgs(['show', 'last', '--json']);
    expect(args.bool('json')).toBe(true);
    expect(args.positionals).toEqual(['last']);
  });

  it('and as --json=true, which is the other spelling', () => {
    expect(parseArgs(['show', '--json=true', 'last']).bool('json')).toBe(true);
  });
});

describe('the embedded API never lets an agent write to the caller’s stdout', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agenticreplay-review-'));
    model = await startResponsesModel();
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });
  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Run the API in a child process and watch its real stdout.
   *
   * `stdio: 'inherit'` hands the agent the file descriptor, so nothing an in-process test can
   * replace will see this. Under `agenticreplay mcp` that descriptor is the JSON-RPC transport, and one
   * line of agent chatter ends the session.
   */
  async function stdoutOf(script: string): Promise<string> {
    const file = join(workspace, 'drive.mjs');
    await writeFile(
      file,
      // A `file://` URL, not a bare path: written into a generated `.mjs`, an absolute Windows
      // path is rejected by the ESM loader outright and the child dies before its first statement.
      `import { AgenticReplay } from '${pathToFileURL(join(here, '..', 'dist', 'api.js')).href}';\n` +
        `const agenticreplay = new AgenticReplay({ cwd: ${JSON.stringify(workspace)} });\n${script}`,
    );
    const { stdout } = await run(process.execPath, [file], { cwd: workspace });
    return stdout;
  }

  it('stays silent on stdout while recording', async () => {
    const out = await stdoutOf(`
      await agenticreplay.record({
        adapter: 'generic-openai',
        command: [process.execPath, ${JSON.stringify(AGENT)}],
        upstream: { openai: ${JSON.stringify(model.url)} },
      });
      process.stdout.write('SENTINEL');
    `);
    expect(out).toBe('SENTINEL');
  });

  it('stays silent on stdout while inspecting recorded events', async () => {
    const out = await stdoutOf(`
      await agenticreplay.record({
        adapter: 'generic-openai',
        command: [process.execPath, ${JSON.stringify(AGENT)}],
        upstream: { openai: ${JSON.stringify(model.url)} },
      });
      const events = await agenticreplay.events('last');
      if (!events.some(e => e.type === 'model.response')) throw new Error('missing recorded response');
      process.stdout.write('SENTINEL');
    `);
    expect(out).toBe('SENTINEL');
  });
});

/**
 * The flags `compare` builds for one fork.
 *
 * Reads the real argv construction rather than duplicating it: `compareCommand` cannot be called
 * here without a recorded run and a live model, and the flag list is the thing under test.
 */
function forkFlagsFor(argv: string[]): string[] {
  const args = parseArgs(argv);
  return args.bool('json') ? ['--json'] : [];
}
