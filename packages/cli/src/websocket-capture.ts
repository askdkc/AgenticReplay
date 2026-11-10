import { TraceWriter } from '@agenticreplay/core';
import type { WebSocketObservation } from '@agenticreplay/proxy';
import { persistWebSocketObservation } from './tls-capture.js';
import { AGENTICREPLAY_VERSION } from './version.js';

/** Service-owned storage: no workspace or turn is inferred from a connection. */
export function openWebSocketCapture(directory: string) {
  const connections = new Map<
    string,
    {
      writer?: TraceWriter;
      first: WebSocketObservation;
      initialized: boolean;
      tail: Promise<void>;
      failed: boolean;
    }
  >();
  let closing = false;
  return {
    write(observation: WebSocketObservation): Promise<void> {
      if (closing) return Promise.reject(new Error('WebSocket capture is closing'));
      let connection = connections.get(observation.connectionId);
      if (!connection) {
        connection = {
          first: { ...observation, payload: undefined },
          initialized: false,
          tail: Promise.resolve(),
          failed: false,
        };
        connections.set(observation.connectionId, connection);
      }
      const current = connection;
      const result = current.tail.then(async () => {
        if (!current.writer) {
          const first = current.first;
          const recovering = current.initialized;
          current.initialized = true;
          const writer = await TraceWriter.create(
            directory,
            {
              runId: 'run_' + first.connectionId.replaceAll('-', ''),
              sessionStartedAt: new Date(first.observedAt),
              sessionTitle: 'WebSocket connection',
              cwd: directory,
              argv: [],
              envAllowlist: [],
              adapter: { id: 'codex-websocket' },
              agenticreplayVersion: AGENTICREPLAY_VERSION,
            },
            recovering ? {} : undefined,
          );
          try {
            if (writer.seq === 0)
              await writer.append({
                type: 'run.start',
                actor: 'agenticreplay',
                attrs: { connection_id: first.connectionId, scope: 'connection' },
              });
          } catch (error) {
            await writer.suspend();
            throw error;
          }
          current.writer = writer;
        }
        const writer = current.writer;
        if (current.failed) {
          writer.markCaptureIncomplete('save_failed');
          await writer.append({
            type: 'note',
            actor: 'agenticreplay',
            attrs: {
              connection_id: observation.connectionId,
              reason: 'save_failed',
              capture_incomplete: true,
            },
          });
          current.failed = false;
        }
        await persistWebSocketObservation(writer, observation);
        if (observation.kind === 'close') {
          if (!writer.hasEnded)
            await writer.append({
              type: 'run.end',
              actor: 'agenticreplay',
              attrs: { outcome: 'connection_closed' },
            });
          writer.setCaptureSummary({ status: 'complete', issues: [] });
          await writer.close();
          connections.delete(observation.connectionId);
        }
      });
      current.tail = result.catch(() => {
        current.failed = true;
      });
      return result;
    },
    async close() {
      closing = true;
      let failure: unknown;
      for (const connection of connections.values()) {
        await connection.tail;
        try {
          const writer = connection.writer;
          if (!writer) {
            if (connection.failed) failure ??= new Error('WebSocket capture save_failed');
            continue;
          }
          if (connection.failed) writer.markCaptureIncomplete('save_failed');
          await writer.suspend();
        } catch (error) {
          failure ??= error;
        }
      }
      connections.clear();
      if (failure) throw failure;
    },
  };
}
