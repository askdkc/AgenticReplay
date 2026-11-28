import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { basename, join } from 'node:path';
import type { BlobRef, Manifest, TraceEvent } from '@agenticreplay/schema';
import {
  INLINE_PAYLOAD_LIMIT,
  RUN_ID_PATTERN,
  SCHEMA_VERSION,
  validateManifest,
} from '@agenticreplay/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobStore } from '../src/blobs.js';
import { TraceReader } from '../src/reader.js';
import { TraceWriter } from '../src/writer.js';

let root: string;
let runs: string;

const INIT = {
  adapter: { id: 'claude-code', version: '0.1.0' },
  argv: ['claude', '--dangerously-skip-permissions'],
  cwd: '/workspace',
  agenticreplayVersion: '0.1.0',
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenticreplay-writer-'));
  runs = join(root, 'runs');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Every event the writer recorded, read back through the reader rather than off one file.
 *
 * A run may rotate, so `events.jsonl` alone is a prefix — the mistake the production paths are
 * being changed to stop making, and not one worth reproducing in the tests that check them.
 */
async function lines(w: TraceWriter): Promise<TraceEvent[]> {
  return (await TraceReader.open(w.runDir)).events();
}

describe('events that happened before they were written', () => {
  /**
   * Shell and MCP frames are drained from disk after the agent exits, so stamping them at write
   * time put every one of them at the end of the run with the final turn number — `ts`, `mono_us`
   * and `turn` all wrong, no possible interleaving with the model events they sit between, and
   * `causes` unable to link a tool call to the command it produced. Spec §2.1 calls `mono_us`
   * authoritative for duration, which it cannot be if it records the drain.
   */
  it('uses the time an event happened, not the time it was written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-when-'));
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      agenticreplayVersion: '0.0.0',
    });
    // The frame happened here, and is written 250ms later — the drain the real recorder does.
    const happened = new Date();
    await sleep(250);
    const event = await writer.append({
      type: 'shell.exec',
      actor: 'harness',
      turn: 2,
      occurredAt: happened,
      attrs: { argv: ['sh', '-c', 'true'] },
    });
    const written = await writer.append({ type: 'note', actor: 'agenticreplay' });
    await writer.close(0);

    expect(event.ts).toBe(happened.toISOString());
    // `toBeGreaterThanOrEqual(0)` used to stand here, which every possible number satisfies —
    // including the drain reading this test exists to rule out. The gap is the assertion: an event
    // stamped when it happened is a quarter of a second behind one stamped now.
    expect(written.mono_us - event.mono_us).toBeGreaterThan(200_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('clamps an event that happened before the run to the start of it', async () => {
    // A shell frame can carry a clock reading fractionally behind the writer's own start, and a
    // negative offset into a run is not a thing spec §2.1 can express.
    const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-when-'));
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      agenticreplayVersion: '0.0.0',
    });
    const event = await writer.append({
      type: 'shell.exec',
      actor: 'harness',
      occurredAt: new Date(Date.now() - 60_000),
      attrs: { argv: ['sh', '-c', 'true'] },
    });
    await writer.close(0);

    expect(event.mono_us).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('still stamps the clock itself when nothing is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-when-'));
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      agenticreplayVersion: '0.0.0',
    });
    const before = Date.now();
    const event = await writer.append({
      type: 'note',
      actor: 'agenticreplay',
      attrs: { rule: 'x' },
    });
    await writer.close(0);

    expect(Date.parse(event.ts)).toBeGreaterThanOrEqual(before - 1000);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('TraceWriter.create', () => {
  it('mints a run id matching the spec pattern', async () => {
    const w = await TraceWriter.create(runs, INIT);
    expect(w.runId).toMatch(RUN_ID_PATTERN);
    expect(w.runId).toMatch(/^run_[0-9a-f]{12}$/);
    await w.close();
  });

  it('mints a different id every time', async () => {
    const a = await TraceWriter.create(runs, INIT);
    const b = await TraceWriter.create(runs, INIT);
    expect(a.runId).not.toBe(b.runId);
    await a.close();
    await b.close();
  });

  it('honours a caller-supplied run id and rejects a malformed one', async () => {
    const w = await TraceWriter.create(runs, { ...INIT, runId: 'run_abc123' });
    expect(w.runId).toBe('run_abc123');
    expect(basename(w.runDir)).toMatch(/^\d{14}-claude-code-session-abc123$/);
    await w.close();
    await expect(TraceWriter.create(runs, { ...INIT, runId: 'nope' })).rejects.toThrow(/run id/i);
  });

  it('preserves a valid high-entropy run id during manifest redaction', async () => {
    // This is a real failing ID captured from the DSH acceptance failure. The
    // previous whole-manifest entropy sweep replaced it with a secret marker,
    // so schema validation rejected an otherwise valid recording.
    const runId = 'run_d99a8e9bc33113e4658d6472';
    const w = await TraceWriter.create(runs, { ...INIT, runId });
    const manifest = JSON.parse(
      await readFile(join(w.runDir, 'manifest.json'), 'utf8'),
    ) as Manifest;
    expect(manifest.run_id).toBe(runId);
    expect(validateManifest(manifest).errors).toEqual([]);
    await w.close();
  });

  it('writes a manifest immediately, so a run that crashes is still readable', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const m = JSON.parse(await readFile(join(w.runDir, 'manifest.json'), 'utf8')) as Manifest;
    expect(validateManifest(m).errors).toEqual([]);
    expect(m.run_id).toBe(w.runId);
    expect(m.adapter.id).toBe('claude-code');
    expect(m.ended_at).toBeUndefined();
    await w.close();
  });

  it('captures the environment by allowlist only', async () => {
    process.env['AGENTICREPLAY_TEST_SECRET'] = 'sk-abcdefghijklmnop0123';
    process.env['AGENTICREPLAY_TEST_OK'] = 'yes';
    try {
      const w = await TraceWriter.create(runs, {
        ...INIT,
        envAllowlist: ['AGENTICREPLAY_TEST_OK'],
      });
      const m = await w.close();
      expect(m.env_allowlisted).toEqual({ AGENTICREPLAY_TEST_OK: 'yes' });
      expect(JSON.stringify(m)).not.toContain('sk-abcdef');
    } finally {
      delete process.env['AGENTICREPLAY_TEST_SECRET'];
      delete process.env['AGENTICREPLAY_TEST_OK'];
    }
  });

  it('starts the sequence at zero', async () => {
    const w = await TraceWriter.create(runs, INIT);
    expect(w.seq).toBe(0);
    await w.close();
  });
});

