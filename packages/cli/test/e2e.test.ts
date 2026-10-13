import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TraceReader,
  listRuns,
  resolveRunSelector,
  runGraph,
  chainTo,
} from '@agenticreplay/core';
import { isBlobRef, validateEvent, validateManifest } from '@agenticreplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { startFakeModel } from './fixtures/fake-model.mjs';
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/**
 * Run `body` with the temp directory pointed somewhere only this test can reach, and hand back
 * what was left in it.
 *
 * A replay's safety scratch goes to `os.tmpdir()`, so asserting on what it leaves there means
 * asserting on a directory the whole machine shares — the other suites replay too, and a test
 * that diffed the real `$TMPDIR` failed under `vitest run` while passing on its own. Moving the
 * directory for the duration makes "nothing was left behind" a statement about this replay.
 */
async function withIsolatedTmp<T>(
  body: () => Promise<T>,
): Promise<{ result: T; leftBehind: string[] }> {
  const isolated = await mkdtemp(join(tmpdir(), 'agenticreplay-tmproot-'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = isolated;
  process.env.TMP = isolated;
  process.env.TEMP = isolated;
  try {
    const result = await body();
    return { result, leftBehind: await readdir(isolated) };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The acceptance test for the whole project.
 *
 *   agenticreplay record <agent>
 *   agenticreplay replay last
 *   agenticreplay replay last --from N --model <other>
 *
 * If these three work against a real child process, a real proxy and a real trace on disk, the
 * mechanism is proven. Everything else is refinement.
 */
describe('end to end: record and inspect', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agenticreplay-e2e-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    // A git repo so the shadow index has something to work with.
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function record(turns = 3) {
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      model.url,
      '--',
      'node',
      FAKE_AGENT,
    ]);
    process.env.FAKE_AGENT_TURNS = String(turns);
    delete process.env.FAKE_AGENT_CWD;
    return recordCommand(args, out, workspace);
  }

  it('records a run that validates against the normative schema', async () => {
    const result = await record();

    expect(result.events).toBeGreaterThan(4);

    const reader = await TraceReader.open(result.runDir);
    expect(validateManifest(reader.manifest()).valid).toBe(true);
    for (const event of await reader.events()) {
      const r = validateEvent(event);
      expect(r.valid, `seq ${event.seq}: ${r.errors.join(', ')}`).toBe(true);
    }
  });

  it('captures the tool loop the agent actually ran', async () => {
    const result = await record();
    const reader = await TraceReader.open(result.runDir);
    const events = await reader.events();
    const types = events.map((e) => e.type);

    expect(types).toContain('model.request');
    expect(types).toContain('model.response');
    // The whole thesis: a proxy that only sees model traffic still recovers the tool loop.
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');

    const call = events.find((e) => e.type === 'tool.call');
    expect(call?.attrs?.name).toBe('edit_file');
  });

  it('captures the filesystem change the agent made', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const changes = events.filter((e) => e.type === 'fs.change');
    expect(changes.some((c) => String(c.attrs?.path).endsWith('auth.ts'))).toBe(true);
    expect(await readFile(join(workspace, 'auth.ts'), 'utf8')).toContain('fixed = true');
  });

  it('verifies its own integrity digest', async () => {
    const result = await record();
    expect((await (await TraceReader.open(result.runDir)).verifyIntegrity()).ok).toBe(true);
  });

  

  

  

  

  

  

  /**
   * A refusal must not cost you your working tree.
   *
   * `upstreamPlan` rejects an upstream that is not an origin, and it used to be resolved *after*
   * `replayWorkspace` had already replaced the checkout with the recording — so the throw escaped
   * the `finally` that puts the tree back, which only begins at the child's launch. The operator's
   * own files were left in an `agenticreplay-safety-*` scratch nothing pointed at, on a command that had
   * just printed "your files are restored when the replay ends".
   *
   * Asserted on the file rather than on the error, because the error was never the problem.
   */
  

  /**
   * Nor may a refusal leave a run behind.
   *
   * The same misordering as above, in its quiet form. `upstreamPlan` throws for an upstream that is
   * not an origin, and every command resolved it *after* creating the run directory — `record`,
   * `attach`, and the fork path, which also restores a temp worktree first. So a typo in
   * `--upstream-*` left an empty run for `agenticreplay list` to show, reading `FROM <parent>@<n>` on a fork
   * as though it had run, plus a restored tree abandoned in `$TMPDIR`. Nothing was lost, which is
   * why it went unnoticed; it is the same rule, and the rule is that an invocation which cannot
   * work decides so before it touches anything.
   */
  

  /**
   * The same rule, for the other refusal in the same window.
   *
   * `--tls-hosts` is refused by `resolveTlsHosts`/`HostPolicy.from`, and that happened inside
   * `setupTlsCapture` — reached after `replayWorkspace` had already written the recording over the
   * checkout, and after the replay's own run directory existed. The throw escaped the `finally`
   * that puts the tree back for the same reason the upstream one did: that `finally` only begins
   * at the child's launch. So the operator was left holding the recording's files, with their own
   * work in an `agenticreplay-safety-*` scratch whose path nothing prints.
   *
   * `planTlsCapture` is the refusing half on its own and mints nothing; `attach` already calls it
   * before its run directory for exactly this reason.
   */
  

  /**
   * The refusal that hoisting alone would still have missed.
   *
   * `AGENTICREPLAY_TLS_UPSTREAM_CA` is read from disk, so it cannot be decided from the arguments the way
   * a host list can — `setupTlsCapture` opens it, past the restore. Two things now stand between
   * that and the operator's checkout: `planTlsCapture` reads the roots too, so the refusal
   * happens before `replayWorkspace`; and the release is armed for the whole restored span, so a
   * throw that gets past the first still puts the tree back.
   *
   * Worth its own test because it is the one that proves the rule generalises. `createProxy`,
   * `RunCa.create` and `adapter.prepare` all sit in the same window and are not on any list.
   */
  

  /**
   * And the same on the two paths where only scratch is at stake.
   *
   * A fork restores its checkpoint into a temp worktree and opens its own run before it reaches
   * `setupTlsCapture`, and `record` opens its run first too — so a refused host list left an empty
   * run for `agenticreplay list` to show, plus a worktree in `$TMPDIR` that `agenticreplay gc` will not reclaim
   * because no manifest points at it. Cheaper than the checkout, the same rule.
   */
  

  /**
   * The restore is inside the thing that undoes it, so the caller cannot guard it.
   *
   * `replayWorkspace` snapshots the checkout, then overwrites it, then returns the `release` that
   * puts it back — so a `materialize` that fails rejects before its caller has anything to call.
   * The guard in `replayExact` is armed on the next line and never ran; the scratch holding the
   * only copy of the operator's tree was abandoned in `$TMPDIR` with nothing printing its path.
   *
   * The store is emptied of its objects rather than deleted, so `FsCapture.start` still opens it
   * and the failure lands where it matters: on `read-tree`, inside the restore. `agenticreplay gc` on a
   * half-copied trace gets there the same way.
   */
  

  /**
   * A replay that dies after minting a certificate authority must take the key with it.
   *
   * `tls-capture.ts` puts it in writing — "the caller owns the CA's lifetime and must dispose it
   * on every exit path" — and `replayCommand` had no equivalent of the `minted` wrapper that
   * `recordCommand` and `attachCommand` use. Between `RunCa.create` and the child's launch sit
   * `createProxy`, `mcpForReplay` and `adapter.prepare`, and a throw from any of them left
   * `tls/ca.key` on disk.
   *
   * The throw here is a trace naming an adapter this build does not have, which is what replaying
   * a newer agenticreplay's recording looks like. It also pins the other half: the proxy is listening by
   * then, and a proxy that is not closed keeps Node's event loop alive — so a regression shows up
   * as this test timing out rather than as a hang nobody notices until a user reports it.
   */
  

  /**
   * The one line a reader checks to know whether a run can spend money.
   *
   * `egress` was a literal, so `--loose` — which answers an unmatched request from the provider —
   * still announced `blocked`. Asserted on both spellings rather than only the flag's, because the
   * bug was that one value was printed for two behaviours; a test that only pins `--loose` would
   * pass again the moment someone hardcoded the other way round.
   */
  

  

  /**
   * "Your files are restored when the replay ends" has two halves, and the put-back kept neither
   * where the recorded tree and the working tree disagree about what exists. It is undone from an
   * ordinary snapshot, which honours `.gitignore`, so a file the recording tracked and the
   * workspace ignores now was overwritten with no copy to restore it from. And a snapshot restore
   * writes files without removing any, so a file the recording had and the operator has deleted
   * since came back, and stayed.
   */
  

  /**
   * The same promise, for what the replayed agent writes rather than what the restore does. An exact
   * replay makes the recorded agent do what it did, so a file it created during the recording is
   * created again — and the put-back, whose copy never had it, left it in the operator's tree.
   */
  

  /**
   * A file standing where the recording had a directory is in the way of every path under it, and
   * the restore deletes it to make the directory. `lstat` answers ENOTDIR for those paths, which
   * read as "nothing there" — so an ignored file at such a path was destroyed without a copy.
   */
  

  /**
   * A junction is a directory as far as git is concerned: the copy holds what is inside it as
   * ordinary files, and the restore writes through it. Judged by `lstat`, which calls it a link,
   * a file deleted from under one refused the whole replay — "would overwrite data" — when the
   * restore would only have written that file back and the put-back taken it away again. On POSIX
   * git records a symlink as itself, so there this holds trivially; on Windows it is the case.
   */
  

  /**
   * The other half of the case above: a file where the recording had a directory, and one the copy
   * DOES hold. The restore deletes it to make the directory; the put-back writes it back, and
   * `checkout-index -f` clears the directory it made to do so. So this replays, rather than being
   * refused — and the operator's uncommitted edit survives it. Pinned because it was disputed: the
   * claim was that the put-back skips a file over a non-empty directory, which git 2.43 (Linux) and
   * 2.55 (Windows) both do not.
   */
  

  

  /**
   * `--worktree` promises never to touch your files, and two branches ahead of the one that reads
   * it broke the promise: `--in-place` given beside it won without a word, and a run recorded with
   * --no-fs fell through to the in-place warning and ran the agent over the working tree anyway —
   * the recorded edit landed on uncommitted work.
   */
  

  

  /**
   * A RUN CAN BE WITHOUT THE STORE ITS OWN EVENTS POINT AT: pulled from a gateway it was pushed to
   * without `--fs`, or put through `agenticreplay scrub --drop-fs`. Either way its `fs.snapshot` events name
   * trees that are nowhere on this machine, and a restore of one died inside git — "failed to
   * unpack tree object <40 hex>" — on `agenticreplay replay` and `--worktree` alike, while only the fork
   * path said what had happened. Each refusal also left an empty directory in `$TMPDIR` that
   * nothing named and `agenticreplay gc` never reclaims.
   */
  

  

  

  /**
   * The directory a run was recorded in is that directory however the path to it is spelled.
   *
   * Windows hands a process its working directory as typed — `C:\…` from PowerShell, `c:\…` from
   * cmd — and a junction or symlink names the same folder differently again. Compared as strings,
   * the replay called it "elsewhere", skipped the safety copy, and the recorded edit replaced
   * uncommitted work in the very directory the run was made in.
   */
  

  it('records the commit the run started from', async () => {
    // `manifest.git` is in the schema, the Python reader parses it, and nothing ever wrote it — so
    // every trace was missing the single most useful piece of provenance for "why did my agent
    // delete my file": which commit it was looking at.
    // The shared fixture inits a repo but never commits, so HEAD is unborn there. Commit here
    // rather than in `beforeEach`: other tests assert on a dirty tree and should keep doing so.
    await run('git', ['add', '-A'], { cwd: workspace });
    await run('git', ['commit', '-qm', 'initial'], { cwd: workspace });

    const result = await record();
    const manifest = (await TraceReader.open(result.runDir)).manifest();
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();

    expect(manifest.git?.head).toBe(head);
    expect(manifest.git?.branch).toBeDefined();
    // The agent edits a file, so by the end the tree is dirty — but `git` describes the state the
    // run *started* from, which is what makes it a reproduction instruction.
    expect(manifest.git?.dirty).toBe(false);
  });

  it('closes the proxy and seals the trace when the agent will not start', async () => {
    // Two bugs, one cause. `recordCommand` had no `try/finally`, so a throw skipped both
    // `proxy.close()` and `writer.close()`.
    //
    // The proxy is the visible one: a listening server keeps Node's event loop alive, so
    // `agenticreplay record generic-openai -- /nonexistent` printed its error and then **hung** — verified
    // against the built CLI, killed at 12s. Mistyping an agent name is the first thing a new user
    // does.
    //
    // The trace is the quieter one: everything the agent did is on disk, but with no `ended_at`,
    // no `counts` and no `integrity`, so `verifyIntegrity` reports the run as tampered rather than
    // as unfinished. The same shape loses a complete recording to one failed write.
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      model.url,
      '--',
      join(workspace, 'no-such-binary'),
    ]);

    await expect(recordCommand(args, out, workspace)).rejects.toThrow();

    const runs = await listRuns(workspace);
    expect(runs, 'the run directory should still exist').toHaveLength(1);
    const manifest = (await TraceReader.open(runs[0]!.dir)).manifest();
    expect(manifest.ended_at, 'a failed run must still be sealed').toBeDefined();
    expect(manifest.integrity?.events_sha256).toBeDefined();
  });

  

  

  

  

  

  it('never writes the agent api key into the trace', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-e2e-secret-key-should-never-appear-anywhere';
    try {
      const result = await record();
      const raw = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
      expect(raw).not.toContain('sk-e2e-secret-key-should-never-appear-anywhere');
      const manifest = await readFile(join(result.runDir, 'manifest.json'), 'utf8');
      expect(manifest).not.toContain('sk-e2e-secret-key-should-never-appear-anywhere');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  /**
   * The edges that make a run answerable in one hop rather than by reading every line. Asserted
   * against a real recording rather than a fixture, because the seq resolution happens in the
   * recorder and a unit test of the deriver cannot see it.
   */
  describe('causal edges', () => {
    it('points each tool.call at the model.response that emitted it', async () => {
      const result = await record();
      const events = await (await TraceReader.open(result.runDir)).events();
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      const calls = events.filter((e) => e.type === 'tool.call');

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.causes, `tool.call seq ${call.seq} names no cause`).toHaveLength(1);
        expect(bySeq.get(call.causes![0]!)?.type).toBe('model.response');
      }
    });

    it('points a model.request at the tool.result it carried back', async () => {
      const result = await record();
      const events = await (await TraceReader.open(result.runDir)).events();
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      const carrying = events.filter((e) => e.type === 'model.request' && e.causes?.length);

      expect(carrying.length).toBeGreaterThan(0);
      for (const request of carrying) {
        for (const cause of request.causes ?? []) {
          expect(bySeq.get(cause)?.type).toBe('tool.result');
        }
      }
    });

    it('keeps every edge pointing backwards, as spec §2.1 requires of causes', async () => {
      const result = await record();
      const events = await (await TraceReader.open(result.runDir)).events();
      for (const event of events) {
        for (const cause of event.causes ?? []) expect(cause).toBeLessThan(event.seq);
      }
    });

    it('derives the tool call behind a file change without writing that edge to the trace', async () => {
      const result = await record();
      const events = await (await TraceReader.open(result.runDir)).events();

      // The recorder must not have written it: a snapshot is per turn, so this is a guess.
      for (const change of events.filter((e) => e.type === 'fs.change')) {
        expect(change.causes).toBeUndefined();
      }

      // The reader derives it anyway, and says that it did.
      const inferred = runGraph(events).edges.filter((e) => e.kind === 'inferred');
      expect(inferred.length).toBeGreaterThan(0);
      const bySeq = new Map(events.map((e) => [e.seq, e]));
      for (const edge of inferred) {
        expect(bySeq.get(edge.from)?.type).toBe('tool.call');
        expect(edge.rule).not.toBe('');
      }
    });

    it('walks from a file change back to the model turn that caused it', async () => {
      const result = await record();
      const events = await (await TraceReader.open(result.runDir)).events();
      const change = events.find((e) => e.type === 'fs.change');
      expect(change).toBeDefined();

      const chain = chainTo(runGraph(events), change!.seq).nodes.map((n) => n.type);
      expect(chain).toContain('tool.call');
      expect(chain).toContain('model.response');
    });
  });
});
