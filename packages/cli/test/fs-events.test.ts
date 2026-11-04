import { describe, expect, it } from 'vitest';
import type { TraceWriter } from '@agenticreplay/core';
import type { FileChange } from '@agenticreplay/fs-capture';
import { appendSnapshot } from '../src/fs-events.js';
import { Output, type LogEntry } from '../src/out.js';
import type { SnapshotResult } from '../src/snapshot.js';

interface RecordedEvent {
  type: string;
  actor?: string;
  turn: number;
  attrs?: Record<string, unknown>;
}

function writerStub(): { writer: TraceWriter; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const writer = {
    append: async (event: RecordedEvent) => {
      events.push(event);
      return event;
    },
  } as unknown as TraceWriter;
  return { writer, events };
}

function output(): { out: Output; lines: LogEntry[] } {
  const lines: LogEntry[] = [];
  const out = new Output({
    write: () => undefined,
    sink: (entry) => lines.push(entry),
    isTTY: false,
  });
  return { out, lines };
}

function fs(result: SnapshotResult | Error) {
  return {
    snapshotTurn: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe('appendSnapshot', () => {
  // What the harness looks like when it holds exchanges in flight at once: a turn whose window
  // a later turn's sample already covered answers covered-by, never a failure.
  it('records a covered turn as a note, not a capture failure', async () => {
    const { writer, events } = writerStub();
    const { out, lines } = output();
    await appendSnapshot(fs({ changes: [], coveredBy: 2 }) as never, writer, out, 1);
    expect(lines).toEqual([]);
    expect(events).toEqual([
      {
        type: 'note',
        actor: 'agenticreplay',
        turn: 1,
        attrs: { rule: 'fs_capture_out_of_order', covered_by_turn: 2 },
      },
    ]);
  });

  it('keeps warning when the snapshot really failed', async () => {
    const { writer, events } = writerStub();
    const { out, lines } = output();
    await appendSnapshot(fs(new Error('fatal: not a git repository')) as never, writer, out, 2);
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'fs.capture_failed',
        fields: { turn: 2, attempts: 1, error: 'fatal: not a git repository' },
      },
    ]);
    expect(events).toEqual([
      {
        type: 'note',
        actor: 'agenticreplay',
        turn: 2,
        attrs: { rule: 'fs_capture_skipped', attempts: 1, error: 'fatal: not a git repository' },
      },
    ]);
  });

  it('records the changes of an ordinary sample', async () => {
    const { writer, events } = writerStub();
    const { out, lines } = output();
    const changes: FileChange[] = [
      { path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 },
    ];
    await appendSnapshot(fs({ changes }) as never, writer, out, 3);
    expect(lines).toEqual([]);
    expect(events).toEqual([
      {
        type: 'fs.change',
        actor: 'agenticreplay',
        turn: 3,
        attrs: { path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 },
      },
    ]);
  });
});
