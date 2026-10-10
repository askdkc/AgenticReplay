# AgenticReplay 0.5.0 acceptance

This checkout implements a clean break from OrcaReplay. New traces use schema 0.4.0 and
`agenticreplay_version`. Old archives and traces are rejected; existing user data is not migrated
or deleted. Package names, commands, environment variables, owned paths, and public recorder
symbols use AgenticReplay. Upstream attribution and real external protocol identifiers remain.

## Recording contract

`net.request` start evidence is persisted before dispatch. Every physical attempt has a request
identifier. Body evidence and terminal outcomes are separate from logical `model.*` navigation
events. Replay selects complete transport pairs; a logical response alone is insufficient.
Cross-provider forks retain the serving provider's actual request and response bodies. Those
origin records are excluded from direct replay because the client received a translated response.

Capture completeness, upstream HTTP/transport outcome, and agent exit status are independent.
A fully recorded HTTP 500 may be complete. An interrupted 200 response is incomplete. A child
process exiting zero with no observed API traffic does not prove capture: recording returns exit 2.

Bodies are buffered in memory up to 64 MiB by default. Configure the per-body and concurrent
buffer limits with `--max-body-bytes` and `--max-buffered-bytes`. No plaintext temporary HTTP body
files are used. Resource exhaustion, failed persistence, unsupported bodies, and missing evidence
remain explicit incomplete states. The limit is a body-buffer policy, not an operating-system
resident-memory ceiling.

Whole-body redaction precedes inline or atomic blob persistence. Unknown provider fields and
text survive. Transformation records identify the rule, location, count, and reason without
containing removed credentials. Persisted redacted body bytes have their own SHA-256 digest.
Blob digests cover the JSON storage wrapper; body downloads remove that wrapper.

Capture starts at the named HTTP proxy or process-local fetch boundary. It cannot recover
provider-hidden reasoning or SDK transformations before that boundary. Node fetch normalization
is distinct from wire bytes. `canonical_exact` in terminal output and `canonicalExact` in CLI JSON
describe replay matching, not raw-body equality.

## Reproduce the local checks

```sh
npm ci
npm run check
node scripts/conformance.mjs
node scripts/fidelity.mjs --check
node scripts/check-neutrality.mjs
node scripts/installed-smoke.mjs
```

The CI workflow installs the required framework dependencies before running:

```sh
node test/integrations/run.mjs --require-all
python test/integrations/agents/crewai_model_names.py
python test/integrations/agents/llama_index_model_names.py
```

The independent API oracle covers Responses, Chat Completions, Anthropic Messages, and DeepSeek
Messages over JSON and SSE, with bodies above 1 MiB and a secret split across response writes.
Its expected redactions are explicit test expectations, not the recorder's redaction code.
Dedicated proxy, TLS, core, and instrumentation suites cover HTTP/2, layered encodings, repeated
headers, limits, cancellation, concurrency, connection failures, and storage failure.

## Companion Kiokuko DSH

The changes are supplied in [`companion-kiokuko-dsh.patch`](../companion-kiokuko-dsh.patch), against
Kiokuko DSH commit `a4f029ff78d50124ee464963850a72b2a384fb8`. The working companion checkout for this
implementation is `/private/tmp/agenticreplay-companion-kiokuko-dsh`.

The native recorder installs process-local transport capture before provider calls, carries
session/model-call scope through async iteration, and writes transport and logical evidence
through the shared AgenticReplay writer. The HTTP-capture capability depends on transport
installation. Missing evidence or correlation marks the trace incomplete. Owned DSH configuration,
commands, source files, database tables, and public symbols are renamed. Historical database
migrations retain their identifiers; migration 034 creates the new recording surfaces.

## Verification boundary

Local fixture results are not live-provider verification. CI now targets Node 24 and 26;
remote CI has not been run for these uncommitted changes. Docker builds from this checkout's
tarballs, and CI includes a Docker build gate; Docker is not installed in the local environment,
so its build and runtime remain unverified locally.

