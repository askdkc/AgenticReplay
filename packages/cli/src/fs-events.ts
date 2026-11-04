import type { TraceWriter } from '@agenticreplay/core';
import type { FsCapture } from '@agenticreplay/fs-capture';
import type { Output } from './out.js';
import { snapshotWithRetry } from './snapshot.js';

/** Compare consecutive workspace samples and record only the observed file operations. */
export async function appendSnapshot(
  fs: FsCapture,
  writer: TraceWriter,
  out: Output,
  turn: number,
  _options: { initial?: boolean } = {},
): Promise<void> {
  const outcome = await snapshotWithRetry(fs, turn);
  if (!outcome.ok || !outcome.snapshot) {
    out.warn('fs.capture_failed', { turn, attempts: outcome.attempts, error: outcome.error });
    await writer.append({
      type: 'note',
      actor: 'agenticreplay',
      turn,
      attrs: { rule: 'fs_capture_skipped', attempts: outcome.attempts, error: outcome.error },
    });
    return;
  }

  // Not the failure above: a turn arriving behind the last sample is what happens whenever the
  // harness keeps exchanges in flight at once, and a later one reached the recorder first. The
  // later sample already holds this turn's window, so a sample taken now would reattribute its
  // diff below the turns that produced it. Keep the reorder in the trace, but quiet — a warn per
  // background exchange trains people to ignore warns.
  const coveredBy = outcome.snapshot.coveredBy;
  if (coveredBy !== undefined) {
    out.debug('fs.capture_out_of_order', { turn, covered_by_turn: coveredBy });
    await writer.append({
      type: 'note',
      actor: 'agenticreplay',
      turn,
      attrs: { rule: 'fs_capture_out_of_order', covered_by_turn: coveredBy },
    });
    return;
  }

  for (const change of outcome.snapshot.changes) {
    await writer.append({
      type: 'fs.change',
      actor: 'agenticreplay',
      turn,
      attrs: {
        path: change.path,
        status: change.status,
        insertions: change.insertions,
        deletions: change.deletions,
        ...(change.eolOnly === true ? { eol_only: true } : {}),
      },
    });
  }
}
