import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { TraceEvent } from '@agenticreplay/schema';
import { ExchangeEventDeriver } from '../src/exchange-events.js';
import { openModkhFrames } from '../src/modkh-frames.js';

it('keeps reused provider IDs separate, allows only metadata and reports damaged frames', async () => {
  const frames = await openModkhFrames();
  try {
    const base = {
      session: 'session',
      turn: 0,
      ordinal: 1,
      callId: 'duplicate',
      attempt: randomUUID(),
    };
    const other = { ...base, attempt: randomUUID() };
    const job = { ...base, callId: 'job', ordinal: 2, jobId: 'bash-0123456789abcdef' };
    const lines = [
      { ...job, state: 'accepted', reason: 'job_registered' },
      { ...base, state: 'not-executed', reason: 'response_discarded' },
      {
        ...other,
        state: 'completed',
        reason: 'command_exited',
        output: 'private payload',
        args: ['private payload'],
      },
      {
        ...base,
        attempt: randomUUID(),
        state: 'reused',
        reason: 'saved_result',
        source: { attempt: other.attempt, ordinal: other.ordinal },
      },
      { ...job, state: 'completed', reason: 'command_exited' },
      { ...other, state: 'completed', reason: 'private payload' },
    ].map((row) => JSON.stringify(row));
    await appendFile(frames.path, lines.join('\n') + '\n{"incomplete"');
    const events: TraceEvent[] = [];
    const issues: string[] = [];
    const writer = {
      append: async (input: TraceEvent) => {
        const event = { ...input, seq: events.length };
        events.push(event);
        return event;
      },
      markCaptureIncomplete: (issue: string) => issues.push(issue),
    };
    await frames.drain(writer as never, new ExchangeEventDeriver());
    expect(issues).toEqual(['modkh_frames_partial', 'invalid_modkh_frame']);
    expect(events.map((e) => [e.type, e.attrs?.state, e.causes])).toEqual([
      ['tool.result', 'accepted', undefined],
      ['note', 'not-executed', undefined],
      ['tool.result', 'completed', undefined],
      ['note', 'reused', [2]],
      ['note', 'completed', [0]],
    ]);
    expect(events[1]?.attrs?.attempt).not.toEqual(events[2]?.attrs?.attempt);
    expect(events[2]?.attrs?.correlation).toBe('ambiguous');
    expect(JSON.stringify(events)).not.toContain('private payload');
  } finally {
    await frames.close();
  }
});
