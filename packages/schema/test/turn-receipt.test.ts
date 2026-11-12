import { expect, it } from 'vitest';
import { matchesUserTurn, validateTurnReceipt, type TurnReceipt } from '../src/index.js';
const receipt: TurnReceipt = {
  schemaVersion: 1,
  receiptId: 'a'.repeat(64),
  source: 'codex-runtime',
  sessionId: 'chat',
  turnId: 'turn',
  branchId: 'branch',
  scope: 'user',
  requestIds: ['req'],
  identityComplete: true,
  outcome: 'completed',
  evidence: 'host-notification',
  recording: { runId: 'run_abcdef', directory: '/tmp/recording', eventsSha256: 'b'.repeat(64) },
  capture: 'complete',
};
it('validates the wire contract and rejects unknown credential fields', () => {
  expect(validateTurnReceipt(receipt).valid).toBe(true);
  for (const value of [
    null,
    {},
    { ...receipt, cookie: 'secret' },
    { ...receipt, branchId: null },
    { ...receipt, scope: 'unknown' },
    { ...receipt, requestIds: [] },
    { ...receipt, requestIds: ['req', 'req'] },
    { ...receipt, outcome: 'disconnected' },
  ])
    expect(validateTurnReceipt(value).valid).toBe(false);
});
it('requires exact source, session, turn, branch, user scope and complete proof', () => {
  expect(matchesUserTurn(receipt, receipt)).toBe(true);
  for (const changes of [
    { source: 'chatgpt-host' },
    { sessionId: 'other' },
    { turnId: 'parallel' },
    { branchId: 'fork' },
    { branchId: null },
    { scope: 'background' },
    { scope: 'subagent' },
    { scope: 'unknown' },
    { outcome: 'interrupted' },
    { outcome: 'failed' },
    { capture: 'incomplete' },
    { identityComplete: false },
  ]) {
    expect(matchesUserTurn({ ...receipt, ...changes } as TurnReceipt, receipt)).toBe(false);
  }
});
