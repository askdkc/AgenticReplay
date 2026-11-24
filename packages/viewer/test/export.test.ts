import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportTraceHtml } from '../src/export.js';
import { ev, manifest, resetSeq, tempRunDir, writeRun } from './fixtures.js';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(label: string, run: Parameters<typeof writeRun>[1]): Promise<string> {
  const dir = await tempRunDir(label);
  scratch.push(dir);
  await writeRun(dir, run);
  return dir;
}

describe('exportTraceHtml', () => {
  it.each([
    ['queue_limit', 'Recording queue limit reached', 'incomplete', 'unverified'],
    ['index_persistence_failed', 'Could not save the recording index', 'incomplete', 'complete'],
    ['trace_limit', 'Trace size limit reached', 'failed', 'unverified'],
  ] as const)(
    'exports a safe DSH capture diagnostic for %s',
    async (code, reason, state, status) => {
      const dir = await fixture(code, {
        manifest: manifest({
          adapter: { id: 'kiokuko-dsh' },
          capture: { status, issues: ['manifest_issue'] },
        }),
        events: [ev({ type: 'note', attrs: { text: 'timeline remains readable' } })],
      });
      const diagnostic = JSON.stringify({
        format: 'dsh.capture-status.v1',
        httpCapture: false,
        runId: 'run_abc123',
        state,
        lastErrorCode: code,
        missingEvents: 2,
        unresolvedCalls: 1,
        failure: {
          phase: 'PRIVATE-PHASE',
          eventType: 'PRIVATE-TYPE',
          callId: 'PRIVATE-CALL',
          code,
        },
      });
      const diagnosticPath = join(dir, 'capture-status.json');
      const manifestPath = join(dir, 'manifest.json');
      const originalManifest = await readFile(manifestPath, 'utf8');
      await writeFile(diagnosticPath, diagnostic);
      const written = await readFile(
        (await exportTraceHtml(dir, join(dir, 'out.html'))).path,
        'utf8',
      );
      expect(written).toContain('<dd class="flag">incomplete</dd>');
      expect(written).toContain(`DSH recording ${state}`);
      expect(written).toContain(reason);
      expect(written).toContain(code);
      expect(written).toContain('Missing events: 2');
      expect(written).toContain('Unresolved calls: 1');
      expect(written).toContain('manifest_issue');
      expect(written).toContain('timeline remains readable');
      expect(written).not.toContain('PRIVATE-');
      expect(await readFile(manifestPath, 'utf8')).toBe(originalManifest);
      expect(await readFile(diagnosticPath, 'utf8')).toBe(diagnostic);
    },
  );

  it('ignores unbound, unreadable, or oversized DSH diagnostics', async () => {
    const dir = await fixture('unsafe-diagnostic', {
      manifest: manifest({ adapter: { id: 'kiokuko-dsh' } }),
    });
    const path = join(dir, 'capture-status.json');
    const out = join(dir, 'out.html');
    const valid = {
      format: 'dsh.capture-status.v1',
      httpCapture: false,
      runId: 'run_abc123',
      state: 'failed',
      lastErrorCode: 'queue_limit',
    };
    for (const body of [
      JSON.stringify({ ...valid, runId: 'run_def456' }),
      JSON.stringify({ ...valid, state: 'completed' }),
      JSON.stringify({ ...valid, format: 'unknown' }),
      '{"format":',
      JSON.stringify({ ...valid, extra: 'x'.repeat(8_193) }),
    ]) {
      await writeFile(path, body);
      await exportTraceHtml(dir, out);
      expect(await readFile(out, 'utf8')).not.toContain('DSH recording');
    }
    await rm(path);
    const other = join(dir, 'other.json');
    await writeFile(other, JSON.stringify(valid));
    await symlink(other, path);
    await exportTraceHtml(dir, out);
    expect(await readFile(out, 'utf8')).not.toContain('DSH recording');
  });

  it('reports a failure without copying unknown codes or free text into the export', async () => {
    const dir = await fixture('unknown-diagnostic', {
      manifest: manifest({ adapter: { id: 'kiokuko-dsh' } }),
    });
    await writeFile(
      join(dir, 'capture-status.json'),
      JSON.stringify({
        format: 'dsh.capture-status.v1',
        httpCapture: false,
        runId: 'run_abc123',
        state: 'failed',
        lastErrorCode: 'PRIVATE_TOKEN',
        missingEvents: -1,
      }),
    );
    const written = await readFile(
      (await exportTraceHtml(dir, join(dir, 'out.html'))).path,
      'utf8',
    );
    expect(written).toContain('DSH recording failed');
    expect(written).toContain('Recording failure reason unavailable');
    expect(written).not.toContain('PRIVATE_TOKEN');
    expect(written).not.toContain('Missing events:');
  });

  it('reads a run directory and writes one self-contained file', async () => {
    resetSeq();
    const dir = await fixture('basic', {
      events: [
        ev({ type: 'run.start', attrs: { adapter: 'claude-code' } }),
        ev({ type: 'shell.exec', attrs: { command: 'npm test' } }),
        ev({ type: 'run.end', attrs: { exit_code: 0 } }),
      ],
    });
    const out = join(dir, 'nested', 'trace.html');
    const result = await exportTraceHtml(dir, out);

    expect(result.path).toBe(out);
    const written = await readFile(out, 'utf8');
    expect(result.bytes).toBe((await stat(out)).size);
    expect(written.startsWith('<!doctype html>')).toBe(true);
    expect(written).toContain('npm test');
    expect(written).toContain('run_abc123');

    const refs = [...written.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
    for (const ref of refs) expect(ref).not.toMatch(/^(?:[a-z]+:)?\/\//i);
  });

  it('inlines the blobs the panes need', async () => {
    resetSeq();
    const dir = await fixture('blobs', {
      events: [
        ev({
          type: 'tool.result',
          payload: { $blob: 'sha256:aabb', bytes: 11, media_type: 'text/plain' },
        }),
      ],
      blobs: { 'sha256:aabb': 'hello blobs' },
    });
    const written = await readFile(
      (await exportTraceHtml(dir, join(dir, 'out.html'))).path,
      'utf8',
    );
    expect(written).toContain('hello blobs');
  });

  it('respects the blob byte cap rather than writing a huge file', async () => {
    resetSeq();
    const dir = await fixture('cap', {
      events: [
        ev({ type: 'tool.result', payload: { $blob: 'sha256:1111', bytes: 2000 } }),
        ev({ type: 'tool.result', payload: { $blob: 'sha256:2222', bytes: 3000 } }),
      ],
      blobs: { 'sha256:1111': 'a'.repeat(2000), 'sha256:2222': 'b'.repeat(3000) },
    });
    const out = join(dir, 'capped.html');
    await exportTraceHtml(dir, out, { maxBlobBytes: 2500 });
    const written = await readFile(out, 'utf8');
    expect(written).toContain('a'.repeat(200));
    expect(written).not.toContain('b'.repeat(200));
    expect(written).toContain('payload omitted, 3000 bytes');
  });

  it('keeps the complete redacted body by default', async () => {
    resetSeq();
    const big = 'c'.repeat(9 * 1024 * 1024);
    const dir = await fixture('bigcap', {
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:3333', bytes: big.length } })],
      blobs: { 'sha256:3333': big },
    });
    const out = join(dir, 'big.html');
    const result = await exportTraceHtml(dir, out);
    expect(result.bytes).toBeGreaterThan(9 * 1024 * 1024);
    expect(await readFile(out, 'utf8')).toContain('download full redacted body');
  });

  it('tolerates a truncated final line, as the spec requires of every reader', async () => {
    resetSeq();
    const dir = await fixture('torn', {
      events: [ev({ type: 'run.start' }), ev({ type: 'note', attrs: { text: 'kept' } })],
    });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'events.jsonl'), '{"seq":2,"ts":"2026-01-01T00');
    const out = join(dir, 'torn.html');
    await exportTraceHtml(dir, out);
    const written = await readFile(out, 'utf8');
    expect(written).toContain('kept');
    expect((written.match(/role="tab"/g) ?? []).length).toBe(2);
  });

  it('skips a binary blob instead of corrupting the document', async () => {
    resetSeq();
    const dir = await fixture('binary', {
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:4444', bytes: 4 } })],
      blobs: { 'sha256:4444': new Uint8Array([0x00, 0x01, 0x02, 0xff]) },
    });
    const out = join(dir, 'bin.html');
    await exportTraceHtml(dir, out);
    expect(await readFile(out, 'utf8')).toContain('payload omitted, 4 bytes');
  });

  it('reports a missing manifest clearly', async () => {
    const dir = await tempRunDir('missing');
    scratch.push(dir);
    await expect(exportTraceHtml(dir, join(dir, 'x.html'))).rejects.toThrow(/manifest\.json/);
  });

  it('handles a run directory with no blobs directory at all', async () => {
    resetSeq();
    const dir = await fixture('noblobs', {
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:5555', bytes: 12 } })],
    });
    const out = join(dir, 'nb.html');
    await expect(exportTraceHtml(dir, out)).resolves.toMatchObject({ path: out });
    expect(await readFile(out, 'utf8')).toContain('payload omitted, 12 bytes');
  });
});

