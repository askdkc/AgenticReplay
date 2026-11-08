import { randomBytes } from 'node:crypto';
import { openTurnStore, type TurnReceipt } from './codex-turn-store.js';
import { createServer, type Socket } from 'node:net';
import { chmod, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { TraceWriter, captureDirectoryName } from '@agenticreplay/core';
import {
  codexDialect,
  type NetExchange,
  type NetRequest,
  type RecordedExchange,
} from '@agenticreplay/proxy';
import {
  appendDerivedEvents,
  appendObservedToolResults,
  ExchangeEventDeriver,
} from './exchange-events.js';
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

const codexRequest = codexDialect().toCanonicalRequest;

function readUnpromotedRequest(exchange: NetExchange) {
  if (exchange.modelDialect || exchange.requestTruncated || !exchange.requestBody) return;
  try {
    return codexRequest(JSON.parse(exchange.requestBody));
  } catch {
    // Keep opaque or partial bodies in the network trace.
  }
}

type TurnOutcome = 'completed' | 'interrupted';

interface CapturedTurn {
  key: string;
  completion?: TurnOutcome;
  receipt: TurnReceipt;
  intentWrites: number;
  endOutcome?: TurnOutcome;
  root: string;
  open: Set<string>;
  awaitingModel: Set<string>;
  writer: Promise<TraceWriter>;
  writerFailed: boolean;
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
  const store = await openTurnStore(
    join(parent, '.codex-turns-' + basename(socketPath)),
    worktrees,
  );
  const turns = new Map<string, CapturedTurn>();
  const attempts = new Map<string, CapturedTurn>();
  const settled = new Map<
    string,
    { root?: string; outcome?: TurnOutcome; result: Promise<string | null> }
  >();
  const sealing = new Set<Promise<string | null>>();
  const sockets = new Set<Socket>();
  let modelExchanges = 0;
  let completeTurns = 0;
  let buffered = 0;
  let closing: Promise<{ modelExchanges: number; completeTurns: number }> | undefined;

  function remember(
    key: string,
    root: string | undefined,
    result: Promise<string | null>,
    outcome?: TurnOutcome,
  ) {
    settled.set(key, {
      ...(root === undefined ? {} : { root }),
      ...(outcome ? { outcome } : {}),
      result,
    });
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
    const writer = turn.writer;
    turn.writes = turn.writes
      .then(async () => write(await writer))
      .catch(() => {
        turn.broken = true;
      })
      .finally(() => {
        buffered -= bytes;
      });
  };
  const seal = (key: string, turn: CapturedTurn): Promise<string | null> => {
    if (turn.sealed) return turn.sealed;
    const result = (async () => {
      await turn.writes;
      const writer = await turn.writer;
      const complete =
        turn.completion === 'completed' &&
        !turn.broken &&
        !turn.needsContinuation &&
        turn.open.size === 0 &&
        turn.awaitingModel.size === 0 &&
        turn.exchanges > 0;
      writer.setCaptureSummary({
        status: complete ? 'complete' : 'incomplete',
        issues: complete
          ? []
          : [
              turn.completion === 'interrupted'
                ? 'codex_turn_interrupted'
                : 'codex_capture_incomplete',
            ],
      });
      if (!writer.hasEnded) {
        await writer.append({
          type: 'run.end',
          actor: 'agenticreplay',
          attrs: { outcome: turn.completion ?? 'unknown' },
        });
        turn.endOutcome = turn.completion;
      }
      const manifest = await writer.close();
      const receipt: TurnReceipt = {
        ...turn.receipt,
        state: 'finalized',
        outcome: turn.completion!,
        capture: manifest.capture?.status === 'complete' ? 'complete' : 'incomplete',
        runDir: writer.runDir,
      };
      await store.save(receipt);
      turn.receipt = receipt;
      for (const [id, owner] of attempts) if (owner === turn) attempts.delete(id);
      turns.delete(key);
      if (receipt.capture === 'complete') completeTurns++;
      return receipt.capture === 'complete' ? writer.runDir : null;
    })();
    // Keep a failed turn retryable. Receipt publication, not acceptance, is the commit point.
    turn.sealed = result.catch(() => {
      turn.broken = true;
      turn.sealed = undefined;
      return null;
    });
    sealing.add(turn.sealed);
    const pending = turn.sealed;
    void pending.then(() => sealing.delete(pending));
    return turn.sealed;
  };

  const finishNotifiedTurn = (turn: CapturedTurn) => {
    if (
      turn.completion &&
      turn.intentWrites === 0 &&
      turn.open.size === 0 &&
      turn.awaitingModel.size === 0
    )
      void seal(turn.key, turn);
  };

  function activate(receipt: TurnReceipt, recovered: boolean): CapturedTurn {
    const turn: CapturedTurn = {
      key: receipt.key,
      root: receipt.root,
      receipt,
      intentWrites: 0,
      ...(receipt.outcome ? { completion: receipt.outcome } : {}),
      open: new Set(),
      awaitingModel: new Set(),
      deriver: new ExchangeEventDeriver(),
      writer: Promise.resolve(undefined as never),
      writerFailed: false,
      writes: Promise.resolve(),
      exchanges: 0,
      broken: recovered,
      needsContinuation: false,
    };
    initializeWriter(turn, recovered);

    turns.set(receipt.key, turn);
    return turn;
  }

  function initializeWriter(turn: CapturedTurn, recovered: boolean): void {
    const receipt = turn.receipt;
    turn.writerFailed = false;
    turn.writer = (async () => {
      await store.save(receipt);
      const writer = await TraceWriter.create(
        worktrees.get(receipt.root)!,
        {
          runId: receipt.runId,
          sessionStartedAt: new Date(receipt.createdAt),
          sessionTitle: 'Codex turn',
          cwd: receipt.root,
          argv: [],
          envAllowlist: [],
          adapter: { id: 'codex-desktop-api' },
          agenticreplayVersion: AGENTICREPLAY_VERSION,
        },
        recovered
          ? {
              onEvent: (event) => {
                turn.deriver.restore(event);
                if (event.type === 'model.response') turn.exchanges++;
                if (
                  event.type === 'run.end' &&
                  (event.attrs?.outcome === 'completed' || event.attrs?.outcome === 'interrupted')
                )
                  turn.endOutcome = event.attrs.outcome;
              },
            }
          : undefined,
      );
      if (writer.seq === 0) {
        if (recovered) writer.markCaptureIncomplete('recorder_restarted_before_capture');
        const [sessionId, turnId] = JSON.parse(receipt.key) as [string, string];
        try {
          await writer.append({
            type: 'run.start',
            actor: 'agenticreplay',
            attrs: { source: 'codex-desktop-api', sessionId, turnId },
          });
        } catch (error) {
          await writer.suspend();
          throw error;
        }
      }
      return writer;
    })();
    void turn.writer.catch(() => {
      turn.broken = true;
      turn.writerFailed = true;
    });
  }

  function retryInitialization(turn: CapturedTurn): void {
    if (turn.writerFailed) {
      // Hydration may have failed halfway through. Rebuild derived state exactly once.
      turn.deriver = new ExchangeEventDeriver();
      turn.exchanges = 0;
      initializeWriter(turn, true);
    }
  }

  // Only this version's claims are recoverable. Historical traces are never migrated.
  async function recoverPendingCompletions(): Promise<void> {
    for (const receipt of store.receipts.values()) {
      if (closing || receipt.version !== 2 || receipt.state !== 'active' || !receipt.outcome)
        continue;
      if (!turns.has(receipt.key)) activate(receipt, true);
    }
    // Host proof received in this process remains work even when its first save failed.
    // Never replace a newer in-memory interruption with an older persisted outcome.
    for (const turn of turns.values()) {
      if (closing || !turn.completion || turn.sealed || turn.intentWrites) continue;
      retryInitialization(turn);
      if (store.receipts.get(turn.key)?.outcome !== turn.completion) {
        if (!(await persistCompletion(turn, turn.completion))) continue;
      }
      if (!turn.open.size && !turn.awaitingModel.size && !turn.intentWrites)
        await seal(turn.key, turn);
    }
  }

  async function persistCompletion(turn: CapturedTurn, outcome: TurnOutcome): Promise<boolean> {
    turn.completion = outcome;
    turn.receipt = { ...turn.receipt, outcome };
    turn.intentWrites++;
    try {
      await store.save(turn.receipt);
      return true;
    } catch {
      return false;
    } finally {
      turn.intentWrites--;
    }
  }

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
          (request?.action !== undefined && request.action !== 'finish') ||
          (request?.action === 'finish' &&
            request.outcome !== 'completed' &&
            request.outcome !== 'interrupted') ||
          typeof request?.cwd !== 'string' ||
          !worktrees.has(request.cwd) ||
          !identifier(request.sessionId) ||
          !identifier(request.turnId)
        )
          return { status: 'unavailable' };
        const key = JSON.stringify([request.sessionId, request.turnId]);
        if (settled.has(key)) return { status: 'unavailable' };
        const receipt = store.receipts.get(key);
        if (receipt && receipt.root !== request.cwd) return { status: 'unavailable' };
        const outcome: TurnOutcome =
          request.action === 'finish' ? (request.outcome as TurnOutcome) : 'completed';
        const reply = (r: TurnReceipt) =>
          request.action === 'finish'
            ? r.outcome === outcome
              ? { status: 'finalized', capture: r.capture }
              : { status: 'unavailable' }
            : r.capture === 'complete'
              ? { status: 'sealed', traceDirectory: r.runDir }
              : { status: 'unavailable' };
        if (receipt?.state === 'finalized') return reply(receipt);
        if (receipt?.version === 1) return { status: 'unavailable' };
        let turn = turns.get(key);
        if (!turn && receipt) turn = activate(receipt, true);
        if (!turn) return { status: 'pending' };
        if (turn.root !== request.cwd) return { status: 'unavailable' };
        retryInitialization(turn);
        try {
          await turn.writer;
        } catch {
          // A failed initializer must not discard host proof that can still be saved.
          if (
            request.action === 'finish' &&
            (!turn.endOutcome || turn.endOutcome === outcome) &&
            (turn.completion !== 'interrupted' || outcome === 'interrupted')
          )
            await persistCompletion(turn, outcome);
          return { status: 'pending' };
        }
        if (turn.endOutcome && turn.endOutcome !== outcome) return { status: 'unavailable' };
        if (turn.completion === 'interrupted' && outcome !== 'interrupted')
          return { status: 'unavailable' };
        if (turn.sealed) {
          await turn.sealed;
          const final = store.receipts.get(key);
          return final?.state === 'finalized' ? reply(final) : { status: 'pending' };
        }
        // Legacy review calls carry host-verified completion but cannot end a tool continuation.
        if (
          request.action === undefined &&
          (turn.open.size || turn.awaitingModel.size || (!turn.broken && turn.needsContinuation))
        )
          return { status: 'pending' };
        if (!(await persistCompletion(turn, outcome))) return { status: 'pending' };
        if (turn.open.size || turn.awaitingModel.size || turn.intentWrites)
          return { status: 'pending' };
        await seal(key, turn);
        const final = store.receipts.get(key);
        return final?.state === 'finalized' ? reply(final) : { status: 'pending' };
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
  let recovering = recoverPendingCompletions();
  let recoveryRunning = true;
  void recovering.finally(() => {
    recoveryRunning = false;
  });
  const recoveryTimer = setInterval(() => {
    if (closing || recoveryRunning) return;
    recoveryRunning = true;
    recovering = recoverPendingCompletions().finally(() => {
      recoveryRunning = false;
    });
  }, 1000);
  recoveryTimer.unref();
  return {
    start(request: NetRequest) {
      if (closing || (options.requireWorkspace && request.codexWarmup)) return;
      const identity = turnIdentity(request);
      if (!identity) return;
      const { sessionId, turnId, workspaces } = identity;
      const key = JSON.stringify([sessionId, turnId]);
      if (settled.has(key) || store.receipts.get(key)?.state === 'finalized') return;
      if (store.receipts.get(key)?.version === 1) return;
      let turn = turns.get(key);
      if (turn) retryInitialization(turn);
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
          // Never evict a live writer: a same-turn retry could otherwise open a second handle.
          remember(key, root, Promise.resolve(null));
          return;
        }
        const previous = store.receipts.get(key);
        if (previous && previous.root !== root) return;
        const runId = `run_${randomBytes(6).toString('hex')}`;
        const createdAt = new Date().toISOString();
        const receipt: TurnReceipt = previous ?? {
          version: 2,
          key,
          root,
          runId,
          createdAt,
          runDir: join(
            runsDir,
            captureDirectoryName(createdAt, 'codex-desktop-api', 'Codex turn', runId),
          ),
          state: 'active',
        };
        turn = activate(receipt, previous !== undefined);
      }
      if (turn.sealed) return;
      turn.open.add(request.requestId);
      turn.awaitingModel.add(request.requestId);
      attempts.set(request.requestId, turn);
    },
    model(exchange: RecordedExchange) {
      const id = exchange.requestId;
      if (!id) return;
      const turn = attempts.get(id);
      if (!turn || turn.sealed) return;
      turn.awaitingModel.delete(id);
      if (!turn.open.has(id)) attempts.delete(id);
      modelExchanges++;
      if (options.requireWorkspace) {
        turn.needsContinuation = exchange.canonicalResponse?.stop_reason === 'tool_use';
        if (!exchange.canonicalResponse || exchange.canonicalResponse.stop_reason === 'error')
          turn.broken = true;
      }
      enqueue(
        turn,
        async (writer) => {
          await appendDerivedEvents(writer, turn.deriver, exchange, ++turn.exchanges);
        },
        Buffer.byteLength(exchange.rawRequest) + Buffer.byteLength(exchange.rawResponse),
      );
      finishNotifiedTurn(turn);
    },
    finish(exchange: NetExchange) {
      const turn = attempts.get(exchange.requestId);
      if (!turn || turn.sealed) return;
      if (!exchange.modelDialect) turn.awaitingModel.delete(exchange.requestId);
      if (!turn.awaitingModel.has(exchange.requestId)) attempts.delete(exchange.requestId);
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
      enqueue(
        turn,
        async (writer) => {
          try {
            const request = readUnpromotedRequest(exchange);
            if (request)
              await appendObservedToolResults(writer, turn.deriver, request, turn.exchanges + 1);
          } finally {
            await persistNetExchange(writer, turn.exchanges, exchange);
          }
        },
        Buffer.byteLength(exchange.requestBody) + Buffer.byteLength(exchange.responseBody),
      );
      finishNotifiedTurn(turn);
    },
    close() {
      return (closing ??= (async () => {
        clearInterval(recoveryTimer);
        await recovering;
        for (const connection of sockets) connection.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const [key, turn] of turns) {
          await turn.writes;
          if (turn.completion) {
            if (turn.open.size || turn.awaitingModel.size) turn.broken = true;
            await seal(key, turn);
          } else {
            try {
              await (await turn.writer).suspend();
            } catch {
              /* The active receipt remains recoverable. */
            }
          }
        }
        await Promise.all(sealing);
        return { modelExchanges, completeTurns };
      })());
    },
  };
}