/**
 * SPEC §2.3 BRACKETS, ENFORCED WHERE THE MISTAKE IS STILL CHEAP.
 *
 * Three commands broke this three different ways and every one of them shipped: `record
 * --mcp-config` put a note at seq 0, `attach` wrote neither bracket, and a fork opened on `fork`.
 * All three produce a trace that `agenticreplay show`, `agenticreplay replay` and the viewer render happily, and
 * that a gateway refuses on push — after the agent session is over and the recording is the only
 * copy of it.
 *
 * The rules are the three a deliberate fragment cannot reach by accident. "seq 0 must BE
 * run.start" is deliberately NOT one of them: this writer also builds fixtures and conformance
 * vectors, which are allowed to be a handful of events with no bracket at all.
 */
describe('TraceWriter — the brackets a run is required to have', () => {
  it('refuses run.start anywhere but seq 0', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay' });
    await expect(w.append({ type: 'run.start', actor: 'agenticreplay' })).rejects.toThrow(/seq 0/);
    await w.close();
  });

  it('refuses a second run.start', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await expect(w.append({ type: 'run.start', actor: 'agenticreplay' })).rejects.toThrow(/seq 0/);
    await w.close();
  });

  it('refuses run.end on a run that was never opened', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'model.request', actor: 'model' });
    await expect(w.append({ type: 'run.end', actor: 'agenticreplay' })).rejects.toThrow(
      /no run.start/,
    );
    await w.close();
  });

  it('refuses a second run.end', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await w.append({ type: 'run.end', actor: 'agenticreplay' });
    await expect(w.append({ type: 'run.end', actor: 'agenticreplay' })).rejects.toThrow(
      /already has a run/,
    );
    await w.close();
  });

  it('leaves no hole in the dense order when it refuses one', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await expect(w.append({ type: 'run.start', actor: 'agenticreplay' })).rejects.toThrow();
    const after = await w.append({ type: 'note', actor: 'agenticreplay' });
    // Spec §2.1: seq is a dense total order. A rejected write must not consume one.
    expect(after.seq).toBe(1);
    await w.close();
  });

  it('still lets a fragment be a fragment', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'model.request', actor: 'model' });
    await w.append({ type: 'note', actor: 'agenticreplay' });
    const events = await lines(w);
    expect(events.map((e) => e.type)).toEqual(['model.request', 'note']);
    await w.close();
  });
});

