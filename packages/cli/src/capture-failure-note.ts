import type { TraceWriter } from '@agenticreplay/core';
import type { InterceptFailure } from '@agenticreplay/proxy';

export function shouldEmitCaptureFailure(failure: InterceptFailure): boolean {
  return failure.captureDiagnostic?.emit ?? true;
}

export function captureFailureFields(failure: InterceptFailure) {
  const { captureDiagnostic, ...fields } = failure;
  return { ...fields, ...captureDiagnostic };
}

interface FailureNoteTurn {
  connections: ReadonlySet<string>;
  sealed?: Promise<unknown>;
  broken: boolean;
  captureFailureGroups: Set<string>;
}

export function noteTurnCaptureFailure<Turn extends FailureNoteTurn>(
  turns: Iterable<Turn>,
  failure: InterceptFailure,
  enqueue: (turn: Turn, write: (writer: TraceWriter) => Promise<void>) => void,
): void {
  const { connectionId, captureDiagnostic } = failure;
  if (!connectionId) return;
  const group =
    captureDiagnostic &&
    JSON.stringify([
      connectionId,
      captureDiagnostic.phase,
      captureDiagnostic.errorCode,
      captureDiagnostic.errorType,
    ]);

  for (const turn of turns) {
    if (turn.sealed || !turn.connections.has(connectionId)) continue;
    const seen = group !== undefined && turn.captureFailureGroups.has(group);
    if (captureDiagnostic?.summary) {
      if (!seen) continue;
    } else {
      turn.broken = true;
      if (group !== undefined) turn.captureFailureGroups.add(group);
    }
    // A turn may join an existing connection between emission milestones.
    if (seen && !shouldEmitCaptureFailure(failure)) continue;
    enqueue(turn, async (writer) => {
      writer.markCaptureIncomplete(failure.code ?? 'transport_interception_failed');
      await writer.append({
        type: 'note',
        actor: 'agenticreplay',
        attrs: { ...captureFailureFields(failure), capture_incomplete: true },
      });
    });
  }
}
