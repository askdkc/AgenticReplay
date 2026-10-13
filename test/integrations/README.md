# Integration checks

`agenticreplay record generic-openai -- python your_agent.py` is documented as working for LangGraph,
CrewAI, the OpenAI Agents SDK and anything else that reads a base-URL variable. Until this
directory existed, that was a sentence.

Each check records a real framework against a stub origin and inspects the stored network and
model requests/responses, causal links, payloads and framework activity. It is the difference between "we support X" and a line
in CI that goes red.

## Why end to end rather than the adapter contract

`checkAdapterContract` guards against adapter rot — a harness renames the variable it reads and the
adapter keeps setting the old one. It cannot see whether anything was actually captured.

`agenticreplay record opencode` once produced a trace with two events and no model exchange, twice over, for
two independent reasons. The contract was green for both. What catches that shape is running the
thing and counting what came back.

## Why a stub origin

Three properties, and every one of them is load-bearing:

- **Free.** A matrix that costs tokens per run is a matrix somebody eventually turns off.
- **Deterministic.** Fixed responses let the checks verify captured payloads and tool results.
- **Local.** All model and embedding traffic must go to the configured loopback origins.

The stub answers the shapes real frameworks use, not the simplest one: streaming SSE, tool calls,
and the Anthropic messages endpoint. Those are where a recording proxy is most likely to break, and
a matrix that only exercised a plain completion would have said nothing about either.

## What each check proves

| check | the mechanism it covers | what else rides on it |
|---|---|---|
| `openai-sdk` | the official Python SDK reads `OPENAI_BASE_URL` | every framework that lets the SDK build its own client |
| `openai-async` | the same for `AsyncOpenAI` | anything building its own async client |
| `anthropic-sdk` | `ANTHROPIC_BASE_URL` | Claude-backed agents that are not Claude Code |
| `litellm` | `OPENAI_API_BASE` through LiteLLM | **Aider** — and anything else riding that transport |
| `openhands-sdk` | the OpenHands SDK's own `LLM`, which wraps LiteLLM | OpenHands |
| `crewai` | CrewAI's own `Agent`, `Task` and `Crew` | CrewAI, which since 1.x does **not** use LiteLLM |
| `openai-agents` | the Agents SDK on the **Responses API**, its default | the Agents SDK, and agenticreplay's `responses` dialect |
| `openai-agents-handoff` | two agents, a handoff and a guardrail — reported by the SDK, not seen on the wire | the sixth capture layer |
| `langgraph-stream` | LangChain's own `OPENAI_API_BASE`, over SSE | LangGraph, LangChain |
| `langgraph-tools` | the same, with a bound tool | tool-calling graphs |
| `langgraph-nodes` | which node ran, in which superstep — including one that calls no model | the sixth capture layer, for graphs |
| `llama-index` | LlamaIndex's own OpenAI LLM, which reads the older base-URL variable and not the new one | LlamaIndex |
| `haystack` | a Haystack `Pipeline` whose generator takes no `api_base_url` | Haystack 3.x, and any component that lets the OpenAI SDK build its own client |
| `haystack-rag` | the same, embedding at query time: document embeddings, a query embedding, retrieval, then an answer | RAG pipelines with explicitly counted embedding requests |
| `browser-use` | its own `ChatOpenAI` passes an unset `base_url` through | browser-use, and the pattern any wrapper using the official SDK follows |
| `vision-repaint` | a screenshot recorded intact through redaction | agents with eyes and image payload preservation |
| `ai-sdk-openai` | a real `@ai-sdk/openai` client reading `OPENAI_BASE_URL`, no fetch preload | the Vercel AI SDK's env-aware path, which the bare-`fetch` fixtures cannot pin |
| `mastra` | a model provider that takes its origin in code rather than from the environment | Mastra, and any JS agent that never reads a variable |
| `mcp-stdio` | an MCP server launched from a config with recorded arguments and results | the MCP shim and correlated JSON-RPC capture |
| `fetch-hook` | `NODE_OPTIONS` preload on `globalThis.fetch` | the Vercel AI SDK, and any JS agent with its origin compiled in |
| `rag-index` | a concurrent index build, an embedding batch, and an answer over retrieved context | IndexRAG, LlamaIndex, GraphRAG, LightRAG — every pipeline that indexes before it answers |
| `rag-split-origin` | the same run with embeddings at a **second origin of the same wire dialect** | any stack whose chat and embeddings do not share a provider |