describe('TraceWriter.append', () => {
  it('assigns a dense sequence from zero', async () => {
    const w = await TraceWriter.create(runs, INIT);
    for (let i = 0; i < 5; i++) await w.append({ type: 'note', actor: 'agenticreplay' });
    expect((await lines(w)).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(w.seq).toBe(5);
    await w.close();
  });

  it('stamps a wall clock and a monotonic clock', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const first = await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await new Promise((r) => setTimeout(r, 8));
    const second = await w.append({ type: 'note', actor: 'agenticreplay' });
    expect(Date.parse(first.ts)).not.toBeNaN();
    expect(first.mono_us).toBeGreaterThanOrEqual(0);
    expect(second.mono_us).toBeGreaterThan(first.mono_us);
    expect(Number.isInteger(second.mono_us)).toBe(true);
    await w.close();
  });

  it('writes exactly one newline-terminated line per event', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay' });
    await w.append({ type: 'note', actor: 'agenticreplay' });
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
    await w.close();
  });

  it('carries turn, causes and attrs through', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'model.request', actor: 'gateway', turn: 3, attrs: { model: 'opus' } });
    const e = await w.append({ type: 'model.response', actor: 'model', turn: 3, causes: [0] });
    expect(e.causes).toEqual([0]);
    const written = await lines(w);
    expect(written[0]?.attrs).toEqual({ model: 'opus' });
    expect(written[0]?.turn).toBe(3);
    await w.close();
  });

  it('defaults the turn to the last one used', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay' });
    await w.append({ type: 'note', actor: 'agenticreplay', turn: 2 });
    const e = await w.append({ type: 'note', actor: 'agenticreplay' });
    expect(e.turn).toBe(2);
    expect((await lines(w)).map((x) => x.turn)).toEqual([0, 2, 2]);
    await w.close();
  });

  it('validates before writing — an invalid event never reaches disk', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay' });
    await expect(
      w.append({ type: 'model.telepathy' as 'note', actor: 'agenticreplay' }),
    ).rejects.toThrow(/invalid trace event/);
    await expect(w.append({ type: 'note', actor: 'wizard' as 'agenticreplay' })).rejects.toThrow(
      /invalid trace event/,
    );
    expect(await lines(w)).toHaveLength(1);
    await w.close();
  });

  it('keeps a small payload inline', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({ type: 'note', actor: 'agenticreplay', payload: { hello: 'world' } });
    expect(e.payload).toEqual({ hello: 'world' });
    expect(await new BlobStore(join(w.runDir, 'blobs')).count()).toBe(0);
    await w.close();
  });

  it('spills an oversized payload to a blob (spec §2.2)', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const big = { text: 'x'.repeat(INLINE_PAYLOAD_LIMIT + 1) };
    const e = await w.append({ type: 'model.request', actor: 'gateway', payload: big });
    const ref = e.payload as BlobRef;
    expect(ref.$blob).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.media_type).toBe('application/json');
    const store = new BlobStore(join(w.runDir, 'blobs'));
    expect(JSON.parse(Buffer.from(await store.get(ref)).toString('utf8'))).toEqual(big);
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw.length).toBeLessThan(INLINE_PAYLOAD_LIMIT);
    await w.close();
  });

  it('never publishes a blob for an oversized or invalid event', async () => {
    const w = await TraceWriter.create(runs, { ...INIT, storageLimits: { eventBytes: 1024 } });
    const store = new BlobStore(join(w.runDir, 'blobs'));
    const payload = { body: 'request text '.repeat(1000) };
    const overflow = await w.append({
      type: 'model.request',
      actor: 'gateway',
      attrs: { large: 'ordinary text '.repeat(100) },
      payload,
    });
    expect(overflow.payload).toBeUndefined();
    expect(overflow.attrs?.payload_omitted).toBe('event_storage_limit');
    expect(await store.count()).toBe(0);
    await expect(w.append({ type: 'bad' as 'note', actor: 'gateway', payload })).rejects.toThrow();
    expect(await store.count()).toBe(0);
    await w.close();
  });

  it('stores one blob for a payload resent across turns', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const big = { conversation: 'y'.repeat(INLINE_PAYLOAD_LIMIT + 1) };
    const a = await w.append({ type: 'model.request', actor: 'gateway', turn: 0, payload: big });
    const b = await w.append({ type: 'model.request', actor: 'gateway', turn: 1, payload: big });
    expect((a.payload as BlobRef).$blob).toBe((b.payload as BlobRef).$blob);
    const m = await w.close();
    expect(m.counts?.blobs).toBe(1);
    expect(m.integrity?.blob_count).toBe(1);
  });

  it('shares the history of growing requests and restores the exact JSON bytes', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const history = Array.from({ length: 16000 }, (_, index) =>
      createHash('sha256').update(String(index)).digest('hex').slice(0, 12),
    ).join(' ');
    const requests = [];
    for (let turn = 0; turn < 8; turn++) {
      const body = JSON.stringify({
        messages: [history, ...Array(turn).fill('new message')],
        stream: true,
      });
      const net = await w.append({ type: 'net.request', actor: 'gateway', payload: body });
      const model = await w.append({ type: 'model.request', actor: 'gateway', payload: body });
      expect(net.payload).toEqual(model.payload);
      requests.push({ ref: net.payload as BlobRef, body });
    }
    await w.close();
    const store = new BlobStore(join(w.runDir, 'blobs'));
    const files = await readdir(store.dir, { recursive: true });
    const deltas = files.filter((name) => name.endsWith('.delta'));
    expect(deltas).toHaveLength(7);
    const sizes = await Promise.all(deltas.map((name) => stat(join(store.dir, name))));
    expect(sizes.reduce((sum, info) => sum + info.size, 0)).toBeLessThan(2048);
    for (const { ref, body } of requests) {
      expect(Buffer.from(await store.get(ref)).toString()).toBe(JSON.stringify(body));
    }
  });

  it('refuses to append after close', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.close();
    await expect(w.append({ type: 'note', actor: 'agenticreplay' })).rejects.toThrow(/closed/i);
  });

  it('keeps concurrent appends dense and unmangled', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        w.append({ type: 'note', actor: 'agenticreplay', attrs: { i } }),
      ),
    );
    const written = await lines(w);
    expect(written.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(new Set(written.map((e) => e.attrs?.['i'])).size).toBe(40);
    await w.close();
  });
});

