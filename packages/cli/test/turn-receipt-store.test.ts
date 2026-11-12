import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openTurnStore, type TurnReceipt } from '../src/codex-turn-store.js';

it('durably replays the same receipt and rejects crossed recording identities', async () => {
  const root = await realpath(await mkdtemp('/tmp/ar-receipt-store-'));
  const directory = join(root, 'store');
  const worktrees = new Map([[root, root]]);
  try {
    const store = await openTurnStore(directory, worktrees);
    const state: TurnReceipt = {
      version: 2,
      key: JSON.stringify(['chat', 'turn']),
      root,
      runId: 'run_abcdef',
      runDir: join(root, 'run'),
      createdAt: new Date().toISOString(),
      state: 'finalized',
      outcome: 'completed',
      capture: 'complete',
      receipt: {
        schemaVersion: 1,
        receiptId: 'a'.repeat(64),
        source: 'codex-runtime',
        sessionId: 'chat',
        turnId: 'turn',
        branchId: null,
        scope: 'unknown',
        requestIds: ['req'],
        identityComplete: false,
        outcome: 'completed',
        evidence: 'host-notification',
        capture: 'complete',
        recording: {
          runId: 'run_abcdef',
          directory: join(root, 'run'),
          eventsSha256: 'b'.repeat(64),
        },
      },
    };
    await Promise.all([store.save(state), store.save(state)]);
    const reopened = await openTurnStore(directory, worktrees);
    expect([...reopened.receipts.values()]).toEqual([state]);
    // A caller mutating its input after save cannot change the queued snapshot.
    const saved = structuredClone(state);
    const writing = store.save(state);
    state.receipt!.requestIds.push('later');
    await writing;
    expect((await openTurnStore(directory, worktrees)).receipts.get(state.key)).toEqual(saved);
    await store.save({ ...saved, receipt: { ...saved.receipt!, turnId: 'foreign' } });
    await expect(openTurnStore(directory, worktrees)).rejects.toThrow('identity mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