/**
 * The viewer reads a run off disk without depending on @agenticreplay/core, so it has its own copy
 * of the file-walking rule — and this is what holds the two together (spec §1.1).
 */
describe('exporting a rotated run', () => {
  it('includes the events in every segment, in seq order', async () => {
    const dir = await tempRunDir('rotated');
    scratch.push(dir);
    const { writeFile: write, mkdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    await mkdir(dir, { recursive: true });
    const bodies = [
      [ev({ type: 'run.start', seq: 0 })],
      [ev({ type: 'note', seq: 1, attrs: { where: 'second' } })],
      [ev({ type: 'run.end', seq: 2 })],
    ].map((events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const names = ['events.jsonl', 'events.000002.jsonl', 'events.000003.jsonl'];
    await Promise.all(bodies.map((body, i) => write(join(dir, names[i]!), body)));
    const first = 0;
    let offset = 0;
    const segments = names.map((name, i) => {
      const count = bodies[i]!.split('\n').filter(Boolean).length;
      const segment = {
        name,
        first_seq: first + offset,
        last_seq: first + offset + count - 1,
        bytes: Buffer.byteLength(bodies[i]!),
        sha256: createHash('sha256').update(bodies[i]!).digest('hex'),
      };
      offset += count;
      return segment;
    });
    await write(
      join(dir, 'manifest.json'),
      JSON.stringify(
        manifest({
          integrity: {
            events_sha256: createHash('sha256').update(bodies.join('')).digest('hex'),
            blob_count: 0,
            segments,
          },
        }),
      ),
    );

    const out = join(dir, 'out.html');
    await exportTraceHtml(dir, out);
    const html = await readFile(out, 'utf8');
    // The event that only exists past the first file is in the document.
    expect(html).toContain('second');
    expect(html).toContain('events.000003.jsonl'.slice(0, 0) + 'run ended');
  });

  it('records a segment the manifest names and the directory lacks as skipped, not as absence', async () => {
    const dir = await tempRunDir('rotated-missing');
    scratch.push(dir);
    const { writeFile: write } = await import('node:fs/promises');
    const { readTraceDir } = await import('../src/trace-dir.js');
    const body = `${JSON.stringify(ev({ type: 'run.start', seq: 0 }))}\n`;
    await write(join(dir, 'events.jsonl'), body);
    await write(
      join(dir, 'manifest.json'),
      JSON.stringify(
        manifest({
          integrity: {
            events_sha256: 'a'.repeat(64),
            blob_count: 0,
            segments: [
              {
                name: 'events.jsonl',
                first_seq: 0,
                last_seq: 0,
                bytes: body.length,
                sha256: 'b'.repeat(64),
              },
              {
                name: 'events.000002.jsonl',
                first_seq: 1,
                last_seq: 1,
                bytes: 10,
                sha256: 'c'.repeat(64),
              },
            ],
          },
        }),
      ),
    );
    const trace = await readTraceDir(dir);
    // The event that was readable is there, and the file that was not is counted: a viewer that
    // said nothing would be reporting a complete run over a prefix of one.
    expect(trace.events.map((event) => event.type)).toEqual(['run.start']);
    expect(trace.skippedLines).toBeGreaterThan(0);
  });
});