describe('redaction is on the write path', () => {
  it('never writes a secret found in a payload', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'model.request',
      actor: 'gateway',
      payload: { headers: { authorization: 'Bearer sk-abcdefghijklmnop0123456789' } },
    });
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-abcdefghijklmnop');
    expect(raw).toMatch(/<secret:sk_api_key:[0-9a-f]{8}>/);
    expect(JSON.stringify(e)).not.toContain('sk-abcdefghijklmnop');
    await w.close();
  });

  it('never writes a secret found in attrs', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({
      type: 'shell.exec',
      actor: 'tool',
      attrs: { cmd: 'curl -H "x: AKIAIOSFODNN7EXAMPLE"' },
    });
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
    await w.close();
  });

  it('never writes a secret into a spilled blob either', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'model.request',
      actor: 'gateway',
      payload: { pad: 'z'.repeat(INLINE_PAYLOAD_LIMIT), key: 'sk-abcdefghijklmnop0123456789' },
    });
    const store = new BlobStore(join(w.runDir, 'blobs'));
    const body = Buffer.from(await store.get(e.payload as BlobRef)).toString('utf8');
    expect(body).not.toContain('sk-abcdefghijklmnop');
    expect(body).toMatch(/<secret:sk_api_key:[0-9a-f]{8}>/);
    await w.close();
  });

  it('lists identifiers of what it removed, never the material', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'note',
      actor: 'agenticreplay',
      payload: { key: 'sk-abcdefghijklmnop0123456789' },
    });
    expect(e.redacted?.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.redacted)).not.toContain('abcdefghij');
    await w.close();
  });

  it('leaves clean events without a redacted field', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'note',
      actor: 'agenticreplay',
      payload: { ok: 'nothing secret' },
    });
    expect(e.redacted).toBeUndefined();
    await w.close();
  });

  it('gives one secret one placeholder across the whole run', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const a = await w.append({
      type: 'note',
      actor: 'agenticreplay',
      payload: 'sk-abcdefghijklmnop0123',
    });
    const b = await w.append({
      type: 'note',
      actor: 'agenticreplay',
      payload: 'sk-abcdefghijklmnop0123',
    });
    expect(a.payload).toBe(b.payload);
    await w.close();
  });
});

describe('TraceWriter.close', () => {
  it('seals the manifest with counts, integrity and exit code', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'run.start', actor: 'agenticreplay' });
    await w.append({ type: 'run.end', actor: 'agenticreplay' });
    const m = await w.close(3);
    expect(validateManifest(m).errors).toEqual([]);
    expect(m.ended_at).toBeTruthy();
    expect(m.exit_code).toBe(3);
    expect(m.counts).toEqual({ events: 2, blobs: 0 });
    expect(m.integrity?.blob_count).toBe(0);
    // Against the constant, not a literal. What this seals is that a sealed manifest *carries* the
    // schema version — pinning the number here only means the next MINOR bump fails a test that was
    // never about the number.
    expect(m.schema_version).toBe(SCHEMA_VERSION);
    expect(m.platform?.node).toBe(process.version);
  });

  it('records the sha256 of events.jsonl exactly (spec §6)', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay', payload: { a: 1 } });
    const m = await w.close();
    const raw = await readFile(join(w.runDir, 'events.jsonl'));
    expect(m.integrity?.events_sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('persists the manifest it returns', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const m = await w.close(0);
    const onDisk = JSON.parse(await readFile(join(w.runDir, 'manifest.json'), 'utf8')) as Manifest;
    expect(onDisk).toEqual(m);
  });

  it('writes redactions.json by rule and identifier, never by value', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({
      type: 'note',
      actor: 'agenticreplay',
      payload: { k: 'sk-abcdefghijklmnop0123' },
    });
    const m = await w.close();
    const raw = await readFile(join(w.runDir, 'redactions.json'), 'utf8');
    expect(raw).not.toContain('abcdefghij');
    const file = JSON.parse(raw) as { policy_version: number; records: { rule: string }[] };
    expect(file.policy_version).toBeGreaterThanOrEqual(1);
    expect(file.records.map((r) => r.rule)).toContain('sk_api_key');
    expect(m.redaction?.rules_fired?.['sk_api_key']).toBe(1);
  });

  it('is idempotent', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay' });
    const first = await w.close(0);
    expect(await w.close(0)).toEqual(first);
  });

  // POSIX only. Windows has no mode bits: `chmod 0o600` is a no-op on NTFS and `stat` answers
  // 0o666 whatever was asked for, so this asserts something the platform cannot provide. Skipped
  // rather than loosened — the guarantee is real where it can be made, and a test that accepted
  // 0o666 would stop noticing if it were lost on Linux too.
  it.skipIf(process.platform === 'win32')('keeps every file it writes owner-only', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'agenticreplay' });
    await w.close();
    for (const f of ['events.jsonl', 'manifest.json', 'redactions.json']) {
      const s = await stat(join(w.runDir, f));
      expect(s.mode & 0o777, f).toBe(0o600);
    }
  });
});

