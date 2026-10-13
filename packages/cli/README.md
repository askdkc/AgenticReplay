# AgenticReplay

AgenticReplay records AI API traffic and agent activity so you can inspect what happened after a run.

```console
npm i -g agenticreplay
agenticreplay doctor
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

The trace includes supported model requests and responses, tool calls and results, shell activity,
MCP traffic, and file changes. Use `list`, `show`, `events`, `graph`, `ui`, and `export` to browse it.

A recording launches your agent normally and forwards each API request upstream once. Recording
can incur the same API charges as running the agent without AgenticReplay. Redaction is best-effort;
review traces before sharing them.

See the repository [README](../../README.md), [integration notes](../../docs/integrations.md), and
[trace format](../../spec/agenticreplay-trace-v0.md).
