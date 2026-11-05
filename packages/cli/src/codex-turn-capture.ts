import { createServer, type Socket } from 'node:net';
import { chmod, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { TraceWriter } from '@agenticreplay/core';
import type { NetExchange, NetRequest, RecordedExchange } from '@agenticreplay/proxy';
import { appendDerivedEvents, ExchangeEventDeriver } from './exchange-events.js';
import { persistNetExchange } from './tls-capture.js';
import { AGENTICREPLAY_VERSION } from './version.js';

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{1,128}$/u.test(value);

function turnIdentity(request: NetRequest) {
  const pathname = request.path.split('?')[0];
  if (
    (request.method !== 'POST' && request.transport !== 'websocket') ||
    !['/v1/responses', '/responses', '/backend-api/codex/responses'].includes(pathname ?? '')
  )
    return;
  const value = request.requestHeaders['x-codex-turn-metadata'];
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const metadata = JSON.parse(value) as Record<string, unknown>;
    const session = metadata.thread_id ?? metadata.session_id;
    const thread =
      request.transport === 'websocket' ? undefined : request.requestHeaders['thread-id'];
    if (
      identifier(session) &&
      identifier(metadata.turn_id) &&
      (thread === undefined || thread === session)
    ) {
      const workspaces = metadata.workspaces;
      return {
        sessionId: session,
        turnId: metadata.turn_id,
        workspaces:
          workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)
            ? Object.keys(workspaces)
            : [],
      };
    }
  } catch {
    // Unknown metadata stays in the ordinary recording only.
  }
}

interface CapturedTurn {
  root: string;
  open: Set<string>;
  writer: Promise<TraceWriter>;
  deriver: ExchangeEventDeriver;
  writes: Promise<void>;
  exchanges: number;
  broken: boolean;
  needsContinuation: boolean;
  sealed?: Promise<string | null>;
}

export async function openCodexTurnCapture(
  socketPath: string,
  cwd: string,
  runsDir: string,
  options: { requireWorkspace?: boolean; maxBufferedBytes?: number } = {},
) {
  const root = await realpath(cwd);
  return openCapture(socketPath, new Map([[root, runsDir]]), options);
}

export async function openCodexWorktreeCapture(
  socketPath: string,
  worktrees: ReadonlyMap<string, string>,
) {
  return openCapture(socketPath, worktrees, { requireWorkspace: true, maxSettledTurns: 2048 });
}

