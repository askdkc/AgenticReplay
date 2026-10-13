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
