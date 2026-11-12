# Turn receipts and ChatGPT host support

Status assessed on 2026-11-12, against AgenticReplay base
`1f3e6ac9f509f002b7c90a9f7372820650fd86d4` on macOS / Node v26.13.0.

## Supported boundaries

- Existing Codex transport capture and host completion socket remain separate from
  ordinary ChatGPT conversation capture. Model names are not capabilities.
- Ordinary ChatGPT conversation capture is **unsupported**. No official host connector
  supplying complete content, stable conversation/turn/branch identities, actor scope,
  and terminal outcomes has been verified here. `doctor` reports this limitation.
- The app exposes `read_thread`, documented as recent status/turn summaries with
  truncated messages. A read of the current task failed with `Codex app tool request
  failed`. This establishes neither a working transcript connector nor a lifecycle
  subscription. No other conversation was read. The conventional
  `/Applications/Codex.app/Contents/Info.plist` was absent; installed app version was
  not verified by that probe.
- No ChatGPT adapter has been added. `/f/conversation` is not a Codex allowed path;
  no private endpoint interception, browser credential duplication, or model-name
  inference is used.
- Real ChatGPT host E2E: **not run**. Real Codex host E2E for these changes: **not run**.

## Shared contract

Import `TurnReceipt`, `assertTurnReceipt`, and `matchesUserTurn` from
`@agenticreplay/schema`. The normative wire schema is exported at
`@agenticreplay/schema/schema/turn-receipt.schema.json`.

`source`, `sessionId`, `turnId`, `branchId`, `scope`, and `requestIds` are explicit.
`outcome` is completed/interrupted/failed; `capture` is independently
complete/incomplete. `recording` names the run directory and SHA-256 of the exact
`events.jsonl` bytes. This is an integrity check, not a signature or proof against
another process running as the same OS user.

The current Codex adapter emits `scope: unknown`, `branchId: null`, and
`identityComplete: false`: existing transport metadata and completion messages do
not prove branch or user/background/subagent classification. A consumer must not
promote these receipts to verified user conversation memory. Existing Codex
recording/review behavior is preserved. Request IDs are capped at 32; missing,
invalid or additional IDs do not become invented identifiers. Identity remains
incomplete. Old finalized receipts without the shared payload are not migrated.

## Local delivery and consumer integration

The existing private Unix socket accepts this additional, read-only JSON line:

```json
{"action":"receipt","cwd":"/absolute/registered/root","sessionId":"exact-session","turnId":"exact-turn"}
```

It returns `pending` before finalization, `unavailable` for a mismatched workspace
or an old finalized entry without a shared payload, or:

```json
{"status":"finalized","receipt":{"schemaVersion":1,"...":"shared fields"}}
```

The last snippet is abbreviated, not a valid receipt fixture. Reading a receipt
never completes a turn. Network EOF and model `end_turn` alone do not complete it.
Existing `finish` and legacy review responses keep their response shapes. `finish`
now also accepts `failed`, which cannot subsequently become `completed`.

Final receipts are atomically persisted with fsync and replayed unchanged after
restart. Existing persisted completion intents and retry processing are reused.
The receiver can retry reads after a lost reply. This is a pull protocol, **not an
implemented push outbox or an exactly-once Kiokuko delivery guarantee**.

The inspected Kiokuko `src/agenticreplay/codex-completion.ts` currently reads only
`status` from `finish`. That repository was not changed. To integrate the shared
contract, its consumer must:

1. Read `receipt` after `finish` finalizes, with bounded background retries.
2. Validate the shared schema, exact expected source/session/turn/branch and scope,
   then independently verify the referenced recording and its digest.
3. Deduplicate `receiptId` transactionally with its accepted state. A changed body
   under an existing ID is a conflict, not an update.
4. Persist retry state before acknowledging delivery. Storage/verification failures
   remain diagnostics and must not block the user's task.

Until that receiver is implemented and exercised, end-to-end receipt delivery to
Kiokuko is **unverified**. A TypeScript export is not consumer adoption.

## Failure handling and retention

Recorder initialization failure in the Codex service/attach entry points now emits
`codex.capture_unavailable` and allows relay startup to continue. This does not
promise availability if the proxy itself, TLS setup, OS sockets or disk needed by
the relay are unavailable. Runtime capture write failures retain incomplete/pending
state; receipt creation does not run in the model forwarding callback.

Only explicitly registered Codex workspaces and identified turns use this receipt
store. Receipts contain identifiers, outcomes, local recording references and a
digest, not HTTP headers, cookies or authentication material. Existing recording
redaction still applies to content; this change does not claim arbitrary secrets
embedded in user prose can all be recognized.

Retention is currently **until explicit deletion**, with no automatic time-based
receipt expiry. Recordings remain subject to existing `agenticreplay gc` controls;
receipt metadata is separate and is not deleted by run GC. Consumers must treat a
missing recording as unavailable even when a receipt survives. Deleting receipt
metadata removes replay/deduplication history. No historical data was deleted here.

## Verification evidence and remaining acceptance gates

- Source build: `npm run build` passed.
- Pure/schema/store checks: **125 tests passed in 6 files**; command: `npx vitest run packages/schema/test packages/cli/test/turn-receipt-store.test.ts packages/cli/test/support-claims.test.ts packages/core/test/redaction.test.ts`.
- Added socket tests cover receipt replay/digest, restart, foreign session/turn/root,
  failed/interrupted non-promotion, and refusal of `/f/conversation`.
- Socket tests could not execute behavior: `listen EPERM` on private Unix sockets;
  loopback-dependent doctor/credential tests also encountered `listen EPERM`.
  The crash-recovery child test timed out. The first broad socket run was stopped.
  These are blocked checks, not regression passes. Run the socket suites in an
  environment authorized to listen before release.
- Installed recorder service was not restarted or upgraded. No deployment,
  commit, push, ChatGPT automatic-support claim, or Kiokuko receiver adoption.

Regression sensitivity: a disposable copy with the user-scope guard removed
accepted a background receipt, violating the added rejection assertion. The
original scope guard remained unchanged. Socket regression sensitivity and real
host behavior remain unverified. Changed TypeScript/JSON files passed Prettier;
`git diff --check` passed.
