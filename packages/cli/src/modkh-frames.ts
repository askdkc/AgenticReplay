import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPrivatePathIdentity,
  privatePathIdentity,
  removePrivateDirectory,
  restrictToOwner,
  type TraceWriter,
} from '@agenticreplay/core';
import { touchTransports, TRANSPORT_OWNER } from './agent-spans.js';
import type { TraceEvent } from '@agenticreplay/schema';
import type { ExchangeEventDeriver } from './exchange-events.js';

const reasons: Record<string, readonly string[]> = {
  candidate: ['received'],
  'not-executed': [
    'response_discarded',
    'response_interrupted',
    'workflow_stopped',
    'scope_blocked',
    'recovery_blocked',
    'aborted',
    'id_conflict',
    'guard_blocked',
    'uncertain_batch',
    'prior_unknown',
    'approval_denied',
    'preflight_rejected',
  ],
  unknown: ['dispatch_pending', 'command_started', 'command_unconfirmed'],
  completed: ['command_exited', 'tool_returned'],
  failed: ['nonzero_exit', 'tool_error'],
  accepted: ['job_registered'],
  reused: ['saved_result'],
};
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,256}$/u.test(v);
const index = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

function frame(line: string) {
  const obj = JSON.parse(line);
  if (
    !obj ||
    !identifier(obj.session) ||
    !index(obj.turn) ||
    !identifier(obj.attempt) ||
    !uuid.test(obj.attempt) ||
    !index(obj.ordinal) ||
    obj.ordinal < 1 ||
    !identifier(obj.callId) ||
    typeof obj.state !== 'string' ||
    typeof obj.reason !== 'string' ||
    !Object.hasOwn(reasons, obj.state) ||
    !reasons[obj.state]?.includes(obj.reason)
  ) {
    throw new Error('invalid frame');
  }
  const attrs = {
    session: obj.session,
    turn: obj.turn,
    attempt: obj.attempt,
    ordinal: obj.ordinal,
    tool_use_id: obj.callId,
    state: String(obj.state),
    reason: String(obj.reason),
    ...(typeof obj.jobId === 'string' && /^bash-[0-9a-f]{16}$/u.test(obj.jobId)
      ? { job_id: obj.jobId as string }
      : {}),
    ...(index(obj.receipt?.message) && index(obj.receipt?.result)
      ? {
          receipt_message: obj.receipt.message as number,
          receipt_result: obj.receipt.result as number,
        }
      : {}),
    ...(identifier(obj.source?.attempt) &&
    uuid.test(obj.source.attempt) &&
    index(obj.source?.ordinal)
      ? {
          source_attempt: obj.source.attempt as string,
          source_ordinal: obj.source.ordinal as number,
        }
      : {}),
    ...(index(obj.source?.message) && index(obj.source?.result)
      ? { source_message: obj.source.message as number, source_result: obj.source.result as number }
      : {}),
  };
  return attrs;
}

/** Retain the original descriptor. Never reopen a child-controlled path during collection. */
export async function openModkhFrames() {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-modkh-'));
  const path = join(dir, 'frames.jsonl');
  const identity = await privatePathIdentity(dir);
  const file = await (async () => {
    try {
      if (process.platform === 'win32') await restrictToOwner(dir, 0o700);
      await assertPrivatePathIdentity(dir, identity);
      await writeFile(join(dir, TRANSPORT_OWNER), String(process.pid), { mode: 0o600, flag: 'wx' });
      await assertPrivatePathIdentity(dir, identity);
      return await open(path, 'wx+', 0o600);
    } catch (error) {
      await removePrivateDirectory(dir, identity);
      throw error;
    }
  })();
  const wire = new Map<string, { calls: number; callTurn: number; results: number[] }>();
  const stopHeartbeat = touchTransports([dir]);
  return {
    path,
    observe(event: TraceEvent) {
      const id = event.attrs?.tool_use_id;
      if ((event.type !== 'tool.call' && event.type !== 'tool.result') || !identifier(id)) return;
      const saved = wire.get(id) ?? { calls: 0, callTurn: 0, results: [] };
      if (event.type === 'tool.call') {
        saved.calls++;
        saved.callTurn = event.turn ?? 0;
      } else saved.results.push(event.seq);
      wire.set(id, saved);
    },
    async drain(writer: TraceWriter, deriver: ExchangeEventDeriver) {
      const limit = 8 * 1024 * 1024;
      const size = (await file.stat()).size;
      if (size > limit) writer.markCaptureIncomplete('modkh_frames_limit');
      const bytes = Buffer.alloc(Math.min(limit, size));
      let read = 0;
      while (read < bytes.length) {
        const part = await file.read(bytes, read, bytes.length - read, read);
        if (!part.bytesRead) break;
        read += part.bytesRead;
      }
      const lines = bytes.subarray(0, read).toString().split('\n');
      if (lines.pop()) writer.markCaptureIncomplete('modkh_frames_partial');
      type Frame = ReturnType<typeof frame>;
      const ordered: { key: string; row: Frame }[] = [];
      const last = new Map<string, Frame>();
      const counts = new Map<string, number>();
      for (const line of lines) {
        try {
          const f = frame(line);
          const key = JSON.stringify([f.session, f.turn, f.attempt, f.ordinal]);
          const previous = last.get(key);
          if (previous && previous.tool_use_id !== f.tool_use_id)
            throw new Error('identity changed');
          if (!previous) counts.set(f.tool_use_id, (counts.get(f.tool_use_id) ?? 0) + 1);
          last.set(key, f);
          ordered.push({ key, row: f });
        } catch {
          writer.markCaptureIncomplete('invalid_modkh_frame');
        }
      }
      const receipts = new Map<string, number>();
      for (const { key, row: f } of ordered) {
        const id = f.tool_use_id;
        const seen = wire.get(id);
        const unique =
          counts.get(id) === 1 && (seen?.calls ?? 0) <= 1 && (seen?.results.length ?? 0) <= 1;
        const call = unique ? deriver.seqOf(id) : undefined;
        const observed = unique ? seen?.results[0] : undefined;
        const receiptSeq = observed ?? receipts.get(key);
        // Job acceptance is the result returned to the model. Later job settlement is a separate observation.
        const delivered =
          f.state === 'accepted' ||
          (f === last.get(key) &&
            !f.job_id &&
            f.state !== 'candidate' &&
            !['dispatch_pending', 'command_started', 'response_discarded'].includes(f.reason));
        // A host-only result retains its own identity when several calls reuse a provider ID.
        // Never attach it to a guessed proxy occurrence.
        const result = delivered && receiptSeq === undefined && !seen?.results.length;
        const cause = delivered ? (receiptSeq ?? call) : f.job_id ? receiptSeq : undefined;
        const event = await writer.append({
          type: result ? 'tool.result' : 'note',
          actor: 'harness',
          turn: unique ? (seen?.callTurn ?? 0) : 0,
          ...(cause !== undefined ? { causes: [cause] } : {}),
          attrs: {
            ...f,
            rule: 'modkh_tool_state',
            ...(unique ? {} : { correlation: 'ambiguous' }),
          },
        });
        if (result) {
          receipts.set(key, event.seq);
          if (call !== undefined) deriver.restore(event);
        }
      }
    },
    async close() {
      stopHeartbeat();
      try {
        await file.close();
      } finally {
        await removePrivateDirectory(dir, identity);
      }
    },
  };
}