describe('storage budgets, rotation and diagnostic reserve', () => {
  it('rotates at the 64 MiB file target instead of truncating the run', async () => {
    const writer = await TraceWriter.create(runs, INIT);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    const detail = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 70; i++) {
      const event = await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        attrs: { detail },
      });
      expect(event.attrs?.detail).toBe(detail);
    }
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    // Rotation is a layout decision, not a capture failure: crossing the file target must not make
    // the run incomplete on its own.
    expect(manifest.capture?.issues ?? []).not.toContain('event_storage_limit');
    expect(writer.hasEnded).toBe(true);
    const segments = manifest.integrity?.segments ?? [];
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]?.name).toBe('events.jsonl');
    expect(segments[1]?.name).toBe('events.000002.jsonl');
    for (const segment of segments) {
      expect((await stat(join(writer.runDir, segment.name))).size).toBeLessThanOrEqual(
        64 * 1024 * 1024,
      );
    }
    // Every event, in order, across the files — with no gap and no repeat at the boundary.
    const events = await lines(writer);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.filter((e) => e.attrs?.detail === detail)).toHaveLength(70);
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('leaves a run that never rotates as a single events.jsonl with no segment list', async () => {
    const writer = await TraceWriter.create(runs, { ...INIT, storageLimits: { eventBytes: 4096 } });
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    expect(manifest.integrity?.segments).toBeUndefined();
    expect(await readdir(writer.runDir)).toContain('events.jsonl');
    expect((await readdir(writer.runDir)).filter((name) => name.startsWith('events.'))).toEqual([
      'events.jsonl',
    ]);
  });

  it('stops at a run-wide budget with a reason instead of rotating forever', async () => {
    const writer = await TraceWriter.create(runs, {
      ...INIT,
      storageLimits: { eventBytes: 2048, runEventBytes: 4096 },
    });
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    const detail = 'y'.repeat(1200);
    const written: (string | undefined)[] = [];
    for (let i = 0; i < 8; i++) {
      const event = await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        attrs: { detail },
      });
      written.push(event.attrs?.detail as string | undefined);
    }
    // The budget bounds what is stored, not whether the session is recorded: the events that did
    // not fit still exist, with the payload replaced by the reason it was dropped.
    expect(written.filter((value) => value === detail).length).toBeGreaterThan(0);
    expect(written).toContain(undefined);
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    expect(manifest.capture?.status).toBe('incomplete');
    // The issue names the budget that actually ran out, so a reader is not sent to look for a
    // per-file limit that was never reached.
    expect(manifest.capture?.issues).toContain('run_event_limit');
    const events = await lines(writer);
    expect(
      events.filter((e) => e.attrs?.payload_omitted === 'run_event_limit').length,
    ).toBeGreaterThan(0);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('retains events beyond 16 MiB by default, including after recovery', async () => {
    let writer = await TraceWriter.create(runs, INIT);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    const detail = 'ordinary recording detail '.repeat(44000);
    for (let i = 0; i < 17; i++) {
      await writer.append({ type: 'note', actor: 'agenticreplay', attrs: { detail } });
    }
    expect((await stat(join(writer.runDir, 'events.jsonl'))).size).toBeGreaterThan(
      16 * 1024 * 1024,
    );
    await writer.suspend();
    writer = await TraceWriter.resume(await realpath(writer.runDir), writer.runId);
    for (let i = 0; i < 40; i++) {
      const event = await writer.append({
        type: 'net.response',
        actor: 'agenticreplay',
        payload: `response ${i}`,
      });
      expect(event.payload).toBe(`response ${i}`);
    }
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    expect(manifest.capture?.issues).not.toContain('event_storage_limit');
    expect(manifest.capture?.issues).not.toContain('diagnostic_storage_limit');
    const events = await lines(writer);
    expect(events.slice(1, 18).every((e) => e.attrs?.detail === detail)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('omits a blob over the physical budget but preserves its event and completion', async () => {
    const writer = await TraceWriter.create(runs, { ...INIT, storageLimits: { blobBytes: 0 } });
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    const event = await writer.append({
      type: 'net.response',
      actor: 'agenticreplay',
      payload: 'hello '.repeat(2000),
    });
    expect(event.payload).toBeUndefined();
    expect(event.attrs?.payload_omitted).toBe('blob_storage_limit');
    await writer.append({
      type: 'error',
      actor: 'agenticreplay',
      attrs: { message: 'upstream failed' },
    });
    await writer.append({ type: 'run.end', actor: 'agenticreplay', attrs: { exit_code: 1 } });
    const manifest = await writer.close(1);
    expect(manifest.capture?.status).toBe('incomplete');
    expect(manifest.capture?.issues).toContain('blob_storage_limit');
    expect(manifest.counts?.blobs).toBe(0);
    expect((await lines(writer)).at(-1)?.attrs?.exit_code).toBe(1);
  });

  it('reserves termination space even after diagnostics fill, with dense event sequences', async () => {
    const writer = await TraceWriter.create(runs, { ...INIT, storageLimits: { eventBytes: 0 } });
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    let rejected = false;
    for (let i = 0; i < 600; i++) {
      try {
        await writer.append({
          type: 'error',
          actor: 'agenticreplay',
          attrs: { message: 'failure '.repeat(1000) },
        });
      } catch (error) {
        expect(String(error)).toContain('diagnostic storage limit');
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    await writer.append({
      type: 'run.end',
      actor: 'agenticreplay',
      attrs: { reason: 'provider failed', exit_code: 2 },
    });
    await writer.close(2);
    const events = await lines(writer);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.attrs?.reason).toBe('provider failed');
    expect((await stat(join(writer.runDir, 'events.jsonl'))).size).toBeLessThanOrEqual(64 * 1024);
  });
});

it('does not let ordinary overflow events consume the error reserve', async () => {
  const writer = await TraceWriter.create(runs, { ...INIT, storageLimits: { eventBytes: 0 } });
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  let rejected = false;
  for (let i = 0; i < 100; i++) {
    try {
      await writer.append({ type: 'note', actor: 'agenticreplay' });
    } catch {
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
  const error = await writer.append({
    type: 'error',
    actor: 'agenticreplay',
    attrs: { message: 'original upstream failure' },
  });
  expect(error.attrs?.message).toBe('original upstream failure');
  // Even control characters cannot make the bounded terminal record exceed its reserve.
  await writer.append({
    type: 'run.end',
    actor: 'agenticreplay',
    attrs: { reason: '\u0000'.repeat(10000), exit_code: 1 },
  });
  await writer.close(1);
  expect((await lines(writer)).at(-1)?.type).toBe('run.end');
});

describe('rotation across event files (spec §2.4)', () => {
  const ROTATING = { ...INIT, storageLimits: { eventBytes: 900, runEventBytes: 64 * 1024 } };

  /** The 1-based index a segment file name denotes. */
  function segmentOf(name: string): number {
    const match = /^events\.(\d{6})\.jsonl$/.exec(name);
    return match ? Number(match[1]) : 1;
  }

  /** Each segment as a list of parsed events, keyed by file name, in `seq` order. */
  async function segmentsOf(w: TraceWriter): Promise<{ name: string; events: TraceEvent[] }[]> {
    const reader = await TraceReader.open(w.runDir);
    const names = (await reader.manifest().integrity?.segments)?.map((s) => s.name) ?? [
      'events.jsonl',
    ];
    const out: { name: string; events: TraceEvent[] }[] = [];
    for (const name of names) {
      const raw = await readFile(join(w.runDir, name), 'utf8');
      out.push({
        name,
        events: raw
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as TraceEvent),
      });
    }
    return out;
  }

  it('rotates at least three times and reads every event back in order', async () => {
    const writer = await TraceWriter.create(runs, ROTATING);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    const payloads: string[] = [];
    for (let i = 0; i < 30; i++) {
      payloads.push(`body ${i} ${'z'.repeat(120)}`);
      await writer.append({
        type: 'tool.result',
        actor: 'tool',
        attrs: { index: i },
        payload: payloads.at(-1),
      });
    }
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);

    const files = await segmentsOf(writer);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files[0]?.name).toBe('events.jsonl');
    expect(files[1]?.name).toBe('events.000002.jsonl');
    expect(files[3]?.name).toBe('events.000004.jsonl');
    // Each file is valid JSONL on its own, and none exceeds the target.
    for (const file of files) {
      expect(file.events.length).toBeGreaterThan(0);
      expect((await stat(join(writer.runDir, file.name))).size).toBeLessThanOrEqual(900);
    }
    // Dense seq across the boundaries: no repeat, no gap, and the payloads survive.
    const all = (await lines(writer)).filter((e) => e.type === 'tool.result');
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.every((e) => typeof e.payload === 'string')).toBe(true);
    expect(manifest.capture?.issues ?? []).toEqual([]);
    // Every recorded range matches what the file actually holds.
    for (const segment of manifest.integrity?.segments ?? []) {
      const file = files.find((candidate) => candidate.name === segment.name)!;
      expect(segment.first_seq).toBe(file.events[0]?.seq);
      expect(segment.last_seq).toBe(file.events.at(-1)?.seq);
    }
    expect(await (await TraceReader.open(writer.runDir)).verifyIntegrity()).toMatchObject({
      ok: true,
      state: 'verified',
    });
  });

  it('rotates exactly when the next event would no longer fit, never splitting one', async () => {
    const writer = await TraceWriter.create(runs, ROTATING);
    try {
      await writer.append({ type: 'run.start', actor: 'agenticreplay' });
      for (let i = 0; i < 24; i++) {
        await writer.append({
          type: 'note',
          actor: 'agenticreplay',
          attrs: { i, pad: 'p'.repeat(200) },
        });
      }
      await writer.append({ type: 'run.end', actor: 'agenticreplay' });
      await writer.close(0);
      const files = await segmentsOf(writer);
      expect(files.length).toBeGreaterThan(2);
      for (const [position, file] of files.entries()) {
        const size = (await stat(join(writer.runDir, file.name))).size;
        // The boundary rule, stated as a property rather than as a byte count: the file that closed
        // did not exceed the target, and the event that opened the next one would have.
        expect(size).toBeLessThanOrEqual(900);
        const next = files[position + 1];
        if (next !== undefined) {
          const nextLine = Buffer.byteLength(`${JSON.stringify(next.events[0])}\n`);
          expect(size + nextLine).toBeGreaterThan(900);
        }
      }
      // No line is split: every file parses on its own, and the boundary falls between events.
      for (const file of files) {
        for (const event of file.events) expect(typeof event.seq).toBe('number');
      }
      expect((await lines(writer)).map((e) => e.seq)).toEqual(
        (await lines(writer)).map((_, i) => i),
      );
    } finally {
      if (!writer.hasEnded) await writer.close().catch(() => undefined);
    }
  });

  it('stops rotating once the run budget is reached, keeping the trace readable', async () => {
    const writer = await TraceWriter.create(runs, {
      ...INIT,
      storageLimits: { eventBytes: 900, runEventBytes: 2000 },
    });
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    const big = 'b'.repeat(600);
    for (let i = 0; i < 12; i++) {
      await writer.append({ type: 'note', actor: 'agenticreplay', attrs: { big } });
    }
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    expect(manifest.capture?.status).toBe('incomplete');
    expect(manifest.capture?.issues).toContain('run_event_limit');
    // What was recorded is still the whole dense order, and the run is not mistaken for complete.
    const events = await lines(writer);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('stops rather than opening another file past the segment bound', async () => {
    const writer = await TraceWriter.create(runs, {
      ...INIT,
      storageLimits: { eventBytes: 600, runEventBytes: 64 * 1024, eventSegments: 2 },
    });
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    for (let i = 0; i < 12; i++) {
      await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        attrs: { pad: 'x'.repeat(200) },
      });
    }
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    expect(manifest.capture?.issues).toContain('segment_limit');
    expect((await readdir(writer.runDir)).filter((name) => name.startsWith('events.'))).toEqual([
      'events.000002.jsonl',
      'events.jsonl',
    ]);
  });

  it('resumes a rotated run in its last segment without rewriting earlier ones', async () => {
    let writer = await TraceWriter.create(runs, ROTATING);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    for (let i = 0; i < 20; i++) {
      await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        attrs: { i, pad: 'y'.repeat(80) },
      });
    }
    await writer.suspend();
    const all = (await readdir(writer.runDir))
      .filter((name) => /^events(\.\d{6})?\.jsonl$/.test(name))
      // Numeric, not lexicographic: `events.jsonl` sorts after `events.000002.jsonl` as text.
      .sort((a, b) => segmentOf(a) - segmentOf(b));
    // Only files the run has finished can be compared: the live one is the file the resumed
    // writer appends to, which is exactly the file this test expects to change.
    const earlier: Record<string, string> = {};
    for (const name of all.slice(0, -1)) {
      earlier[name] = await readFile(join(writer.runDir, name), 'utf8');
    }
    expect(Object.keys(earlier).length).toBeGreaterThan(0);

    writer = await TraceWriter.resume(await realpath(writer.runDir), writer.runId);
    const resumed = await writer.append({ type: 'note', actor: 'agenticreplay', attrs: { i: 99 } });
    expect(resumed.seq).toBe(21);
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    await writer.close(0);

    // Resuming appends; it never rewrites a file an earlier process finished.
    for (const [name, text] of Object.entries(earlier)) {
      expect(await readFile(join(writer.runDir, name), 'utf8')).toBe(text);
    }
    const events = await lines(writer);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('keeps two concurrent runs in their own directories', async () => {
    const limits = { eventBytes: 700, runEventBytes: 64 * 1024 };
    const a = await TraceWriter.create(runs, { ...ROTATING, storageLimits: limits });
    const b = await TraceWriter.create(runs, { ...ROTATING, storageLimits: limits });
    await Promise.all([
      a.append({ type: 'run.start', actor: 'agenticreplay' }),
      b.append({ type: 'run.start', actor: 'agenticreplay' }),
    ]);
    for (let i = 0; i < 10; i++) {
      await Promise.all([
        a.append({
          type: 'note',
          actor: 'agenticreplay',
          attrs: { run: 'a', i, pad: 'a'.repeat(150) },
        }),
        b.append({
          type: 'note',
          actor: 'agenticreplay',
          attrs: { run: 'b', i, pad: 'b'.repeat(150) },
        }),
      ]);
    }
    await Promise.all([
      a.append({ type: 'run.end', actor: 'agenticreplay' }),
      b.append({ type: 'run.end', actor: 'agenticreplay' }),
    ]);
    await Promise.all([a.close(0), b.close(0)]);
    expect(a.runDir).not.toBe(b.runDir);
    for (const [writer, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const events = await lines(writer);
      expect(events.every((e) => e.attrs?.run === undefined || e.attrs.run === tag)).toBe(true);
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
      expect(
        await (await TraceReader.open(writer.runDir)).verifyIntegrity().then((r) => r.ok),
      ).toBe(true);
    }
  });

  it('keeps the events it recorded when the next file cannot be created, and says why', async () => {
    const writer = await TraceWriter.create(runs, ROTATING);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    // Two short events: still inside the first file, so the next one is `events.000002.jsonl`.
    for (let i = 0; i < 2; i++) {
      await writer.append({ type: 'note', actor: 'agenticreplay', attrs: { pad: 'w'.repeat(10) } });
    }
    expect((await readdir(writer.runDir)).filter((n) => /^events\.\d{6}\.jsonl$/.test(n))).toEqual(
      [],
    );
    // Occupy the next segment name with a directory, so creating the file fails in a way no retry
    // improves — the same shape as a full disk or a read-only mount, without needing either.
    await mkdir(join(writer.runDir, 'events.000002.jsonl'));
    const started = Date.now();
    for (let i = 0; i < 12; i++) {
      await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        attrs: { pad: 'v'.repeat(150) },
      });
    }
    // One failed create is a diagnostic; one per event is a stalled session.
    expect(Date.now() - started).toBeLessThan(2000);
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    const manifest = await writer.close(0);
    expect(manifest.capture?.status).toBe('incomplete');
    expect(manifest.capture?.issues).toContain('event_segment_conflict');
    // The reason stays the reason: it is not replaced by a bound nobody reached on the next event.
    expect(manifest.capture?.issues).not.toContain('segment_limit');
    expect(manifest.capture?.issues).not.toContain('run_event_limit');
    // What was already written is still readable and dense, including the terminal event.
    const events = await lines(writer);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('reports a run whose segment list names a file that is gone', async () => {
    const writer = await TraceWriter.create(runs, ROTATING);
    await writer.append({ type: 'run.start', actor: 'agenticreplay' });
    for (let i = 0; i < 20; i++) {
      await writer.append({ type: 'note', actor: 'agenticreplay', attrs: { pad: 'q'.repeat(80) } });
    }
    await writer.append({ type: 'run.end', actor: 'agenticreplay' });
    await writer.close(0);
    const names = (await readdir(writer.runDir))
      .filter((name) => /^events(\.\d{6})?\.jsonl$/.test(name))
      .sort();
    expect(names.length).toBeGreaterThan(2);
    await rm(join(writer.runDir, names[1]!));

    const reader = await TraceReader.open(writer.runDir);
    const events = await reader.events();
    expect(events.length).toBeGreaterThan(0);
    expect(reader.problems().some((problem) => problem.reason.includes(`missing`))).toBe(true);
    // A partial log must not verify: the digest it would produce covers a prefix.
    const integrity = await reader.verifyIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.state).toBe('mismatch');
  });
});

