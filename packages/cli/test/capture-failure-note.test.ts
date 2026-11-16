import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { TraceReader, TraceWriter } from '@agenticreplay/core';
import { expect, it } from 'vitest';
import { responseCapture } from '../../proxy/src/codex-websocket.js';
import { noteTurnCaptureFailure } from '../src/capture-failure-note.js';

it('saves 15 cumulative notes, keeps the first suppressed failure of a later turn, and ignores summary-only turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-failure-note-'));
  try {
    async function makeTurn() {
      const writer = await TraceWriter.create(root, {
        adapter: { id: 'codex-desktop-api' },
        cwd: root,
        argv: [],
        agenticreplayVersion: 'test',
      });
      await writer.append({ type: 'run.start', actor: 'agenticreplay' });
      return {
        writer,
        connections: new Set<string>(),
        captureFailureGroups: new Set<string>(),
        broken: false,
        writes: Promise.resolve(),
      };
    }

    const first = await makeTurn();
    const later = await makeTurn();
    const unrelated = await makeTurn();
    const turns = [first, later, unrelated];
    const error = Object.assign(new Error('private fixture message'), { code: 'EIO' });
    const capture = responseCapture({ headers: {}, url: '/responses' } as IncomingMessage, {
      target: { host: 'fixture.invalid', port: 443 },
      ca: undefined,
      maxCaptured: 4096,
      budget: { reserve: (n) => n, release() {} },
      secretHeaders: new Set(),
      capture: true,
      callbacks: {
        async onWebSocketObservation(event) {
          if (event.kind === 'open') first.connections.add(event.connectionId);
          throw error;
        },
        onFailure(failure) {
          noteTurnCaptureFailure(turns, failure, (turn, write) => {
            turn.writes = turn.writes.then(() => write(turn.writer));
          });
          if (failure.captureDiagnostic?.count === 2) later.connections.add(failure.connectionId!);
          if (failure.captureDiagnostic?.count === 14_787)
            unrelated.connections.add(failure.connectionId!);
        },
      },
    });
    const message = Buffer.from('{"type":"codex.rate_limits"}');
    for (let n = 0; n < 14_785; n++) {
      capture.response(message, false);
      if (n % 200 === 0) await tick();
    }
    capture.close();
    await capture.drained;

    expect(turns.map((turn) => turn.broken)).toEqual([true, true, false]);
    const readers = await Promise.all(
      turns.map(async (turn) => {
        await turn.writes;
        await turn.writer.append({ type: 'run.end', actor: 'agenticreplay' });
        await turn.writer.close();
        return TraceReader.open(turn.writer.runDir);
      }),
    );
    const notes = await Promise.all(
      readers.map(async (reader) =>
        (await reader.events()).filter((event) => event.type === 'note'),
      ),
    );
    expect(notes[0]).toHaveLength(15);
    expect(notes[0]?.at(-1)?.attrs).toMatchObject({
      code: 'save_failed',
      errorCode: 'EIO',
      count: 14_787,
      summary: 'final',
    });
    expect(notes[1]?.[0]?.attrs).toMatchObject({ code: 'save_failed', count: 3, emit: false });
    expect(notes[2]).toHaveLength(0);
    expect(JSON.stringify(notes)).not.toContain('private fixture message');
    for (const reader of readers.slice(0, 2))
      expect(reader.manifest().capture).toMatchObject({
        status: 'incomplete',
        issues: ['save_failed'],
      });
    expect(readers[2]?.manifest().capture?.status).not.toBe('incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
