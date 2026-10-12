import { basename, join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { Adapter, Launch, RecordContext } from '@agenticreplay/plugin-api';
import { forwardBasePath } from '@agenticreplay/proxy';
import { resolveRealBinary } from '@agenticreplay/shell-shim';
import { detectAgent } from './detect.js';
import { openCodeConfiguredBaseURLs, stripJsonc } from './opencode-config.js';
import { writeOpenCodeCapturePlugin, writeOpenCodeV2CapturePlugin } from './opencode-capture.js';
import { passKey, passThrough, proxyBase, readEnv } from './env.js';

/**
 * Where OpenCode keeps the credentials `opencode auth login` writes.
 *
 * Both locations, because the data directory moved and an installation that predates the move
 * still has the old one. Finding either means the harness can authenticate on its own.
 */
const OPENCODE_AUTH_PATHS = ['.local/share/opencode/auth.json', '.config/opencode/auth.json'];

/** Whether OpenCode has credentials of its own, independent of the environment. */
export function opencodeHasOwnAuth(env: Record<string, string | undefined> = process.env): boolean {
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = OPENCODE_AUTH_PATHS.map((relative) => join(home, relative));
  if (env.XDG_DATA_HOME) paths.push(join(env.XDG_DATA_HOME, 'opencode/auth.json'));
  if (env.XDG_CONFIG_HOME) paths.push(join(env.XDG_CONFIG_HOME, 'opencode/auth.json'));
  return paths.some((path) => existsSync(path));
}

/**
 * OpenCode's first-party providers, and the base URL the models.dev catalog gives each.
 *
 * OpenCode resolves its API origin per model, and only the OpenAI and Anthropic origins can be
 * named with an environment variable — so a run on one of these talked straight to its provider
 * while the proxy saw nothing, and the trace came out empty while the agent answered happily.
 * The existing config overlay points these two at the proxy carrying their own destination.
 * The final-fetch plugin independently covers the full catalog, including newly added providers
 * and model-specific API origins; this table is no longer the capture allowlist.
 */
const OPENCODE_FIRST_PARTY_BASE: Record<string, string> = {
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

/** The environment variable the run-local overlay rides in on. */
const CONFIG_CONTENT_VAR = 'OPENCODE_CONFIG_CONTENT';
const execFile = promisify(execFileCallback);

async function supportsStandalone(ctx: RecordContext): Promise<boolean> {
  const explicit = readEnv(ctx.env, 'AGENTICREPLAY_OPENCODE_STANDALONE');
  if (explicit !== undefined) return explicit === 'true';
  await mkdir(ctx.runDir, { recursive: true });
  const probe = await mkdtemp(join(ctx.runDir, '.opencode-capabilities-'));
  try {
    const result = await execFile('opencode', ['--help'], {
      cwd: probe,
      env: {
        PATH: readEnv(ctx.env, 'PATH'),
        HOME: probe,
        USERPROFILE: probe,
        XDG_CONFIG_HOME: join(probe, 'config'),
        XDG_DATA_HOME: join(probe, 'data'),
        XDG_CACHE_HOME: join(probe, 'cache'),
        XDG_STATE_HOME: join(probe, 'state'),
      },
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    return /(?:^|\s)--standalone(?:\s|,|$)/m.test(`${result.stdout}\n${result.stderr}`);
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function privateServerArgs(args: string[]): string[] {
  const delimiter = args.indexOf('--');
  const options = delimiter < 0 ? args : args.slice(0, delimiter);
  if (options.some((arg) => /^(?:--server|--attach)(?:=|$)/.test(arg)))
    throw new Error('OpenCode 2 capture does not support --server or --attach');
  if (options.includes('--standalone')) return [...args];
  const run = options.indexOf('run');
  return run >= 0
    ? [...args.slice(0, run + 1), '--standalone', ...args.slice(run + 1)]
    : ['--standalone', ...args];
}

/**
 * Shells whose real binary a shim can find again, from OpenCode's own acceptable set — the
 * POSIX shells it runs commands with, minus the ones it refuses outright.
 */
const SHIMMABLE_SHELLS = ['zsh', 'bash', 'sh', 'ksh', 'dash'] as const;

/**
 * The shell OpenCode falls back to when `SHELL` is unset or one it denies, which is what a
 * recorded run should resolve through the shim so that it behaves like the unrecorded one.
 */
function fallbackShells(): string[] {
  return process.platform === 'darwin' ? ['zsh', 'bash', 'sh'] : ['bash', 'sh'];
}

/**
 * Route OpenCode's shell tool through the shim, by pointing `SHELL` at one.
 *
 * OpenCode resolves its shell from this variable and then execs it *by absolute path*, so the
 * PATH shim in front of `bash` and `sh` never engaged: on macOS every command ran under
 * `/bin/zsh` and the frames file stayed empty while the trace showed shell tool calls. The shim
 * named after the real shell keeps every flag OpenCode passes (`-c`, and the login wrappers)
 * byte-identical — it is argv-transparent — so the run behaves the same and the shim sees it.
 *
 * The name is resolved before the run starts, because a shim whose real binary cannot be found
 * on PATH would answer every command 127 and break the run instead of under-recording it.
 * `installShellShim` writes one shim per name in its default set; a name that is not there
 * simply never gets picked, and the end-of-run `shell.ineffective` warning is what reports the
 * layer as unused.
 */
async function shellThroughShim(
  env: Record<string, string | undefined>,
  runDir: string,
): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  const shimDir = join(runDir, 'shims');
  const current = basename(readEnv(env, 'SHELL') ?? '').toLowerCase();
  const candidates = SHIMMABLE_SHELLS.includes(current as (typeof SHIMMABLE_SHELLS)[number])
    ? [current, ...fallbackShells()]
    : fallbackShells();
  for (const name of new Set(candidates)) {
    if ((await resolveRealBinary(name, env['PATH'] ?? '', shimDir)) !== undefined) {
      return join(shimDir, name);
    }
  }
  return undefined;
}

/**
 * The config overlay that rewrites OpenCode's per-provider origins through the proxy.
 *
 * `provider.<id>.options.baseURL` is the one lever OpenCode honours over its catalog's origin,
 * and `OPENCODE_CONFIG_CONTENT` is the config source merged last, so the overlay decides the
 * final URL without touching the user's files. Each base URL is rewritten to
 * `<proxy>/forward/<encoded base>`: the request arrives at the proxy naming where it was headed,
 * the proxy records the exchange and forwards to that base — so an OpenAI-compatible provider
 * whose origin is neither api.openai.com nor api.anthropic.com is captured, not bypassed.
 *
 * The user's own `options.baseURL` for the same provider is carried through rather than replaced.
 * A config that could not be parsed clears the whole overlay: an unreadable intent is not a
 * licence to reroute someone's provider. An existing `OPENCODE_CONFIG_CONTENT` keeps its fields
 * and provider routing; only the run-local capture plugin is appended.
 */
async function baseURLsThroughProxy(
  ctx: RecordContext,
  v2: boolean,
): Promise<Record<string, string>> {
  const theirs = readEnv(ctx.env, CONFIG_CONTENT_VAR);
  if (theirs !== undefined) return withCapturePlugin(ctx, theirs, v2);
  const scan = await openCodeConfiguredBaseURLs(ctx.env, ctx.cwd);
  if (!scan.trusted) return {};
  const provider: Record<string, { options: { baseURL: string } }> = {};
  for (const [id, catalogBase] of Object.entries(OPENCODE_FIRST_PARTY_BASE)) {
    const base = scan.overrides.get(id) ?? catalogBase;
    provider[id] = { options: { baseURL: `${proxyBase(ctx.proxyUrl)}${forwardBasePath(base)}` } };
  }
  return withCapturePlugin(ctx, JSON.stringify({ provider }), v2);
}

async function withCapturePlugin(
  ctx: RecordContext,
  content: string,
  v2: boolean,
): Promise<Record<string, string>> {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(stripJsonc(content));
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('not an object');
    if (config.plugin !== undefined && !Array.isArray(config.plugin))
      throw new Error('not a plugin list');
    if (config.plugins !== undefined && !Array.isArray(config.plugins))
      throw new Error('not a plugins list');
  } catch {
    // Leave invalid config for OpenCode to diagnose without discarding the user's settings.
    return { [CONFIG_CONTENT_VAR]: content };
  }
  const plugin = await writeOpenCodeCapturePlugin(ctx.runDir, proxyBase(ctx.proxyUrl));
  config.plugin = [...((config.plugin as unknown[] | undefined) ?? []), plugin];
  if (!v2) return { [CONFIG_CONTENT_VAR]: JSON.stringify(config) };
  if (readEnv(ctx.env, 'OPENCODE_CONFIG') !== undefined) {
    throw new Error('OpenCode 2 capture cannot compose an existing OPENCODE_CONFIG file safely');
  }
  const v2Plugin = await writeOpenCodeV2CapturePlugin(ctx.runDir, proxyBase(ctx.proxyUrl));
  // OpenCode 2 discovers plugins from a filesystem config. Keep the user's plugin order intact
  // and point only this child process at a run-local overlay; user config remains untouched.
  config.plugins = [...((config.plugins as unknown[] | undefined) ?? []), v2Plugin];
  const v2Config = join(ctx.runDir, 'agenticreplay-opencode-v2-config.json');
  await writeFile(v2Config, JSON.stringify({ plugins: config.plugins }), { mode: 0o600 });
  return {
    [CONFIG_CONTENT_VAR]: JSON.stringify(config),
    OPENCODE_CONFIG: v2Config,
  };
}

/**
 * Base URL overrides retain the existing SDK routing. The run-local plugin captures final fetches
 * to catalog APIs and ChatGPT OAuth's rewritten URL, retaining each actual destination.
 * NODE_OPTIONS/BUN_OPTIONS preloads do not run in OpenCode's compiled executable.
 */
export const openCodeAdapter: Adapter = {
  id: 'opencode',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['opencode'], ['.config/opencode', '.opencode']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const standalone = await supportsStandalone(ctx);
    const args = standalone ? privateServerArgs(ctx.userArgs) : [...ctx.userArgs];
    const env: Record<string, string> = {
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      // OpenCode's AI SDK appends /messages, unlike Claude Code's /v1/messages.
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
    };
    // Which credentials OpenCode can see is part of how it chooses a provider, so handing it a
    // placeholder for the provider the user has *not* configured can change which model the run
    // calls — a recorded run that answers differently from the same command uninstrumented is the
    // worst kind of capture bug. With no credential at all there is no choice to flip, and a
    // client that refuses to start without a key helps nobody, so placeholders stand in.
    //
    // Unless OpenCode has signed in on its own. `opencode auth login` writes a credential file the
    // environment knows nothing about, and inventing both variables in front of it is the failure
    // Claude Code showed plainly: the harness prefers the environment, authenticates with a key
    // that is not real, and the run dies before it starts. There is no provider choice to protect
    // there either — the credential file already made it.
    const hasAny =
      readEnv(ctx.env, 'OPENAI_API_KEY') !== undefined ||
      readEnv(ctx.env, 'ANTHROPIC_API_KEY') !== undefined;
    if (hasAny || (!standalone && opencodeHasOwnAuth(ctx.env))) {
      passThrough(env, ctx.env, 'OPENAI_API_KEY');
      passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    } else if (!standalone) {
      passKey(env, ctx.env, 'OPENAI_API_KEY');
      passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
    }
    Object.assign(env, await baseURLsThroughProxy(ctx, standalone));

    // `SHELL` overrides the user's own only to a shim standing in for a shell OpenCode would have
    // picked anyway. With `--no-shell` there is no shim directory, OpenCode's own resolution
    // finds nothing there and falls back exactly as it would unrecorded — so the wrong variable
    // costs nothing, and the right one is what makes the frames file non-empty.
    const shell = await shellThroughShim(ctx.env, ctx.runDir);
    if (shell !== undefined) env['SHELL'] = shell;

    return { command: 'opencode', args, env };
  },
};
