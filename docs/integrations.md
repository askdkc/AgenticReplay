# Integrations

AgenticReplay captures an agent when its API client can be routed through the local recording
proxy. Built-in adapters prepare common harnesses; generic adapters accept a command directly.

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay record generic-openai -- python your_agent.py
agenticreplay record node -- node your_agent.mjs
agenticreplay record exec --tls-intercept -- your-agent
```

The generic OpenAI adapter sets common provider base-URL variables. The Node adapter also supports
clients that use `fetch` with a hard-coded provider URL. `exec --tls-intercept` can capture traffic
for configured TLS hosts when an environment redirect is unavailable. Check `agenticreplay doctor`
for local prerequisites and `agenticreplay list` after recording.

MoDKH can record tool execution even when the conversation ends before the next model request.
Set `MODKH_TOOL_RECORD_FILE` to an absolute JSONL file path before starting a compatible MoDKH
CLI. During recording, AgenticReplay gives the child a separate run-specific file for these
observations. It imports only identifiers, execution states and fixed reason codes when the child
exits. If the proxy already captured a matching result, the execution note references that result.
Repeated provider IDs with ambiguous attribution retain separate host identities. A command whose
last state is `unknown` has no confirmed outcome. Background acceptance carries the job ID and
settlement is a later observation.

Python integrations can add action spans for supported framework SDKs. These spans complement the
API trace with framework operations; they do not replace the agent's normal calls or responses.

```console
pip install agenticreplay-openai-agents
pip install agenticreplay-langgraph
```

A recorded run is a trace of one live execution. It does not promise deterministic behavior or
reconstruct external state. Use `show`, `graph`, `ui`, and `export` to examine the captured API
exchanges and actions. See [the trace specification](../spec/agenticreplay-trace-v0.md) for event
and payload details.

## Verified framework capture

CI drives these clients against a local stub and asserts recorded model requests/responses,
network destinations, and framework events. Counts below are recording checks, not replay metrics.

| Framework | Capture mechanism | CI recording evidence |
| --- | --- | --- |
| **OpenAI Agents SDK** | Official client on the Responses API | `openai-agents`, `model_exchanges=1`; [details](#verified-framework-capture) |
| **Vercel AI SDK** | Environment base URL and Node fetch hook | `ai-sdk-openai`, `fetch-hook`, `model_exchanges=1`; [details](#verified-framework-capture) |
| **LangGraph / LangChain** | Two-node streaming graph and bound tools | `langgraph-stream`, `langgraph-tools`, `model_exchanges=2`; [details](#verified-framework-capture) |
| **CrewAI** | Real Agent, Task and Crew using its native provider | `crewai`, `model_exchanges=1`; [details](#verified-framework-capture) |
| **Aider** | Underlying LiteLLM transport; CI does not run Aider itself | `litellm`, `model_exchanges=1`; [details](#verified-framework-capture) |
| **browser-use** | LLM layer only; CI does not launch a browser | `browser-use`, `model_exchanges=1`; [details](#verified-framework-capture) |

See the [integration runner](../test/integrations/README.md) for all 22 checks, including
embedding request counts, split origins, image preservation, MCP arguments/results, handoffs,
and graph nodes. CI uses `--require-all` so missing dependencies cannot silently skip coverage.
