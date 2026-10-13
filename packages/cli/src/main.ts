import { assertKnownFlags, assertNoStrayPositionals } from './flags.js';
import { parseArgs, type ParsedArgs } from './args.js';
import { AgenticReplay } from './api.js';
import { serveMcp } from './mcp-server.js';
import { Output } from './out.js';
import { attachCommand } from './commands/attach.js';
import { quickstartCommand } from './commands/quickstart.js';
import { recordCommand } from './commands/record.js';
import {
  graphCommand,
  exportCommand,
  gatewayRunsFor,
  listCommand,
  showCommand,
  uiCommand,
} from './commands/inspect.js';
import { pullCommand, pushCommand } from './commands/sync.js';
import { scrubCommand } from './commands/scrub.js';
import { gcCommand } from './commands/gc.js';
import { doctorCommand } from './commands/doctor.js';
import { modelsCommand, setupCommand } from './commands/setup.js';
import { withoutCredentials } from '@agenticreplay/proxy';
import { AGENTICREPLAY_VERSION } from './version.js';

const HELP = `agenticreplay ${AGENTICREPLAY_VERSION} — record and inspect AI agent activity

  agenticreplay quickstart                a project and a recorded run — no key, no network
        --dir <path>             where to put it (default: ./agenticreplay-quickstart)
        --full                   show the complete recorded timeline
  agenticreplay record <agent>            run an agent and capture supported API traffic
  agenticreplay attach                    record an agent agenticreplay does not launch — one in a sandbox,
                                 a container, or on another machine
        --for <agent>            print the variables that agent reads (default: exec)
        --bind <addr>            address to listen on (default: 127.0.0.1)
        --advertise <host>       how the sandbox reaches this machine, when they differ
        --remote-ca-path <p>     where the CA will live over there (default: /tmp/agenticreplay-ca.crt)
  agenticreplay show [run]                the timeline, in the terminal
  agenticreplay graph [run]               what caused what — recorded edges and derived ones
        --to N                   just the chain that produced event N
  agenticreplay export [run] -o file.html a single self-contained file you can attach
        --card [f.svg|png|gif]   one causal chain as a picture, ready to paste
        --graph-card [f.svg|png] the whole run as a graph, with the chain lit
        --to N                   which event the card is about (default: the failure)
  agenticreplay scrub [run] --match X     remove something from a recorded trace
        --dry-run                say what would go, and write nothing
        --drop-fs                delete the filesystem snapshots, which cannot be scrubbed
  agenticreplay ui [run]                  serve the viewer locally
  agenticreplay push [run]                send a run to the gateway, for the rest of the team
        --gateway <url>          where to send it (a gateway you named; no default)
        --fs                     include the workspace snapshots (scrub cannot clean them)
        --force                  push even though the gateway's scan found a secret
  agenticreplay pull <run>                fetch a gateway run into this machine's store
        --gateway <url>          where to fetch from (a gateway you named; no default)
        --force                  replace a run of the same id already recorded here
  agenticreplay list                      runs recorded here
        --remote                 runs held on the gateway instead (a gateway you named)
        --gateway <url>          with --remote: where to look (a gateway you named)
        --source gateway|upload  with --remote: what it recorded, or what was pushed
        --limit N                with --remote: how many (default 20)
  agenticreplay gc --older-than 7d        reclaim old recording data
                                 --keep N, --dry-run
  agenticreplay doctor                    check this machine can record at all
  agenticreplay setup                     point recording at an API gateway
                                 requires an explicit --gateway URL
        --gateway <url>          origin that serves the model APIs
        --key <k> | --key-env V  store the key, or read it from an environment variable
  agenticreplay models                    what the configured gateway serves, and what it costs

  [run] is a run id, or "last" (the default).

Flags
  --no-fs        skip filesystem capture
  --no-shell     skip shell capture (PATH shim in front of sh/bash)
  --no-agent-spans  skip the agent-structure layer (OpenAI Agents SDK)
  --mcp-config <path>  instrument MCP servers from this config
  --ci           machine-readable output, no progress
  --verbose      more detail
  --no-color     also honours NO_COLOR
  --port <n>     port for --ui and agenticreplay ui (default: any free port)

A harness that reads no base-URL variable cannot be captured that way at all — a Codex CLI signed
in with a ChatGPT subscription, a bot with its origin hardcoded, an agent in a language the fetch
hook cannot reach. Capture those below the agent instead, at the socket:

  agenticreplay record exec --tls-intercept -- <command> [args...]

exec (or "any") launches your command and redirects nothing: no origin and no credential are
invented, so an agent recorded this way still talks to whoever it was already talking to. It also
reaches an agent agenticreplay did not launch — record the editor, and the agent it spawns inherits the
capture.

  --max-body-bytes <n>         capture ceiling per body (default 67108864); overflow fails capture
  --max-buffered-bytes <n>     aggregate retained-body budget (default 268435456)
  --tls-intercept              decrypt HTTPS for the hosts below, for this run only
                               decrypt only the selected hosts for this recording
  --tls-hosts a,b,c            decrypt exactly these, replacing the default list
  --tls-hosts +a,+b            decrypt these *as well as* the default model API hosts
                               everything else is tunnelled unread; "*" is refused

  It mints a certificate authority in the run directory, trusts it to the agent through that
  child's environment alone, and deletes it when the run ends. It installs nothing, anywhere.
  If a machine is already behind a TLS-inspecting proxy, name its root in AGENTICREPLAY_TLS_UPSTREAM_CA.

Sending traffic somewhere other than the vendor — a gateway, a proxy, a local model — is what
these two are for:

  --upstream-anthropic <url>   origin for /v1/messages       (env AGENTICREPLAY_UPSTREAM_ANTHROPIC)
  --upstream-openai <url>      origin for /chat/completions  (env AGENTICREPLAY_UPSTREAM_OPENAI)

Everything after -- goes to the agent:
  agenticreplay record claude -- -p "fix the failing test"

For a script, an agent, or CI — every command below also answers as data:

  --json         one JSON document on stdout, diagnostics on stderr
                 list · show · events · graph · record
                 · doctor

  agenticreplay mcp       serve agenticreplay to an agent over MCP on stdio, so it can read its own runs:
                 {"command": "agenticreplay", "args": ["mcp"]}

Docs: https://github.com/askdkc/AgenticReplay
`;

