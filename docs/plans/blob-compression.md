# PLAN: compressed blob storage and bounded diagnostics

Scope: AgenticReplay storage, readers and historical-recording migration. No changes to dsh-codex or downstream Kiokuko repositories; no production recordings were manually modified during development.

1. Store blobs of at least 4 KiB as `<sha256>.gz` only when gzip reduces size. Keep SHA-256 and BlobRef.bytes based on uncompressed, redacted bytes. Preserve legacy files and atomic private writes.
2. Read both formats in Core, Viewer downloads/exports and the dependency-free Python reader. Bound decompression to 256 MiB per blob. Use gzip rather than zstd to retain Python >=3.10 support without new native/runtime dependencies.
3. Make scrub decompress and re-encode, GC recognize compressed names, and keep archives byte-preserving.
4. Limit stored blob bytes to 256 MiB per run. Limit normal events to 16 MiB, with a separate 64 KiB diagnostic allowance (including 4 KiB reserved for run.end). Oversized/missing content must be explicitly marked incomplete. These are file-content budgets, not filesystem block or whole-directory quotas; metadata and filesystem snapshots are outside them. Actual disk exhaustion cannot be solved by a logical allowance.
5. Verify round trips, mixed legacy/compressed runs, corrupt and oversized streams, stored-size accounting, bounded diagnostics, scrub/GC, and end-to-end viewer/export/reader behavior. Run build and existing suites. Record untested deployment scope.

No delta encoding. Historical migration is enabled as described below. Old readers cannot read the new .gz representation; downstream reader updates are still required.

## Manual inspection

```sh
gzip -dc /path/to/run/blobs/ab/abcdef....gz
# API bodies have a JSON string wrapper; remove it when needed:
gzip -dc /path/to/run/blobs/ab/abcdef....gz | jq -r .
```

Core TraceReader, Viewer display/download/HTML export and the Python reader expand on demand.
Scrub rewrites compressed blobs with new content hashes; GC recognizes both representations.
Archive/sync preserve file bytes and names. Reading needs no bulk extraction; historical migration runs incrementally at startup.

Ordinary overflow events may use only the first 4 KiB of the diagnostic allowance. Errors may
use the first 60 KiB; only `run.end` may use the final 4 KiB. Repeated normal events therefore
cannot consume the error and termination reserve.

## Verification (2026-11-13)

Base revision: `444f7d7`; changes are uncommitted. Build: `npm run build` passed.

- `npx vitest run packages/core/test packages/viewer/test/export.test.ts packages/viewer/test/render.test.ts packages/viewer/test/html.test.ts packages/cli/test/scrub.test.ts packages/cli/test/gc.test.ts packages/cli/test/archive.test.ts packages/cli/test/compressed-run.test.ts`: 540 passed, 16 skipped (21 passed files, 2 skipped files).
- Node-created compressed run consumed by Python 3.13: payload equality, SHA-256, exact expansion limit, over-limit rejection, corrupt gzip rejection and legacy precedence passed. `gzip -dc` returned the same bytes. Synthetic repetitive UTF-8 JSON fixture: 230,002 bytes -> 626 bytes; this is not a measurement of the user's production recording.
- Built codec acceptance check passed; the same check detected a disposable copy with compression deliberately disabled.
- Changed TypeScript formatting and `git diff --check` passed.
- Full `npm test` was interrupted after repeated environment failures; it did not pass. The focused Viewer HTTP attempt reported `listen EPERM` on 127.0.0.1. No HTTP/deployed-runtime success is claimed.
- Python pytest suite could not start: pytest is not installed. Direct cross-language checks above passed; they do not replace the full Python suite.

Operational assumptions: one active writer per run; blob accounting is serialized within a BlobStore
and initialized from disk on reopen. Installed processes were not restarted or upgraded. Historical
recordings were not modified. No commit, push or release was performed.

## Follow-up: historical compaction and Kiokuko compatibility

