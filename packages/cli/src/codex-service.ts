import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ensureRunsDir } from '@agenticreplay/core';
import { createProxy, RunCa } from '@agenticreplay/proxy';
import {
  codexConfigStatus,
  codexServiceBaseUrl,
  setCodexServiceEndpoint,
} from './codex-service-config.js';
import { openCodexWorktreeCapture } from './codex-turn-capture.js';
import { reviewRepository } from './review-store.js';

const label = 'io.github.askdkc.agenticreplay.codex-dock';
const exec = promisify(execFile);
const origin = { host: 'chatgpt.com', port: 443 };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

interface ServiceState {
  version: 1;
  configPath: string;
  port: number;
  worktrees: string[];
  plistDigest: string;
}

async function servicePaths() {
  const home = await realpath(homedir());
  const directory = join(home, '.agenticreplay', 'codex-dock');
  return {
    directory,
    state: join(directory, 'service.json'),
    socket: join(directory, 'review.sock'),
    lock: join(directory, 'setup.lock'),
    plist: join(home, 'Library', 'LaunchAgents', label + '.plist'),
  };
}
type Paths = Awaited<ReturnType<typeof servicePaths>>;

function codexProfile(): string {
  return resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function privatePath(file: string, type: 'directory' | 'file' | 'socket') {
  const info = await lstat(file);
  const correct =
    type === 'directory' ? info.isDirectory() : type === 'socket' ? info.isSocket() : info.isFile();
  if (!correct || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error(`The Codex service needs a private, user-owned ${type}: ${file}`);
  return info;
}

async function readState(paths: Paths): Promise<ServiceState | undefined> {
  try {
    await privatePath(paths.directory, 'directory');
    if ((await realpath(paths.directory)) !== paths.directory)
      throw new Error('The Codex service directory must not use symbolic links.');
    await privatePath(paths.state, 'file');
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw error;
  }
  const state = JSON.parse(await readFile(paths.state, 'utf8')) as ServiceState;
  if (
    state.version !== 1 ||
    typeof state.configPath !== 'string' ||
    !isAbsolute(state.configPath) ||
    !Number.isInteger(state.port) ||
    state.port < 1024 ||
    state.port > 65535 ||
    !Array.isArray(state.worktrees) ||
    !state.worktrees.length ||
    state.worktrees.length > 64 ||
    !state.worktrees.every((root) => typeof root === 'string' && isAbsolute(root)) ||
    !/^[a-f0-9]{64}$/u.test(state.plistDigest)
  )
    throw new Error('Invalid Codex service registration.');
  return state;
}

async function saveState(paths: Paths, state: ServiceState) {
  const scratch = await mkdtemp(join(paths.directory, '.save-'));
  try {
    const file = join(scratch, 'service.json');
    await writeFile(file, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(file, paths.state);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function launchDomain(): string {
  return `gui/${process.getuid!()}`;
}

function launchctl(...args: string[]) {
  return exec('/bin/launchctl', args, { timeout: 8000 });
}

async function launchLoaded(): Promise<boolean> {
  try {
    await launchctl('print', `${launchDomain()}/${label}`);
    return true;
  } catch (error) {
    if (
      /could not find service|service is not loaded|no such process/iu.test(
        String((error as { stderr?: string }).stderr),
      )
    )
      return false;
    throw error;
  }
}

async function checkPlist(paths: Paths, state: ServiceState) {
  await privatePath(paths.plist, 'file');
  if (digest(await readFile(paths.plist, 'utf8')) !== state.plistDigest)
    throw new Error('The Codex service LaunchAgent was changed outside AgenticReplay.');
}

function launchPlist(entry: string, runtime: string) {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const argumentsXml = [runtime, entry, 'codex-service', 'serve']
    .map((part) => `<string>${escape(part)}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>2</integer>
</dict></plist>
`;
}

async function openPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function canReview(socket: string): Promise<boolean> {
  try {
    await privatePath(socket, 'socket');
    return await new Promise((resolve) => {
      const connection = createConnection(socket);
      connection.setTimeout(400, () => connection.destroy());
      let reply = '';
      connection.setEncoding('utf8');
      connection.once('connect', () => connection.write('{}\n'));
      connection.on('data', (part) => {
        reply += part;
        if (reply.length > 512) connection.destroy();
      });
      connection.once('end', () => resolve(reply === '{"status":"unavailable"}\n'));
      connection.once('error', () => resolve(false));
      connection.once('close', () => resolve(false));
    });
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
}

async function waitForReview(socket: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await canReview(socket)) return;
    await delay(100);
  }
  throw new Error('The Codex service did not open its review socket.');
}

async function withLock<T>(paths: Paths, work: () => Promise<T>): Promise<T> {
  const parent = dirname(paths.directory);
  await mkdir(parent, { mode: 0o700, recursive: true });
  if ((await realpath(parent)) !== parent)
    throw new Error('The Codex service directory must not use symbolic links.');
  await mkdir(paths.directory, { mode: 0o700, recursive: true });
  await privatePath(paths.directory, 'directory');
  if ((await realpath(paths.directory)) !== paths.directory)
    throw new Error('The Codex service directory must not use symbolic links.');
  try {
    await mkdir(paths.lock, { mode: 0o700 });
  } catch (error) {
    if (errno(error) === 'EEXIST')
      throw new Error('Another Codex service configuration operation holds the setup lock.');
    throw error;
  }
  try {
    return await work();
  } finally {
    await rm(paths.lock, { recursive: true });
  }
}

async function startService(paths: Paths, restart: boolean) {
  if (!(await launchLoaded())) await launchctl('bootstrap', launchDomain(), paths.plist);
  else if (restart) await launchctl('kickstart', '-k', `${launchDomain()}/${label}`);
  await waitForReview(paths.socket);
}

async function stopService() {
  if (!(await launchLoaded())) return;
  await launchctl('bootout', `${launchDomain()}/${label}`);
  // launchctl acknowledges bootout before the running job has disappeared.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await launchLoaded())) return;
    await delay(100);
  }
  throw new Error('The Codex service did not unload after bootout. Retry disable.');
}

async function register(paths: Paths, cwd: string, configOption?: string) {
  const configPath = configOption === undefined ? codexProfile() : resolve(cwd, configOption);
  const root = await reviewRepository(cwd);
  await withLock(paths, async () => {
    const existing = await readState(paths);
    if (existing) {
      if (existing.configPath !== configPath)
        throw new Error('The service is registered for a different Codex profile.');
      await checkPlist(paths, existing);
      const configStatus = await codexConfigStatus(configPath, existing.port);
      if (configStatus === 'conflict')
        throw new Error('The Codex endpoint changed outside AgenticReplay.');
      const added = !existing.worktrees.includes(root);
      if (added && existing.worktrees.length >= 64)
        throw new Error('Too many registered Git worktrees.');
      if (added) await saveState(paths, { ...existing, worktrees: [...existing.worktrees, root] });
      try {
        await startService(paths, added || !(await canReview(paths.socket)));
        if (configStatus === 'clear')
          await setCodexServiceEndpoint(configPath, existing.port, true);
      } catch (error) {
        if (added) {
          await saveState(paths, existing);
          await startService(paths, true);
        }
        throw error;
      }
      return;
    }
    if ((await codexConfigStatus(configPath)) !== 'clear')
      throw new Error(
        'Codex already has an openai_base_url. Resolve the conflict before registering.',
      );
    if (await launchLoaded())
      throw new Error('A Codex service already uses this LaunchAgent label.');
    const entry = process.argv[1];
    if (!entry) throw new Error('The installed AgenticReplay CLI path could not be determined.');
    const plist = launchPlist(resolve(entry), process.execPath);
    const state: ServiceState = {
      version: 1,
      configPath,
      port: await openPort(),
      worktrees: [root],
      plistDigest: digest(plist),
    };
    await mkdir(dirname(paths.plist), { recursive: true });
    if ((await realpath(dirname(paths.plist))) !== dirname(paths.plist))
      throw new Error('The LaunchAgents directory must not use symbolic links.');
    await writeFile(paths.plist, plist, { mode: 0o600, flag: 'wx' });
    try {
      await saveState(paths, state);
      await startService(paths, false);
      await setCodexServiceEndpoint(configPath, state.port, true);
    } catch (error) {
      await stopService();
      await rm(paths.state, { force: true });
      await rm(paths.plist);
      throw error;
    }
  });
}

async function disable(paths: Paths) {
  if (!(await readState(paths))) return;
  await withLock(paths, async () => {
    const state = await readState(paths);
    if (!state) return;
    await checkPlist(paths, state);
    await setCodexServiceEndpoint(state.configPath, state.port, false);
    await stopService();
    try {
      await privatePath(paths.socket, 'socket');
      await rm(paths.socket);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    await rm(paths.state);
    await rm(paths.plist);
  });
}

async function serve(paths: Paths) {
  const state = await readState(paths);
  if (!state) throw new Error('The Codex service is not registered.');
  if (Buffer.byteLength(paths.socket) > 103)
    throw new Error('The Codex review socket path is too long.');
  if (await canReview(paths.socket)) throw new Error('The Codex service is already listening.');
  const worktrees = new Map<string, string>();
  for (const root of state.worktrees) {
    try {
      if ((await reviewRepository(root)) === root) worktrees.set(root, await ensureRunsDir(root));
    } catch {
      // A removed worktree does not take down the relay used by other worktrees.
    }
  }
  const scratch = await mkdtemp(join(paths.directory, '.relay-'));
  let turns: Awaited<ReturnType<typeof openCodexWorktreeCapture>> | undefined;
  let proxy: Awaited<ReturnType<typeof createProxy>> | undefined;
  try {
    proxy = await createProxy({
      host: '127.0.0.1',
      port: state.port,
      retainExchanges: false,
      tls: {
        ca: await RunCa.create({ runDir: scratch }),
        hosts: [origin.host],
        directCodexOrigin: origin,
        passThroughWebSockets: true,
        onNetExchange: (exchange) => turns?.finish(exchange),
      },
      onRequestStart: (request) => turns?.start(request),
      onExchange: (exchange) => turns?.model(exchange),
    });
    // The HTTP port is bound before the private socket signals readiness.
    try {
      await privatePath(paths.socket, 'socket');
      await rm(paths.socket);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    turns = await openCodexWorktreeCapture(paths.socket, worktrees);
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        resolve();
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  } finally {
    try {
      await proxy?.close();
    } finally {
      await turns?.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export async function codexServiceCommand(
  action: string | undefined,
  cwd: string,
  configOption?: string,
) {
  if (configOption !== undefined && action !== 'register')
    throw new Error('--config is only for register.');
  if (action !== 'status' && action !== 'register' && action !== 'disable' && action !== 'serve')
    throw new Error('Use codex-service register, status, or disable.');
  if (process.platform !== 'darwin') {
    if (action === 'status') return { status: 'unsupported' as const };
    throw new Error('The Dock recorder service requires macOS.');
  }
  const paths = await servicePaths();
  if (action === 'serve') return serve(paths);
  if (action === 'register') await register(paths, cwd, configOption);
  if (action === 'disable') await disable(paths);
  const state = await readState(paths);
  if (!state) return { status: 'disabled' as const };
  const live = await canReview(paths.socket);
  const configured = await codexConfigStatus(state.configPath, state.port);
  return {
    status:
      configured !== 'owned'
        ? ('configuration_changed' as const)
        : live
          ? ('running' as const)
          : ('stopped' as const),
    socketPath: paths.socket,
    baseUrl: codexServiceBaseUrl(state.port),
    worktrees: state.worktrees,
  };
}

export async function managedDesktopSocket(root: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return;
  const paths = await servicePaths();
  const state = await readState(paths);
  if (!state || state.configPath !== codexProfile()) return;
  if ((await codexConfigStatus(state.configPath, state.port)) !== 'owned') return;
  if (!state.worktrees.includes(root))
    throw new Error(
      'Register this worktree with codex-service register before recording with the active service.',
    );
  if (!(await canReview(paths.socket)))
    throw new Error(
      'The configured Codex service is stopped. Run codex-service register to restart it.',
    );
  return paths.socket;
}
