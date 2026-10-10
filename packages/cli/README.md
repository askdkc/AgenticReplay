# AgenticReplay

### Your agent broke something at 2am. Replay it at 9am — exactly, offline, as many times as you like.

Record any coding agent. Reproduce the run byte-for-byte with the network off. Fork it from any
step onto a different model and see who gets it right.

![Recording a Claude Code run, replaying it offline, then forking it onto two models](https://raw.githubusercontent.com/askdkc/AgenticReplay/main/docs/demo-cli.gif)

<sup>Real output from one session — a Claude Code run recorded, replayed with the network off, then
forked at checkpoint 4 onto two models and graded by `npx tsc --noEmit`. Nothing here is mocked
up.</sup>

## Install

```console
npm i -g agenticreplay
agenticreplay doctor          # checks this machine can record at all
```

Node 24.0.0 or newer. No native dependencies — nothing to compile, nothing to download at install time.

## Three commands

```console
agenticreplay record claude              # your agent, unmodified, doing whatever it does
agenticreplay replay last                # the same run again — no network, no tokens, no charge
agenticreplay replay last --from 4 --model claude-haiku-4-5 --ui
```

The third line is the one people stay for: same files, same conversation prefix, different model
from step 4 onward. The model is the only variable, which is what makes the answer mean anything.

## What it gives you

**A timeline of what actually happened.** Every model turn with its token counts and stop reason,
every tool call with its arguments and result, every shell command with its exit code, every file
the run touched.

```console
$ agenticreplay show last
SEQ  KIND   WHAT                          DETAIL
12   TOOL   edit_file
14   FILE   src/auth.ts                   modified +18 −4
15   SHELL  ["npm","test","--","auth"]    /home/dev/api
16   SHELL  shell result                  exit 1 · 8.4s
17   ERROR  error
```

**What caused what.** Every edge says whether the recorder watched it happen or agenticreplay derived it
just now, and names the rule either way.

```console
$ agenticreplay graph last --to 17
FROM              TO                KIND      WHY
12 tool.call      15 shell.exec     recorded  causes
15 shell.exec     16 shell.result   recorded  shell result answers its exec
16 shell.result   17 error          recorded  causes
```

**The same task on several models, graded by a command you choose.** Not a model marking its own
homework — the verdict is the exit code of whatever you tell it to run, so the same prompt costs
you a number you can act on rather than an opinion.

```console
$ agenticreplay compare last --from 4 --models claude-sonnet-5,claude-haiku-4-5 --verify "npx tsc --noEmit"
MODEL                      VERDICT  TOKENS   COST       WALL
claude-sonnet-5            pass     124/429  $0.006807  12.2s
claude-haiku-4-5-20251001  pass     184/650  $0.003434  14.3s
```

Both passed here; the interesting column is what each one cost to get there.

Plus a browser timeline (`agenticreplay ui`), a single self-contained HTML file you can attach to an issue
(`agenticreplay export`), and shareable cards of one causal chain (`agenticreplay export --card`).

## Which agents

Claude Code, Codex, OpenCode, grok-cli, the Anthropic and OpenAI Agents SDKs, the Vercel AI SDK,
and any harness that reads a base-URL environment variable — including ones this project has never
heard of, via `AGENTICREPLAY_BASE_URL_VARS`. Harnesses that refuse to be redirected can be captured through
TLS interception with a certificate authority minted for that one run and thrown away after it.

`agenticreplay doctor` reports which of them it can find on your machine.

## Full documentation

**[github.com/askdkc/AgenticReplay](https://github.com/askdkc/AgenticReplay)** —
the worked bug hunt, the trace format spec, the programmatic API, CI usage, what is stored and
where, and the privacy model.

Apache-2.0. The trace format spec is CC BY 4.0, so anything can read or write these traces.