Implemented `agenticreplay compact [run] [--dry-run]` (no selector means all runs in the current
workspace). Only sealed runs with valid events integrity are considered. Each raw blob is hashed,
compressed only when smaller, written privately and synced, decoded and compared with the original,
then published without overwriting any existing gzip file. The original is removed only after
verification. If both representations remain after interruption, rerunning verifies the gzip before
removing the raw copy. Small, incompressible and over-256-MiB blobs are left alone. References and
manifest/event bytes do not change. Run this maintenance without concurrent scrub, GC or writers.
Temporary files from a process killed before cleanup may remain; they are not treated as blobs.
A failure can leave an already-converted subset; rerunning continues from the remaining raw files.

**Historical note (superseded below): automatic migration was initially withheld.** Downstream source inspection found:

- `/Users/dkc/Sites/Src/kiokuko/src/memory/replay-extract.ts`: reads the bare digest path directly,
  with a 2 MiB blob limit, SHA-256/length validation and a 32 MiB aggregate expanded budget.
- `/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-files.ts`: reads the bare digest path with
  private-path checks, validates SHA-256/length and accounts for expanded bytes.

Both consumers need gzip fallback on ENOENT while retaining their path, hash and expansion bounds.
This also blocks deployment of the new default compressed writer with those consumers, not just
historical migration. Receipt/event hashes remain unchanged, but payload extraction is incompatible.
The integration test demonstrates bare-path ENOENT after compaction and successful Core reading.
Neither external repository is writable in the current task environment; no changes were made there.
Do not run non-dry compaction on records used by these consumers before updating and testing them.

Next: update both readers and test actual Kiokuko extraction and DSH validation on mixed-format runs.
Startup migration has now been enabled by explicit user instruction; do not infer consumer
compatibility merely from the AgenticReplay version or from an unchanged receipt hash.

Follow-up validation: `npm run build` passed; Core, compact, flags, compressed-run, scrub, GC,
archive and non-HTTP Viewer suites passed 570 tests, with 16 skipped (23 passed files, 2 skipped).
`git diff --check` passed. Compaction tests cover dry-run immutability, reference preservation,
idempotence, unfinished runs, interrupted publication, corrupt input/target, symlinks and the
legacy-reader incompatibility. These tests use disposable fixtures, not the user's stored runs.


## Automatic migration enabled

Enabled by the user's explicit instruction, independently of the outstanding Kiokuko reader changes.
The ordinary CLI startup paths (`record`, `attach`, `show`, `graph`, `export`, `ui`, `review`, `list`,
`mcp`) run one quiet maintenance slice. Supported JSON inspection paths do likewise without writing
non-JSON output. Embedded recording starts through `ensureRunsDir()` also trigger the same slice,
including Codex service workspace preparation and kiokuko-dsh's preparation path.

Help/version and explicit maintenance (`compact`, `scrub`, `gc`, including dry runs) do not trigger
implicit migration. A workspace is processed at most once per process. Completed runs get a private
`.blob-compaction-v1.json` checkpoint keyed by the events hash; incomplete passes retain a cursor and
resume on a subsequent process startup. Unsealed runs are left untouched. Failures leave originals
and do not abort the requested command; `autoCompact()` reports failure counts to its caller.

Each slice visits at most four eligible runs, processes at most eight raw blobs per run and checks a
64 MiB input budget and 250 ms deadline between blobs. These are cooperative limits: one blob can
exceed the input/time target (up to the existing 256 MiB per-blob ceiling), and directory enumeration
and integrity verification also take time. This is not a hard 250 ms startup guarantee. Bigger or
incompressible blobs remain raw. Startup migration operates only on the accessed workspace, not an
unrequested filesystem-wide scan or npm installation script.

Kiokuko and kiokuko-dsh remain incompatible with gzip-only blobs until their separate reader plans
are implemented. Enabling migration does not fix those consumers. No installed package was upgraded
and no production store was manually migrated in this task.


Final automatic-migration validation: build passed; Core, compact, flags, compressed-run, scrub, GC,
archive, inspection, JSON command discovery and non-HTTP Viewer suites passed 595 tests, with
16 skipped (25 passed files, 2 skipped). Startup tests cover ordinary CLI invocation, embedded
`ensureRunsDir()`, bounded checkpoints across simulated process restarts, failure isolation and
help/version/dry-run exclusions. Kiokuko reader PLANs were written separately; their proposed
consumer changes and tests were not executed.
