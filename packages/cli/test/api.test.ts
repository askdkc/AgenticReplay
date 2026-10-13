import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgenticReplay } from '../src/api.js';
import { AGENTICREPLAY_VERSION } from '../src/version.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'responses-agent.mjs');

/**
 * Driving agenticreplay from code.
 *
 * Everything agenticreplay knows was reachable only by running a command and reading a terminal. `agenticreplay
 * show` computed a timeline and then formatted it away; `agenticreplay list` returned `void`. So an agent
 * — or a script, or a CI job — that wanted to ask "what diverged when I replayed that run?" had
 * to parse `info replay.done reused=2/2 exact=2 divergences=0` out of stdout.
 *
 * This is the same work the commands do, returning the data instead of printing it. The commands
 * render what it returns, so there is one source of truth and the terminal is a view of it.
 */
describe('AgenticReplay — the programmatic API', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;
  let agenticreplay: AgenticReplay;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agenticreplay-api-'));
    model = await startResponsesModel();
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    agenticreplay = new AgenticReplay({ cwd: workspace });
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const record = () =>
    agenticreplay.record({
      adapter: 'generic-openai',
      command: [process.execPath, AGENT],
      upstream: { openai: model.url },
    });

  it('records a run and returns what it produced', async () => {
    const result = await record();
    expect(result.runId).toMatch(/^run_[0-9a-f]+$/);
    expect(result.exitCode).toBe(0);
    expect(result.events).toBeGreaterThan(4);
    // `join`, not a literal: the assertion spelled the separator `/` and so only ever held on
    // POSIX. The API returns a real path, and on Windows that is `.agenticreplay\runs\run_…`.
    expect(result.runDir).toContain(join('.agenticreplay', 'runs'));
  });

  it('warns in the result, not only on a terminal, when nothing was captured', async () => {
    // The empty-trace failure has to be visible to a caller that has no stdout to read.
    const result = await agenticreplay.record({
      adapter: 'generic-openai',
      command: [process.execPath, join(here, 'fixtures', 'deaf-agent.mjs')],
      upstream: { openai: model.url },
    });
    expect(result.modelExchanges).toBe(0);
    expect(result.warnings.map((w) => w.event)).toContain('capture.empty');
  });

  it('lists runs as data, newest first', async () => {
    const first = await record();
    const runs = await agenticreplay.list();
    expect(runs.map((r) => r.runId)).toContain(first.runId);
    expect(runs[0]).toMatchObject({ runId: expect.any(String), dir: expect.any(String) });
  });

  it('returns an empty list rather than throwing in a workspace with no runs', async () => {
    const empty = new AgenticReplay({ cwd: await mkdtemp(join(tmpdir(), 'agenticreplay-empty-')) });
    await expect(empty.list()).resolves.toEqual([]);
  });

  it('returns the timeline `agenticreplay show` prints, as objects', async () => {
    const recorded = await record();
    const timeline = await agenticreplay.show(recorded.runId);

    expect(timeline.runId).toBe(recorded.runId);
    // Versioned, as the manifest records it: which adapter *version* produced a trace is the
    // fact that matters when an adapter has rotted and a recording no longer replays.
    //
    // Against the constant rather than a literal. A hardcoded version here asserts nothing about
    // the shape being tested and turns every release into a failing build — which is exactly what
    // it did on the 0.1.1 bump, where the only change in the diff was the version itself.
    expect(timeline.adapter).toBe(`generic-openai@${AGENTICREPLAY_VERSION}`);
    expect(timeline.exitCode).toBe(0);
    expect(timeline.events.length).toBeGreaterThan(4);
    // The rows a caller actually wants to filter on.
    const tool = timeline.events.find((e) => e.kind === 'TOOL');
    expect(tool).toMatchObject({ seq: expect.any(Number), label: 'edit_file' });
    expect(timeline.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  });

  it('resolves `last` the way the CLI does', async () => {
    const recorded = await record();
    expect((await agenticreplay.show('last')).runId).toBe(recorded.runId);
    expect((await agenticreplay.show()).runId).toBe(recorded.runId);
  });

  it('gives a caller the raw events too, not only the rendered rows', async () => {
    // A rendered row is a view. An agent asking "which tool call wrote that file" needs the event.
    const recorded = await record();
    const events = await agenticreplay.events(recorded.runId);
    expect(events.some((e) => e.type === 'tool.call')).toBe(true);
    expect(events.some((e) => e.type === 'fs.change')).toBe(true);
  });

  it('exports a self-contained file and says where it went', async () => {
    const recorded = await record();
    const target = join(workspace, 'bug.html');

    const exported = await agenticreplay.export(recorded.runId, { out: target });

    expect(exported.path).toBe(target);
    expect(exported.bytes).toBeGreaterThan(1000);
    expect(await readFile(target, 'utf8')).toContain(recorded.runId);
  });

  it('throws a real error naming the run, not a process exit', async () => {
    // A library that calls process.exit is a library nobody can build on.
    await expect(agenticreplay.show('run_doesnotexist')).rejects.toThrow(/run_doesnotexist/);
  });

  it('never writes to the terminal of the process that embedded it', async () => {
    // The commands own stdout. The API must not, or a caller's own output is interleaved with
    // agenticreplay's log lines and every JSON consumer downstream breaks.
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      await record();
      await agenticreplay.list();
    } finally {
      process.stdout.write = write;
    }
    expect(chunks.join('')).not.toContain('info recorded');
  });
});