it('keeps only the tool key and causal edge when a tool event exceeds the file target', async () => {
  const writer = await TraceWriter.create(runs, {
    ...INIT,
    storageLimits: { eventBytes: 512, runEventBytes: 8192 },
  });
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  for (const type of ['tool.call', 'tool.result'] as const) {
    await writer.append({
      type,
      actor: 'harness',
      causes: [writer.seq - 1],
      attrs: { tool_use_id: 'call_1', message: 'private detail', input: 'body'.repeat(1000) },
      payload: 'private detail',
    });
  }
  await writer.append({ type: 'run.end', actor: 'agenticreplay' });
  const manifest = await writer.close();
  const segments = manifest.integrity!.segments!;
  const callFile = segments.findIndex((segment) => segment.last_seq === 1);
  expect(callFile).toBeGreaterThanOrEqual(0);
  expect(segments[callFile + 1]?.first_seq).toBe(2);
  for (const event of (await lines(writer)).slice(1, 3)) {
    expect(event.attrs).toEqual({ tool_use_id: 'call_1', payload_omitted: 'event_storage_limit' });
    expect(event.causes).toEqual([event.seq - 1]);
    expect(event.payload).toBeUndefined();
  }
});

it('rejects unsafe tool identities after redaction and keeps run.end writable after tool storage fills', async () => {
  const writer = await TraceWriter.create(runs, { ...INIT, storageLimits: { eventBytes: 0 } });
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  for (const id of ['line\nbreak', 'a'.repeat(257), 'sk-' + 'x'.repeat(28)]) {
    const e = await writer.append({
      type: 'tool.call',
      actor: 'model',
      attrs: { tool_use_id: id, input: 'private body' },
    });
    expect(e.attrs?.tool_use_id).toBeUndefined();
  }
  let rejected = false;
  for (let i = 0; i < 100; i++) {
    try {
      await writer.append({
        type: 'tool.call',
        actor: 'model',
        attrs: { tool_use_id: 'valid_' + i },
      });
    } catch (error) {
      expect(String(error)).toContain('diagnostic storage limit');
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
  await writer.append({ type: 'run.end', actor: 'agenticreplay', attrs: { exit_code: 0 } });
  const manifest = await writer.close(0);
  expect(manifest.capture?.status).toBe('incomplete');
  expect(manifest.capture?.issues).toEqual(
    expect.arrayContaining(['invalid_tool_use_id', 'diagnostic_storage_limit']),
  );
  const events = await lines(writer);
  expect(events.at(-1)?.type).toBe('run.end');
  expect(JSON.stringify(events)).not.toContain('private body');
  expect(JSON.stringify(events)).not.toContain('sk-' + 'x'.repeat(28));
});

it('records an incomplete capture when the unresolved diagnostic exceeds its reserve', async () => {
  const writer = await TraceWriter.create(runs, {
    ...INIT,
    storageLimits: { eventBytes: 128 * 1024, runEventBytes: 128 * 1024 },
  });
  await writer.append({ type: 'run.start', actor: 'agenticreplay' });
  const calls = [];
  for (let i = 0; i < 340; i++) {
    const id = 'a'.repeat(247) + i;
    const call = await writer.append({
      type: 'tool.call',
      actor: 'model',
      attrs: { tool_use_id: id },
    });
    calls.push({ seq: call.seq, tool_use_id: id });
  }
  await expect(
    writer.append({
      type: 'note',
      actor: 'agenticreplay',
      attrs: { rule: 'unresolved_tool_calls', calls },
    }),
  ).rejects.toThrow('diagnostic storage limit');
  await writer.append({ type: 'run.end', actor: 'agenticreplay' });
  const manifest = await writer.close();
  expect(manifest.capture?.issues).toContain('diagnostic_storage_limit');
  expect((await lines(writer)).at(-1)?.type).toBe('run.end');
});
