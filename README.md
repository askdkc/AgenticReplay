# AgenticReplay

<sub>**English** · [简体中文](docs/i18n/README.zh-CN.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Deutsch](docs/i18n/README.de.md) · [Français](docs/i18n/README.fr.md) · [Español](docs/i18n/README.es.md) · [العربية](docs/i18n/README.ar.md)</sub>

AgenticReplay is an AI API traffic logger customized for debugging AI harnesses. It records
requests and responses from supported clients, including reasoning/thinking content or summaries
that the API actually returns. It cannot retrieve internal reasoning that the API does not expose.
Captured bodies are redacted before storage, and incomplete captures are marked.

Use the recorded communication alongside tool results, captured shell commands and file changes
to understand what the harness did, identify defects and guide improvements.

## Install

Requires Node.js 24 or newer, Git, and an installed harness with its usual credentials.

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

Wrap the harness that sends the AI API requests, such as Claude Code, rather than only its MCP
server. Runs are stored in `.agenticreplay/runs/` in that project; `last` selects the newest
recording. The HTML export lets you inspect the trace in a browser.

For a custom harness that honors `OPENAI_BASE_URL`:

```console
agenticreplay record generic-openai -- node agent.js
```

Replace `node agent.js` with your harness command. For Codex signed in with a ChatGPT subscription,
use TLS interception:

```console
agenticreplay record exec --tls-intercept -- codex
```

Recording runs the harness normally and can make paid API calls. Traces may contain sensitive
project data; review them before sharing.

See [integrations](docs/integrations.md) for other harnesses and
[debugging a failing run](docs/how-to/debug-a-failing-agent-run.md) for a walkthrough.

## License

Apache-2.0 for the code. The trace specification is CC BY 4.0, so anyone may reimplement it.