Twenty-two checks. Covering the layer underneath still covers what stands on it — that is what the
`litellm` row is for — but three of these exist because that stopped being enough, and each of the
three was added after running the framework itself said something the layer could not.

**CrewAI is the clearest case.** It sat under the `litellm` row for exactly the reason that row
gives, and in CrewAI 1.x it is no longer true: LiteLLM became an optional extra and CrewAI grew
native providers, so a default install never loads it. Capture survived — the native provider reads
both variables `generic-openai` sets — but the stated reason had been wrong for a whole major
version, and nothing here could have noticed. Running CrewAI also turned up two changes worth
documenting: a bare model name always reaches the native provider while a prefixed one can need
LiteLLM installed, and `LLM(base_url=…)`, long documented as silently ignored, is now honoured.

**The two `rag-*` checks cover concurrent indexing and embeddings.** They assert five model
requests and responses plus two distinct embedding calls, identified by request phase, path and
request ID. `rag-index` also verifies derived search context. `rag-split-origin` checks both the
host and port of every embedding request and confirms chat requests/responses stayed at the chat
origin. Start and body events for one request must not inflate these counts.

**`openai-agents` is not a duplicate of `openai-async` either.** The Agents SDK defaults to the
Responses API; `AsyncOpenAI` in that check uses chat completions. So the older check covered the
client underneath on a wire format the SDK does not use, and the format the README claimed support
for had no end-to-end check at all until this one.

## What the checks are worth, measured

A green matrix proves nothing on its own. Each redirect was removed in turn to see which checks
notice:

| removed from `generic-openai` | what fails |
|---|---|
| `OPENAI_BASE_URL` | `openai-sdk`, `openai-async`, `openai-agents`, `browser-use` |
| `ANTHROPIC_BASE_URL` | `anthropic-sdk` |
| `OPENAI_API_BASE` | **nothing** |

The last row is still the finding, and it survived the checks added since it was first measured.
LangChain reads `OPENAI_API_BASE` itself but hands the rest to the official client, which reads
`OPENAI_BASE_URL`; CrewAI's native provider reads **both**, so it survives losing either one on its
own and appears in neither row. Both variables stay set, because pre-1.0 SDKs and several ports read
only the second and this matrix does not cover those. It is worth knowing that today nothing here
would notice if that line went away.

Two notes on the re-measurement rather than the measurement:

- `browser-use` is new to the first row. It was absent from the earlier table and it does depend on
  `OPENAI_BASE_URL` — its `ChatOpenAI` passes an unset `base_url` to the official client, which is
  precisely the dependency. Read as a correction to the table, not as a change in browser-use.
- `litellm` is excluded from this run. A complete litellm install does not fit under the Windows
  long-path limit on the machine this was re-measured on, so its result here would have been an
  artefact of the environment rather than a fact about the redirect. It is unchanged from the
  earlier measurement, where removing `OPENAI_API_BASE` did not break it either — because
  `generic-openai` still sets the other two and LiteLLM is reached through the same client.

## Running them

```console
node test/integrations/run.mjs                # all of them
node test/integrations/run.mjs litellm        # one
node test/integrations/run.mjs --require-all  # a skip is a failure — what CI runs
```

Python checks are skipped, not failed, when the package they need is not installed — a contributor
without `langgraph` on their machine should still be able to run the suite.

`--require-all` is what makes a skip a failure, and it exists because the sentence that used to be
here said CI installing the packages was enough. It was not. Two checks were added without a line
in the workflow's `pip install`, CI went green on the skips, and the README said "in CI" about both
— a claim made false by an omission that nothing could fail on. Adding a check now means adding it
to that line, or this run says so.
