# AgenticReplay

<sub>**English** · [简体中文](docs/i18n/README.zh-CN.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Deutsch](docs/i18n/README.de.md) · [Français](docs/i18n/README.fr.md) · [Español](docs/i18n/README.es.md) · [العربية](docs/i18n/README.ar.md)</sub>

AgenticReplay logs AI API traffic to help debug and improve AI harnesses. It captures requests
and responses from supported clients, including reasoning/thinking content or summaries returned
by the API. It also records tool, shell, MCP and filesystem activity that helps explain an agent run.

Browse the timeline, inspect the causal graph, and export a self-contained HTML report to find
where a run went wrong.

## Install

Requires Node.js 24+, Git, and a configured AI harness.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## Use

Run these commands in the project you want to investigate:

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

Record the harness process that sends the API requests, such as Claude Code. Logs are stored in
`.agenticreplay/runs/` in that project; `last` selects the newest recording. Open `run.html` in a
browser to inspect the trace.

Capture directories use `YYYYMMDDHHmmss-agent-title-id` (UTC). Names contain only lowercase
ASCII letters, digits and hyphens: at most 255 characters, with titles capped at 80.
Titles come from the session or, if unavailable, the first user prompt; they are redacted and
transliterated to ASCII. The final name is applied when recording closes. Existing `run_<id>`
directories and commands using a run ID remain supported.

For a custom harness that reads `OPENAI_BASE_URL`, replace `node agent.js` with its launch command:

```console
agenticreplay record generic-openai -- node agent.js
```

For Codex with a ChatGPT subscription, use TLS interception:

```console
agenticreplay record exec --tls-intercept -- codex
```

Recording runs the harness and may incur API charges. Redaction is best-effort: traces may still
contain sensitive data. Review them before sharing.

See [integrations](docs/integrations.md) for other harnesses and
[debugging a failing run](docs/how-to/debug-a-failing-agent-run.md) for an example.

## License

Apache-2.0. Trace specification: CC BY 4.0.
