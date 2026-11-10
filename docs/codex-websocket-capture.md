# Codex WebSocket capture and correlation

WebSocket forwarding, connection evidence, and request/response correlation are
separate. A recorder failure does not disconnect a live socket. Ambiguous traffic
is never promoted into model, thinking, or tool events.

The Dock service writes connection traces under
`~/.agenticreplay/codex-dock/websocket-captures/`. An attached recorder with a Codex
review socket uses `websocket-captures/` beside that socket. These traces belong
to the recorder, not to a worktree, parent, child, or inferred current turn.
Ordinary recording without a review socket keeps connection-scoped events in
its session trace with `scope: connection` and no request/response causal link.
Turn traces contain `connection_id` references and sticky incomplete status when
their requests cannot be correlated. Existing recordings are never rewritten.

## State transitions

| State | Observation | Next state |
| --- | --- | --- |
| New socket | Upgrade succeeds | `ready`, `recovery: new_connection` |
| `ready` | One request, named response and its terminal | `ready` |
| `ready` | Cancel for the sole outstanding request | `cancelling` |
| `cancelling` | Matching named terminal, with no overlap | `ready`, `recovery: cancel_terminal` |
| Any open state | Overlapping creates, unsolicited response, conflicting/reused ID, unbound item, invalid JSON/binary message, or parser failure | `lost` |
| `lost` | Any later create, delta, or terminal | `lost` |
| Any open state | Socket closes | `closed` |

A cancelled exchange stays incomplete even after the next exchange succeeds.
A request closed before any response is identified stays `unconfirmed`; it cannot
produce model or tool events, and is not labelled a client abort.
A cancel without an outstanding request, or a create before cancellation drains,
does not prove a new correlation boundary. There is deliberately **no recovery
from `lost` within the same connection**. Host-initiated new connections have
independent identities and histories; the recorder does not force reconnection.

Responses streaming deltas can identify an output item rather than a response
([API event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)).
After a named response starts, `response.output_item.added` establishes an item
within that sole active response. ID-less deltas must name an established item.
Previously retired items cannot be attached to a later request. A terminal must
identify the response; an ID-less error does not prove cancellation has drained.
Identity history is bounded; exhausting it loses correlation rather than forgetting
old identities and risking reassignment.

## Stored evidence and limits

Each observed message records `connection_id`, direction, connection sequence,
observation time, state, representation, original byte count, and retained body.
`lostAt` points to the first loss diagnostic; `detail` identifies its trigger.
Open and cancellation-drain records name the recovery condition. Connection
records deliberately have no `causes` pairing a request and response.

The existing TraceWriter redaction, blob storage, body hashes, file permissions,
and event-file SHA-256 apply. Binary data uses the existing UTF-8/base64 body
representation. Hashes describe the stored, redacted representation, not secrets
removed from the original wire.

| Reason | Meaning |
| --- | --- |
| `correlation_lost` | A request/response assignment can no longer be established |
| `cancel_observed` | The recorder actually saw a cancellation request |
| `body_limit` | The body or retained raw-stream limit was exceeded |
| `buffer_limit` | The shared byte budget or bounded observation queue was exhausted |
| `frame_parse_failure` | The frame parser stopped decoding this direction |
| `connection_closed` | The connection ended; no client-abort inference is made |
| `save_failed` | A callback or persistent write failed |

`capture_limit` omission transformations are used only for actual body/buffer
limits. Partial retained response prefixes are preserved. Byte reservations stay
held until observation callbacks settle. A stalled writer can hold at most 256
observation callbacks per connection; excess observations become a bounded omission
record with a sequence range, count, and byte count. Shutdown drains that evidence
before closing writers.

After a parser failure, subsequent bytes are retained as `representation: wire`,
not invented JSON messages. Their boundaries are unknown, so the retained raw
stream is bounded per direction by the body limit. The original socket bytes still
flow unchanged. A recorder restart leaves unfinished traces incomplete/unverified
and starts new connection identities; it does not reassign old traffic.

## Verification scope

`packages/proxy/test/codex-websocket.test.ts` covers correlation, cancellation,
old IDs/items, byte budgets, and stalled-writer bounds.
`packages/cli/test/codex-websocket-recovery.test.ts` uses real TLS/WebSocket relays,
the daemon's capture callbacks, real trace files, turn completion, and hashes.
`packages/cli/test/websocket-capture.test.ts` exercises save failures, restart,
redaction, and integrity. The existing Codex turn/completion suites cover ordinary
turn switches and repeated completion notifications.

The 67-request then 3-request regression is synthetic input, not a replay of the
reported Mac session. Its original triggering event and actual reconnection
boundary remain unverified. AgenticReplay publication and Kiokuko's dependency
update/daemon activation are separate release steps.
