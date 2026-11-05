import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureRunsDir, TraceReader } from '@agenticreplay/core';
import { createProxy } from '@agenticreplay/proxy';
import type { ParsedArgs } from '../args.js';
import { captureLimits } from '../capture-limits.js';
import { managedDesktopSocket } from '../codex-service.js';
import { openCodexTurnCapture } from '../codex-turn-capture.js';
import type { Output } from '../out.js';
import { reviewRepository } from '../review-store.js';
import { SerialQueue } from '../serial.js';
import { setupTlsCapture, trustRunCa } from '../tls-capture.js';

const desktopHosts = ['chatgpt.com:443', 'api.openai.com:443'];
const desktopOptions = new Set([
  'tls-hosts',
  'tls-intercept',
  'max-body-bytes',
  'max-buffered-bytes',
]);

function codexDesktopExecutable(): string {
  if (process.platform !== 'darwin') throw new Error('Codex desktop recording requires macOS.');
  const script = `
    ObjC.import("AppKit");
    const id = "com.openai.codex";
    const registered = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
    const paths = registered.isNil() ? [] : [ObjC.unwrap(registered.path)];
    for (const name of ["ChatGPT.app", "Codex.app"]) {
      paths.push("/Applications/" + name, ObjC.unwrap($.NSHomeDirectory()) + "/Applications/" + name);
    }
    let executable = null;
    for (const path of paths) {
      const bundle = $.NSBundle.bundleWithPath(path);
      if (!bundle.isNil() && ObjC.unwrap(bundle.bundleIdentifier) === id) {
        executable = ObjC.unwrap(bundle.executableURL.path);
        break;
      }
    }
    JSON.stringify({
      executable,
      running: $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count > 0
    });
  `;
  const { executable, running } = JSON.parse(
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  ) as { executable: string | null; running: boolean };
  if (running)
    throw new Error(
      'Codex desktop is already running. Quit Codex, then rerun agenticreplay record codex --desktop.',
    );
  if (!executable) throw new Error('Could not find the installed Codex desktop app.');
  return executable;
}

