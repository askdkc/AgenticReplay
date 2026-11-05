/**
 * Temporary Dock acceptance probe. Run from the Git worktree you want to record.
 * Requires a local build and the normal ChatGPT login. No launch agent or CA installation.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { TraceReader } from '../packages/core/dist/index.js';
import { createProxy, RunCa } from '../packages/proxy/dist/index.js';
import { openCodexTurnCapture } from '../packages/cli/dist/codex-turn-capture.js';
import { reviewRepository } from '../packages/cli/dist/review-store.js';

const exec = promisify(execFile);
const codexHome = join(homedir(), '.codex');
const config = join(codexHome, 'config.toml');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const origin = { host: 'chatgpt.com', port: 443 };
const endpoint = '/backend-api/codex';
const idPattern = /^[\w-]{1,128}$/u;

function failureCategories(details) {
  const categories = [
    [
      'store-policy',
      /(?:store.{0,50}(?:must|false|not supported)|(?:unsupported|unknown).{0,30}store)/iu,
    ],
    ['previous-response', /previous_response_id/iu],
    [
      'account-or-model',
      /(?:unsupported.model|model.{0,90}(?:does not exist|not supported|not available|not allowed)|account.{0,40}(?:not found|not active))/iu,
    ],
    ['authorization', /(?:unauthoriz|authentication|invalid.api.key|missing.authorization)/iu],
    [
      'request-shape',
      /(?:missing.required|invalid.request|invalid.type|unsupported.parameter|unknown.parameter|unexpected.field)/iu,
    ],
    [
      'websocket-protocol',
      /(?:invalid.event|unsupported.event|invalid.websocket|protocol.error)/iu,
    ],
  ];
  return categories.filter(([, pattern]) => pattern.test(details)).map(([name]) => name);
}

function runCodex(args, options) {
  const result = exec('codex', args, options);
  result.child.stdin?.end();
  return result;
}

const settingLine = (baseUrl) => Buffer.from('openai_base_url = ' + JSON.stringify(baseUrl) + '\n');

async function replaceConfig(file, bytes, mode, expectedHash) {
  const temporary = file + '.dock-probe-' + randomUUID();
  await writeFile(temporary, bytes, { mode, flag: 'wx' });
  try {
    if (sha256(await readFile(file)) !== expectedHash)
      throw new Error('Codex config changed while the probe was running.');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function enableConfig(directory, baseUrl, file = config) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('Codex config must be a regular file.');
  const before = await readFile(file);
  const source = before.toString('utf8');
  const topLevel = source.split(/^\s*\[/mu, 1)[0];
  if (
    !Buffer.from(source).equals(before) ||
    /^\s*(?:openai_base_url|"openai_base_url"|'openai_base_url')\s*=/mu.test(topLevel)
  )
    throw new Error('Codex config already sets openai_base_url or is not UTF-8.');
  const updated = Buffer.concat([settingLine(baseUrl), before]);
  const state = {
    original: sha256(before),
    active: sha256(updated),
    mode: info.mode & 0o777,
    baseUrl,
  };
  await writeFile(join(directory, 'original.toml'), before, { mode: 0o600, flag: 'wx' });
  await writeFile(join(directory, 'config-state.json'), JSON.stringify(state), {
    mode: 0o600,
    flag: 'wx',
  });
  await replaceConfig(file, updated, state.mode, state.original);
}

export async function restoreConfig(directory, file = config, previousBaseUrl) {
  const state = JSON.parse(await readFile(join(directory, 'config-state.json'), 'utf8'));
  const before = await readFile(join(directory, 'original.toml'));
  if (sha256(before) !== state.original) throw new Error('The probe backup failed its hash check.');
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('Codex config must be a regular file.');
  const current = await readFile(file);
  const currentHash = sha256(current);
  if (currentHash === state.original) return;
  if (currentHash === state.active) {
    await replaceConfig(file, before, state.mode, currentHash);
    return;
  }
  const baseUrl = state.baseUrl ?? previousBaseUrl;
  if (
    typeof baseUrl !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}\/backend-api\/codex$/u.test(baseUrl)
  )
    throw new Error(
      'Codex config changed. For an older probe, pass its READY URL after the recovery directory.',
    );
  const line = settingLine(baseUrl);
  if (sha256(Buffer.concat([line, before])) !== state.active)
    throw new Error('The recovery URL does not match the saved probe configuration.');
  if (!current.includes(Buffer.from(baseUrl))) return;
  const remaining = current.subarray(line.length);
  if (!current.subarray(0, line.length).equals(line) || remaining.includes(Buffer.from(baseUrl)))
    throw new Error('The probe setting itself changed. Reconcile it with original.toml.');
  await replaceConfig(file, remaining, info.mode & 0o777, currentHash);
}

async function codexCompletedTurn(sessionId, turnId) {
  if (!idPattern.test(sessionId) || !idPattern.test(turnId)) return false;
  const sessions = join(codexHome, 'sessions');
  const files = await readdir(sessions, { recursive: true }).catch(() => []);
  const candidates = files.filter((name) => name.endsWith('-' + sessionId + '.jsonl'));
  for (const name of candidates) {
    const lines = createInterface({
      input: createReadStream(join(sessions, name)),
      crlfDelay: Infinity,
    });
    let matchingSession = false;
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = record.payload;
      if (record.type === 'session_meta') {
        matchingSession =
          entry?.id === sessionId &&
          ['codex_work_desktop', 'Codex Desktop'].includes(entry.originator);
      }
      if (
        matchingSession &&
        record.type === 'event_msg' &&
        entry?.type === 'task_complete' &&
        entry.turn_id === turnId
      )
        return true;
    }
  }
  return false;
}

async function summarize(runs) {
  let verified = 0;
  for (const name of await readdir(runs)) {
    const reader = await TraceReader.open(join(runs, name));
    if (reader.manifest().capture?.status !== 'complete') continue;
    const digest = await reader.verifyIntegrity();
    const events = await reader.events();
    const { sessionId, turnId } = events.find((event) => event.type === 'run.start')?.attrs ?? {};
    if (!digest.ok || reader.problems().length || !sessionId || !turnId) continue;
    const pairs = [];
    for (const req of events) {
      if (req.type !== 'net.request' || req.attrs?.transport !== 'websocket') continue;
      const requestId = req.attrs.request_id;
      if (typeof requestId !== 'string') continue;
      const res = events.find(
        (event) =>
          event.type === 'net.response' &&
          event.attrs?.request_id === requestId &&
          event.attrs?.response_complete === true &&
          event.attrs?.transport_outcome === 'completed' &&
          event.causes?.includes(req.seq),
      );
      if (res) pairs.push(requestId);
    }
    if (!pairs.length) continue;
    const codexTurnComplete = await codexCompletedTurn(sessionId, turnId);
    if (codexTurnComplete) verified++;
    console.log(
      JSON.stringify({
        result: codexTurnComplete ? 'VERIFIED_DOCK_TURN' : 'TRACE_COMPLETE_CODEX_ROLLOUT_UNMATCHED',
        sessionId,
        turnId,
        requestIds: pairs,
        traceDirectory: reader.runDir,
        eventsSha256: digest.actual,
      }),
    );
  }
  console.log('VERIFIED_TURNS', verified);
}

async function run() {
  const root = await reviewRepository(process.cwd());
  const directory = await realpath(await mkdtemp('/tmp/ar-dock-live-'));
  const runs = join(directory, 'runs');
  await mkdir(runs, { mode: 0o700 });
  const turns = await openCodexTurnCapture(join(directory, 'review.sock'), root, runs, {
    requireWorkspace: true,
  });
  let active = false;
  let completedPreflight = false;
  let preflightTraffic;
  let ready = false;
  let timer;
  let restoring;
  let proxy;
  let input;
  const restore = async () => {
    if (!active) return;
    restoring ??= restoreConfig(directory)
      .then(() => {
        active = false;
        clearTimeout(timer);
        console.log('CONFIG_RESTORED. Reopen Codex from the Dock before stopping this relay.');
      })
      .finally(() => {
        restoring = undefined;
      });
    return restoring;
  };
  const reportError = (error) => console.error('PROBE_ERROR', error.message);
  const stop = () => input?.close();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);

  try {
    const ca = await RunCa.create({ runDir: directory });
    proxy = await createProxy({
      retainExchanges: false,
      tls: {
        ca,
        hosts: [origin.host],
        directCodexOrigin: origin,
        passThroughWebSockets: true,
        onNetExchange(exchange) {
          if (active) turns.finish(exchange);
          else if (preflightTraffic && exchange.path.split('?')[0].endsWith('/responses')) {
            preflightTraffic.push({
              transport: exchange.transport ?? 'http',
              status: exchange.status,
              complete: exchange.responseComplete,
              ...(!exchange.responseComplete && {
                failure: failureCategories(exchange.responseBody),
              }),
            });
          }
          if (
            !active &&
            exchange.transport === 'websocket' &&
            exchange.modelDialect &&
            exchange.responseComplete
          )
            completedPreflight = true;
        },
        onFailure: (failure) => console.error('RELAY_FAILURE', failure.kind),
      },
      onRequestStart: (request) => {
        if (active) turns.start(request);
      },
      onExchange: (exchange) => {
        if (active) turns.model(exchange);
      },
    });
    const baseUrl = proxy.url + endpoint;
    console.log('READY', baseUrl);
    console.log('WORKTREE', root);
    console.log('RECOVERY_DIRECTORY', directory);
    console.log(
      'Type preflight <model> to run a temporary CLI turn before enabling the Dock setting.',
    );
    input = createInterface({ input: process.stdin, output: process.stdout });
    input.on('SIGINT', stop);
    for await (const line of input) {
      try {
        const command = line.trim();
        const preflight = /^preflight(?: ([a-zA-Z0-9_.-]{1,100}))?$/u.exec(command);
        if (command === 'stop') break;
        if (command === 'restore') {
          await restore();
          continue;
        }
        if (preflight && !active) {
          ready = false;
          completedPreflight = false;
          preflightTraffic = [];
          let stage = 'login';
          try {
            const login = await runCodex(['login', 'status'], { cwd: root, timeout: 5000 });
            if (!/logged in using chatgpt/iu.test(login.stdout + login.stderr))
              throw new Error('ChatGPT login was not confirmed.');
            stage = 'turn';
            const result = await runCodex(
              [
                'exec',
                '--json',
                '--ephemeral',
                '--sandbox',
                'read-only',
                ...(preflight[1] ? ['--model', preflight[1]] : []),
                '-c',
                'openai_base_url=' + JSON.stringify(baseUrl),
                'Reply with only OK. Do not use tools.',
              ],
              { cwd: root, timeout: 45_000, maxBuffer: 1024 * 1024 },
            );
            ready =
              completedPreflight &&
              result.stdout.split('\n').some((line) => {
                try {
                  return JSON.parse(line).type === 'turn.completed';
                } catch {
                  return false;
                }
              });
          } catch (error) {
            const details = String(error.stderr ?? '') + String(error.stdout ?? '');
            const statuses = [
              ...new Set(details.match(/\b(?:400|401|403|404|429|500|502|503)\b/gu)),
            ];
            console.log(
              'PREFLIGHT_CLI_ERROR',
              JSON.stringify({
                stage,
                exit: error.code ?? null,
                signal: error.signal ?? null,
                statuses,
                failure: failureCategories(details),
              }),
            );
          }
          if (!ready) console.log('PREFLIGHT_TRAFFIC', JSON.stringify(preflightTraffic));
          preflightTraffic = undefined;
          console.log(
            ready
              ? 'PREFLIGHT_OK. Type enable to apply the temporary Dock setting.'
              : 'PREFLIGHT_FAILED. The Dock setting is still untouched. Type stop to exit.',
          );
        } else if (command === 'enable' && ready && !active) {
          await enableConfig(directory, baseUrl);
          active = true;
          ready = false;
          timer = setTimeout(() => {
            void restore().catch(reportError);
          }, 5 * 60_000);
          console.log('CONFIG_ENABLED. Quit Codex, reopen from the Dock and send one short turn.');
        } else
          console.log('Commands: preflight <model>, enable (after PREFLIGHT_OK), restore, stop.');
      } catch (error) {
        reportError(error);
      }
    }
  } finally {
    input?.close();
    for (const signal of signals) process.off(signal, stop);
    clearTimeout(timer);
    try {
      await restore();
    } catch (error) {
      reportError(error);
      process.exitCode = 1;
    }
    try {
      await proxy?.close();
    } finally {
      await turns.close();
    }
    await summarize(runs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory, previousBaseUrl] = process.argv.slice(2);
  const operation =
    command === 'restore' && directory
      ? restoreConfig(directory, config, previousBaseUrl).then(() => {
          console.log('CONFIG_RESTORED. Reopen Codex from the Dock.');
        })
      : !command
        ? run()
        : Promise.reject(
            new Error('Run with no arguments, or use restore <directory> [READY URL].'),
          );
  operation.catch((error) => {
    console.error('PROBE_ERROR', error.message);
    process.exitCode = 1;
  });
}