async function openCapture(
  socketPath: string,
  worktrees: ReadonlyMap<string, string>,
  options: { requireWorkspace?: boolean; maxBufferedBytes?: number; maxSettledTurns?: number },
) {
  if (
    process.platform === 'win32' ||
    !isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > 103
  )
    throw new Error('Codex review requires an absolute Unix socket path.');
  const parent = dirname(socketPath);
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(parent)) !== parent
  )
    throw new Error('Codex review socket needs a private canonical directory.');
  const turns = new Map<string, CapturedTurn>();
  const attempts = new Map<string, CapturedTurn>();
  const settled = new Map<string, { root?: string; result: Promise<string | null> }>();
  const sealing = new Set<Promise<string | null>>();
  const sockets = new Set<Socket>();
  let modelExchanges = 0;
  let completeTurns = 0;
  let buffered = 0;
  let closing: Promise<{ modelExchanges: number; completeTurns: number }> | undefined;

  function remember(key: string, root: string | undefined, result: Promise<string | null>) {
    settled.set(key, { ...(root === undefined ? {} : { root }), result });
    if (options.maxSettledTurns !== undefined && settled.size > options.maxSettledTurns)
      settled.delete(settled.keys().next().value!);
  }

  const enqueue = (
    turn: CapturedTurn,
    write: (writer: TraceWriter) => Promise<void>,
    bytes = 0,
  ) => {
    if (buffered + bytes > (options.maxBufferedBytes ?? 256 * 1024 * 1024)) {
      turn.broken = true;
      return;
    }
    buffered += bytes;
    turn.writes = turn.writes
      .then(async () => write(await turn.writer))
      .catch(() => {
        turn.broken = true;
      })
      .finally(() => {
        buffered -= bytes;
      });
  };
  const seal = (key: string, turn: CapturedTurn) => {
    const result = (turn.sealed ??= (async () => {
      await turn.writes;
      for (const [id, owner] of attempts) if (owner === turn) attempts.delete(id);
      const writer = await turn.writer;
      const complete =
        !turn.broken && !turn.needsContinuation && turn.open.size === 0 && turn.exchanges > 0;
      writer.setCaptureSummary({
        status: complete ? 'complete' : 'incomplete',
        issues: complete ? [] : ['codex_capture_incomplete'],
      });
      await writer.append({ type: 'run.end', actor: 'agenticreplay' });
      await writer.close();
      if (complete) completeTurns++;
      return complete ? writer.runDir : null;
    })().catch(() => null));
    sealing.add(result);
    void result.then(() => sealing.delete(result));
    remember(key, turn.root, result);
    turns.delete(key);
    return result;
  };

  const server = createServer((connection) => {
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    let input = '';
    connection.setEncoding('utf8');
    connection.setTimeout(3000, () => connection.destroy());
    connection.on('error', () => {});
    connection.on('data', (chunk) => {
      input += chunk;
      if (input.length > 4096) {
        connection.pause();
        connection.end('{"status":"unavailable"}\n');
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      connection.pause();
      if (newline !== input.length - 1) {
        connection.end('{"status":"unavailable"}\n');
        return;
      }
      void (async () => {
        const request = JSON.parse(input) as Record<string, unknown> | null;
        if (
          typeof request?.cwd !== 'string' ||
          !worktrees.has(request.cwd) ||
          !identifier(request.sessionId) ||
          !identifier(request.turnId)
        )
          return { status: 'unavailable' };
        const key = JSON.stringify([request.sessionId, request.turnId]);
        const turn = turns.get(key);
        const previous = settled.get(key);
        if ((turn && turn.root !== request.cwd) || (previous && previous.root !== request.cwd))
          return { status: 'unavailable' };
        let result = previous?.result;
        if (turn && turn.open.size === 0 && (turn.broken || !turn.needsContinuation)) {
          result = seal(key, turn);
        }
        if (!result) return { status: 'pending' };
        const traceDirectory = await result;
        return traceDirectory ? { status: 'sealed', traceDirectory } : { status: 'unavailable' };
      })().then(
        (reply) => connection.end(JSON.stringify(reply) + '\n'),
        () => connection.end('{"status":"unavailable"}\n'),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    start(request: NetRequest) {
      if (closing || (options.requireWorkspace && request.codexWarmup)) return;
      const identity = turnIdentity(request);
      if (!identity) return;
      const { sessionId, turnId, workspaces } = identity;
      const key = JSON.stringify([sessionId, turnId]);
      if (settled.has(key)) return;
      let turn = turns.get(key);
      const root = options.requireWorkspace
        ? workspaces.length === 1
          ? workspaces[0]
          : undefined
        : worktrees.keys().next().value;
      const runsDir = root === undefined ? undefined : worktrees.get(root);
      if (root === undefined || runsDir === undefined || (turn && turn.root !== root)) {
        if (turn) turn.broken = true;
        else remember(key, undefined, Promise.resolve(null));
        return;
      }
      if (!turn) {
        if (turns.size >= 256) {
          const reusable = [...turns].find(([, previous]) => previous.open.size === 0);
          if (!reusable) {
            remember(key, root, Promise.resolve(null));
            return;
          }
          const [previousKey, previous] = reusable;
          void seal(previousKey, previous);
        }
        const writer = TraceWriter.create(runsDir, {
          cwd: root,
          argv: [],
          envAllowlist: [],
          adapter: { id: 'codex-desktop-api' },
          agenticreplayVersion: AGENTICREPLAY_VERSION,
        });
        turn = {
          root,
          writer,
          deriver: new ExchangeEventDeriver(),
          open: new Set(),
          writes: Promise.resolve(),
          exchanges: 0,
          broken: false,
          needsContinuation: false,
        };
        turns.set(key, turn);
        enqueue(turn, async (trace) => {
          await trace.append({
            type: 'run.start',
            actor: 'agenticreplay',
            attrs: { source: 'codex-desktop-api', sessionId, turnId },
          });
        });
      }
      if (turn.sealed) return;
      turn.open.add(request.requestId);
      attempts.set(request.requestId, turn);
    },
    model(exchange: RecordedExchange) {
      const id = exchange.requestId;
      if (!id) return;
      const turn = attempts.get(id);
      if (!turn || turn.sealed) return;
      if (!turn.open.has(id)) attempts.delete(id);
      const at = ++turn.exchanges;
      modelExchanges++;
      if (options.requireWorkspace) {
        turn.needsContinuation = exchange.canonicalResponse?.stop_reason === 'tool_use';
        if (!exchange.canonicalResponse || exchange.canonicalResponse.stop_reason === 'error')
          turn.broken = true;
      }
      enqueue(
        turn,
        async (writer) => {
          await appendDerivedEvents(writer, turn.deriver, exchange, at);
        },
        Buffer.byteLength(exchange.rawRequest) + Buffer.byteLength(exchange.rawResponse),
      );
    },
    finish(exchange: NetExchange) {
      const turn = attempts.get(exchange.requestId);
      if (!turn || turn.sealed) return;
      if (options.requireWorkspace || exchange.intercepted !== false)
        attempts.delete(exchange.requestId);
      if (!turn.open.delete(exchange.requestId)) turn.broken = true;
      if (options.requireWorkspace && exchange.codexTurnContinues) turn.needsContinuation = true;
      if (
        !exchange.responseComplete ||
        exchange.requestTruncated ||
        exchange.responseTruncated ||
        exchange.abandoned ||
        exchange.status === 0 ||
        exchange.status >= 400 ||
        (options.requireWorkspace && !exchange.modelDialect)
      )
        turn.broken = true;
      const at = turn.exchanges;
      enqueue(
        turn,
        async (writer) => persistNetExchange(writer, at, exchange),
        Buffer.byteLength(exchange.requestBody) + Buffer.byteLength(exchange.responseBody),
      );
    },
    close() {
      return (closing ??= (async () => {
        for (const connection of sockets) connection.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const [key, turn] of turns) seal(key, turn);
        await Promise.all(sealing);
        return { modelExchanges, completeTurns };
      })());
    },
  };
}