/**
 * The commands `--json` answers and the terminal does not.
 *
 * A set rather than a special case. It holds one name today, and the point of the shape is that
 * adding a second `--json`-only view does not quietly bring back `agenticreplay events` telling a reader
 * that a command `--help` had just listed does not exist. `json-only.test.ts` derives the same set
 * from the two switches in this file and fails when this disagrees with them.
 */
const JSON_ONLY = new Set(['events']);

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const args = parseArgs(argv);
  if (args.bool('json')) return jsonMain(args, cwd);
  // Under `agenticreplay mcp`, stdout is the JSON-RPC transport. A single info line on it corrupts the
  // stream and the client drops the session with no useful error.
  const toStderr = args.command === 'mcp';
  const out = new Output({
    write: (s) => void (toStderr ? process.stderr : process.stdout).write(s),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
    verbose: args.bool('verbose'),
    ci: args.bool('ci') || process.env.CI === 'true',
    // `--no-color` parses to `color: false`. The `true` fallback is what separates that from an
    // unset flag — `bool('color')` alone returns false for both, which would disable colour for
    // everyone.
    ...(args.bool('color', true) ? {} : { color: false }),
  });

  if (args.bool('version') || args.command === 'version') {
    out.plain(AGENTICREPLAY_VERSION);
    return 0;
  }
  if (args.command === 'help' || args.bool('help') || args.bool('h')) {
    out.plain(HELP);
    return 0;
  }

  try {
    // Before anything runs: a flag the command does not have is an instruction that would be
    // silently ignored, and a run that quietly did something else is the failure agenticreplay exists to
    // surface. Inside the try so it is reported the same way every other failure is.
    assertKnownFlags(args);
    // Same reasoning, other half of the command line: an argument nothing reads is an
    // instruction that went nowhere, and for `record` it is the agent's own arguments.
    assertNoStrayPositionals(args);

    switch (args.command) {
      case 'quickstart':
        await quickstartCommand(args, out, cwd);
        return 0;
      case 'record':
        return (await recordCommand(args, out, cwd)).exitCode;
      case 'attach':
        return (await attachCommand(args, out, cwd)).exitCode;
      case 'show':
        await showCommand(args, out, cwd);
        return 0;
      case 'graph':
        await graphCommand(args, out, cwd);
        return 0;
      case 'export':
        await exportCommand(args, out, cwd);
        return 0;
      case 'push':
        await pushCommand(args, out, cwd);
        return 0;
      case 'pull':
        await pullCommand(args, out, cwd);
        return 0;
      case 'ui':
        await uiCommand(args, out, cwd);
        return 0;
      case 'scrub':
        await scrubCommand(args, out, cwd);
        return 0;
      case 'list':
        await listCommand(args, out, cwd);
        return 0;
      case 'gc':
        await gcCommand(args, out, cwd);
        return 0;
      case 'doctor':
        // A failed check is the whole point of running this in CI, so it has to be visible in $?.
        return (await doctorCommand(args, out, cwd)).ok ? 0 : 1;
      case 'setup':
        await setupCommand(args, out);
        return 0;
      case 'models':
        await modelsCommand(args, out);
        return 0;
      case 'mcp':
        // stdout is the transport here, so nothing else may touch it: `out` already writes to
        // stderr under this command, and the server owns the stream until stdin closes.
        await serveMcp({
          agenticreplay: new AgenticReplay({ cwd }),
          input: process.stdin,
          output: process.stdout,
        });
        return 0;
      default:
        // `--json` answers one view that the terminal does not, and `--help` lists it beside seven
        // that it does. A reader scanning that line reasonably types `agenticreplay events`, and being told
        // there is no such command — by the same tool that had just named it — reads as the CLI
        // contradicting itself. Name the route instead.
        if (JSON_ONLY.has(args.command)) {
          out.failure({
            event: 'json_only_command',
            what: `${args.command} answers as data, not as a table`,
            why: 'these are the raw trace records; `agenticreplay show` is the same events, rendered',
            next: `agenticreplay ${args.command} --json`,
          });
          return 2;
        }
        out.failure({
          event: 'unknown_command',
          what: `there is no "${args.command}" command`,
          next: 'agenticreplay help',
        });
        return 2;
    }
  } catch (err) {
    // THE ONE PLACE EVERY COMMAND'S ERROR BECOMES OUTPUT, so it is the one place the credential
    // has to come out (orcacode-review found push/pull leaking it; setup already wrapped its own
    // two call sites by hand).
    //
    // Per-command wrapping is what let this through: `push`/`pull` were new sinks for a gateway
    // URL and simply did not do it. A failed fetch reports the URL it was given, so an origin
    // configured as `https://user:pw@gw` or `https://gw?key=…` — both ordinary, both storable by
    // `agenticreplay setup` — arrives inside undici's exception text ("Request cannot be constructed from
    // a URL that includes credentials: …") and lands in the terminal and in the CI log.
    //
    // out.ts's own guard cannot catch it: that guard is shape-based and applies to `#line` field
    // names, and an arbitrary password matches no pattern. Sanitising here covers every existing
    // command and every future one, and is idempotent with setup.ts's hand-wrapping.
    //
    // The stack goes through it too: err.stack embeds the same message.
    const message = withoutCredentials(err instanceof Error ? err.message : String(err));
    const [first, ...rest] = message.split('\n');
    out.failure({
      event: `${args.command}.failed`,
      what: first ?? message,
      why: rest.join('\n').trim() || undefined,
    });
    if (out.isVerbose && err instanceof Error && err.stack)
      out.plain(withoutCredentials(err.stack));
    return 1;
  }
}