async function runDesktop(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  // Start the bundle executable so the app and the app-server it spawns inherit this session's
  // environment. LaunchServices can otherwise reuse an app with a different environment.
  const child = spawn(executable, [], { cwd, env, stdio: 'ignore' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function desktopRuns(runs: string) {
  const readers = new Map<string, TraceReader>();
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reader = await TraceReader.open(join(runs, entry.name)).catch(() => undefined);
    if (reader?.manifest().adapter?.id === 'codex-desktop-api')
      readers.set(reader.manifest().run_id, reader);
  }
  return readers;
}

async function sealServiceTurn(socket: string, cwd: string, reader: TraceReader) {
  let identity: Record<string, unknown> | undefined;
  for await (const event of reader.stream()) {
    if (event.type === 'run.start') identity = event.attrs;
    break;
  }
  const { sessionId, turnId } = identity ?? {};
  if (typeof sessionId !== 'string' || typeof turnId !== 'string') return;
  const connection = createConnection(socket);
  connection.setTimeout(2500, () => connection.destroy(new Error('Codex review timed out.')));
  connection.setEncoding('utf8');
  connection.once('connect', () =>
    connection.write(JSON.stringify({ cwd, sessionId, turnId }) + '\n'),
  );
  let reply = '';
  for await (const part of connection) {
    reply += part;
    if (reply.length > 8192) {
      connection.destroy();
      return;
    }
  }
  const result = JSON.parse(reply) as { status?: string; traceDirectory?: string };
  if (result.status === 'sealed' && result.traceDirectory)
    return TraceReader.open(result.traceDirectory);
}

async function recordUsingService(
  executable: string,
  root: string,
  runs: string,
  socket: string,
  out: Output,
) {
  const previous = await desktopRuns(runs);
  out.phase('recording', { adapter: 'codex-desktop', cwd: root });
  const childExitCode = await runDesktop(executable, root, {
    ...process.env,
    AGENTICREPLAY_CODEX_REVIEW_SOCKET: socket,
  });
  let completeTurns = 0;
  let modelExchanges = 0;
  const seen = new Set(previous.keys());
  for (let attempt = 0; attempt < 4; attempt++) {
    let pending = false;
    for (const [id, reader] of await desktopRuns(runs)) {
      if (seen.has(id)) continue;
      const sealed =
        reader.manifest().capture?.status === 'complete'
          ? reader
          : await sealServiceTurn(socket, root, reader);
      if (!sealed) {
        pending = true;
        continue;
      }
      seen.add(id);
      completeTurns++;
      modelExchanges += (await sealed.events()).filter(
        (event) => event.type === 'model.response',
      ).length;
    }
    if (!pending) break;
    await delay(100);
  }
  if (completeTurns === 0)
    out.warn('capture.empty', {
      cause: 'no complete Codex API turn was captured for this worktree',
    });
  const exitCode = childExitCode || (completeTurns > 0 ? 0 : 2);
  out.phase('recorded', { turns: completeTurns, exchanges: modelExchanges, exit: exitCode });
  return { exitCode, childExitCode, modelExchanges, completeTurns };
}

export async function recordDesktopCommand(args: ParsedArgs, out: Output, cwd: string) {
  if (args.positionals[0] !== 'codex')
    throw new Error('--desktop requires agenticreplay record codex --desktop.');
  const captureFlags = Object.keys(args.flags).filter(
    (flag) =>
      flag !== 'desktop' &&
      !desktopOptions.has(flag) &&
      !['ci', 'json', 'verbose', 'color'].includes(flag),
  );
  if (args.passthrough.length || captureFlags.length || !args.bool('tls-intercept', true))
    throw new Error(
      'Codex desktop recording uses the installed profile and requires scoped TLS interception.',
    );

  const executable = codexDesktopExecutable();
  const root = await reviewRepository(cwd);
  const runs = await ensureRunsDir(root);
  const service = await managedDesktopSocket(root);
  if (service) {
    if ([...desktopOptions].some((flag) => args.has(flag)))
      throw new Error(
        'The active Codex service owns capture settings. Disable it to use per-run TLS flags.',
      );
    return recordUsingService(executable, root, runs, service, out);
  }
  // A Unix socket needs a short pathname, including on macOS with a long per-user TMPDIR.
  const scratch = await mkdtemp(join(await realpath('/tmp'), 'ar-codex-'));
  try {
    await chmod(scratch, 0o700);
    const socket = join(scratch, 'review.sock');
    const turns = await openCodexTurnCapture(socket, root, runs, {
      requireWorkspace: true,
      maxBufferedBytes: captureLimits(args).maxBufferedBytes,
    });
    try {
      const tls = await setupTlsCapture({
        args,
        out,
        runDir: scratch,
        defaultHosts: desktopHosts,
        passThroughWebSockets: true,
        writes: new SerialQueue(),
        turn: () => 0,
        onNetExchange: turns.finish,
      });
      const proxy = await createProxy({
        ...tls.proxyOptions,
        retainExchanges: false,
        onRequestStart: turns.start,
        onExchange: turns.model,
      });
      let childExitCode: number;
      try {
        const env: Record<string, string> = {};
        await trustRunCa(undefined, proxy.tls!, proxy.url, env, out);
        env.CODEX_CA_CERTIFICATE = proxy.tls!.caCertPath;
        env.AGENTICREPLAY_CODEX_REVIEW_SOCKET = socket;
        env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
        out.phase('recording', { adapter: 'codex-desktop', cwd: root });
        childExitCode = await runDesktop(executable, root, { ...process.env, ...env });
      } finally {
        await proxy.close();
      }
      const { modelExchanges, completeTurns } = await turns.close();
      if (completeTurns === 0)
        out.warn('capture.empty', {
          cause: 'no complete Codex API turn was captured for this worktree',
        });
      const exitCode = childExitCode || (completeTurns > 0 ? 0 : 2);
      out.phase('recorded', { turns: completeTurns, exchanges: modelExchanges, exit: exitCode });
      return { exitCode, childExitCode, modelExchanges, completeTurns };
    } finally {
      await turns.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
