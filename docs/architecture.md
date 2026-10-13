# Architecture

AgenticReplay is a passive recorder. It starts or attaches to an agent, observes API and action
traffic, forwards live API requests to their configured upstream, and saves an append-only trace
for later inspection. It does not synthesize responses or run an agent again from a trace.

## Capture flow

```text
agent ── model request ──▶ local capture proxy ── same request ──▶ provider
agent ◀─ model response ── local capture proxy ◀─ response ─────── provider
  │                           │
  ├── MCP ── transparent tee ─┤
  ├── shell ── recorder shim ──┤
  └── workspace ── change diff ┤
                              ▼
                 .agenticreplay/runs/<id>
```

The proxy streams responses through as they arrive while writing the observed exchange. For
TLS-intercepted routes it decrypts only the configured hosts and records the HTTP activity it can
observe. Unknown paths pass through and are recorded as opaque network traffic. A capture failure
is reported; it never falls back to a recorded or synthetic answer.

The MCP shim tees JSON-RPC messages to the original servers. Shell shims record command, output,
exit status, and duration. Workspace sampling uses a temporary git index outside the run directory
to compare successive states, then writes file-change events; temporary snapshots are removed when
recording ends. Traces store observed changes, not a restorable workspace image.

## Reading traces

The trace writer stores events and content-addressed payloads. The CLI, public API, MCP server, and
viewer all read the same trace format. `show` and the timeline render event sequences; `graph`
derives causal links; `export` creates a self-contained HTML view; and `push`/`pull` synchronize
recordings with a configured service.

Readers continue to accept legacy fork and replay fields so older recordings remain inspectable.
New recordings do not create replay state, fork provenance, checkpoints, or synthetic model
responses.

## Package graph

```text
schema ──────┬──▶ core ──┬──▶ proxy ──▶ cli
plugin-api ──┤           ├──▶ fs-capture
             ├──▶ providers ──────┘
             └──▶ adapters
                  viewer ──▶ cli
```

The schema and plugin API define the shared contracts. Adapters prepare agents for capture; they
do not define a replay or model-substitution interface.