/**
 * `--json`: one JSON document on stdout, diagnostics on stderr.
 *
 * The split is the whole design. A caller wants the answer, so stdout is one document rather than
 * a stream of log objects — `agenticreplay show last --json | jq .events` works with nothing in front of
 * it. And a run that warns must not corrupt that document, so every `info`/`warn` line goes to
 * stderr, where a human still reads it and a parser never sees it.
 *
 * Failures come back as JSON too. An agent that only handles the happy path is an agent that
 * hangs on the first bad run, so an error is a document with an `error` key and a non-zero exit,
 * never prose.
 */
async function jsonMain(args: ParsedArgs, cwd: string): Promise<number> {
  const out = new Output({
    // Diagnostics only. Nothing here may reach stdout.
    write: (s) => void process.stderr.write(s),
    env: process.env,
    verbose: args.bool('verbose'),
    ci: true,
    color: false,
  });
  const emit = (doc: unknown): void => void process.stdout.write(`${JSON.stringify(doc)}\n`);

  try {
    // THE SAME TWO CHECKS THE PLAIN PATH MAKES, for the reason stated there: a flag the command
    // does not have is an instruction that would be silently ignored. `--json` is a second sink
    // for the same command, not a different command — and it returned above before either check
    // ran, so `agenticreplay show --worktre --json` did the opposite of what was typed and said nothing
    // about it, which is the failure the plain path exists to surface.
    assertKnownFlags(args);
    assertNoStrayPositionals(args);

    const agenticreplay = new AgenticReplay({ cwd });
    const selector = args.positionals[0] ?? 'last';
    switch (args.command) {
      case 'list':
        // `--remote` asks the gateway, here as much as on the terminal. It used to be dropped:
        // `agenticreplay list --remote --json` ran the LOCAL listing and emitted `[]` from a directory
        // with no runs — telling a script the gateway holds nothing while the same command
        // without `--json` printed what it holds. A silent wrong answer, to the reader least
        // able to notice.
        emit(args.bool('remote') ? await gatewayRunsFor(args, out) : await agenticreplay.list());
        return 0;
      case 'show':
        emit(await agenticreplay.show(selector));
        return 0;
      case 'events':
        emit(await agenticreplay.events(selector));
        return 0;
      case 'graph':
        emit(
          await agenticreplay.graph(selector, {
            ...(args.num('to') === undefined ? {} : { to: args.num('to')! }),
          }),
        );
        return 0;
      case 'attach': {
        const result = await attachCommand(args, out, cwd);
        emit(result);
        return result.exitCode;
      }
      case 'record': {
        const result = await recordCommand(args, out, cwd);
        emit(result);
        return result.exitCode;
      }
      case 'doctor': {
        const result = await doctorCommand(args, out, cwd);
        emit(result);
        return result.ok ? 0 : 1;
      }
      default:
        emit({
          error: {
            message: `--json does not cover '${args.command}'`,
            // Naming what it does cover beats making someone try them one at a time.
            supported: ['list', 'show', 'events', 'graph', 'record', 'doctor'],
          },
        });
        return 2;
    }
  } catch (err) {
    // Same reasoning as the plain-output catch above: --json is a second sink for the same text,
    // and a CI job is exactly where it gets captured and kept.
    emit({
      error: { message: withoutCredentials(err instanceof Error ? err.message : String(err)) },
    });
    return 1;
  }
}