Fresh Python wheel installation passes 255 tests. All 22 required framework integrations pass
without skips. Native pinned DSH 0.1.5-rc.1 recording acceptance passes 65 tests against rebuilt
AgenticReplay packages; the companion default unit suite has 832 passes and 44 opt-in skips,
reported separately from native acceptance. A clean npm-ci checkout on Node 24.0.0 and Python 3.12 passes 3,087 tests with 41 opt-in skips. Formatting, TypeScript,
conformance (72 events), fidelity (3 canonical matches, no regressions), and neutrality pass.
All 12 renamed npm tarballs declare `node >=24.0.0` and install together in a fresh consumer and pass CLI recording,
inspection, HTML export, offline replay, and MCP tool-identity checks.

Claude Code 2.1.220 and OpenCode 2.0.18 pass independent endpoint comparisons with a synthetic
MCP tool roundtrip and the published Kiokuko 1.0.26 MCP server active. Each client's captured model
requests contain real Kiokuko tool schemas; the Kiokuko process receives initialization and
`tools/list`. This uses isolated client configuration and the final installed AgenticReplay tarballs.
The independent endpoint oracle matches all 3 Claude Code and 4 OpenCode request/response pairs,
including system text, actual tool schemas/results, and the trailing stream sentinel.
OpenCode 2.0.18 also passes two native custom-provider loopback cases using the adapter's exact
emitted arguments and configuration. Version detection recognizes its `opencode v2.0.18` banner;
the launch uses a private server and the native `http.request` plugin. All seven OpenCode capture
checks pass on Node 24.0.0, including native API-key and OAuth fixtures seeded in the v2 credential
store, two custom origins, replay, and disabled-interception detection. Existing `OPENCODE_CONFIG`
overrides and explicit remote-server attachment remain rejected for version 2.

The follow-up source check on Node 24.0.0 passes 3,089 tests with 41 opt-in skips; the affected
proxy, adapter, TLS and Python-bootstrap suites separately pass 997 tests. All 12 final tarballs
install together and pass the distribution smoke checks.

Following explicit authorization, the remaining native clients were run with synthetic credentials
and isolated configuration. Codex 0.153.4 rejects reserved built-in provider overrides and ignores
`OPENAI_BASE_URL`; the adapter now uses `openai_base_url` for its built-in provider. Installed-package
acceptance verifies complete HTTP request/response bodies against an independent endpoint, including
system instructions and tool schemas. This Codex version first attempts WebSockets: these unsupported
attempts are now recorded as incomplete instead of silently returning 404. HTTP fallback is captured,
but the overall run correctly exits 2. WebSocket frame capture remains unsupported.

Hermes dce1e9b37581 (Python 3.14.7, OpenAI SDK 2.24.0) uses OS-backed Python truststore contexts that
ignore the standard CA environment variable. The process-local bootstrap now adds the run CA while
retaining certificate verification and platform roots. Installed-package acceptance matches all three
HTTP request/response pairs against the independent TLS endpoint (main model call, auxiliary model
call, and model catalog). System text, 24 tool definitions, and trailing SSE content survive capture.
This runtime also resets a TLS session; the failure is persisted and the run correctly stays incomplete
with exit 2. Successful HTTP body comparisons do not establish complete session coverage.

Reproduction scripts are `scripts/codex-client-acceptance.mjs` and
`scripts/hermes-client-acceptance.mjs`; both accept `AGENTICREPLAY_TEST_CLI` and
`AGENTICREPLAY_TEST_TRACE_READER` for installed-package validation. Hermes additionally requires
`AGENTICREPLAY_TEST_HERMES` naming its isolated executable. The Hermes fixture uses nip.io DNS for a
loopback origin outside proxy exclusions. A synthetic-key Codex request reached OpenAI and received
401 during diagnosis; no successful authenticated live-provider generation was tested. Remote CI
and Docker remain unverified. No real credentials, personal configuration changes, commits, or pushes
were used.

The Node minimum is consistent across all npm manifests, the lockfile, the CLI doctor check,
release workflows, Docker images, documentation, and the DSH companion. CI and release test jobs
explicitly install Python 3.12 because the TypeScript suite also launches Python fixture agents.
The 22 required framework integrations also pass on exactly Node 24.0.0. These are local CI-command
results on macOS; GitHub's Linux jobs and Docker remain separate unexecuted gates.
