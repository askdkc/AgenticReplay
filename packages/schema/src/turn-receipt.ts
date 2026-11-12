/** Versioned exchange contract. Unknown identity must never be promoted to user memory. */
export interface TurnReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: 'codex-runtime' | 'chatgpt-host';
  sessionId: string;
  turnId: string;
  branchId: string | null;
  scope: 'user' | 'background' | 'subagent' | 'unknown';
  requestIds: string[];
  identityComplete: boolean;
  outcome: 'completed' | 'interrupted' | 'failed';
  evidence: 'host-notification';
  recording: { runId: string; directory: string; eventsSha256: string };
  capture: 'complete' | 'incomplete';
}

/** Consumers must additionally verify the recording digest and their expected identity. */
export function matchesUserTurn(
  receipt: TurnReceipt,
  expected: Pick<TurnReceipt, 'source' | 'sessionId' | 'turnId' | 'branchId'>,
): boolean {
  return (
    receipt.source === expected.source &&
    receipt.sessionId === expected.sessionId &&
    receipt.turnId === expected.turnId &&
    receipt.branchId !== null &&
    receipt.branchId === expected.branchId &&
    receipt.scope === 'user' &&
    receipt.identityComplete &&
    receipt.outcome === 'completed' &&
    receipt.capture === 'complete'
  );
}
