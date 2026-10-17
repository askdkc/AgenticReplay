import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeServer extends EventEmitter {
  listen(port: number, host: string, ready: () => void): this;
  address(): { port: number };
  close(done: () => void): this;
}

const state = vi.hoisted(() => ({
  mode: 'success' as 'success' | 'error' | 'throw',
  failure: new Error('owned fixture listen failure'),
  server: undefined as FakeServer | undefined,
}));

vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    createServer: () => {
      class Server extends EventEmitter {
        constructor() {
          super();
          // A test observer prevents an unhandled EventEmitter error from killing the runner;
          // the fixture still has to reject its own returned promise.
          this.on('error', () => {});
        }
        listen(_port: number, _host: string, ready: () => void) {
          if (state.mode === 'throw') throw state.failure;
          queueMicrotask(() => {
            if (state.mode === 'error') this.emit('error', state.failure);
            else ready();
          });
          return this;
        }
        address() {
          return { port: 49152 };
        }
        close(done: () => void) {
          queueMicrotask(done);
          return this;
        }
      }
      state.server = new Server();
      return state.server;
    },
  };
});

import { startFakeModel } from '../packages/cli/test/fixtures/fake-model.mjs';
import { startResponsesModel } from '../packages/cli/test/fixtures/responses-model.mjs';

beforeEach(() => {
  state.mode = 'success';
  state.failure = new Error('owned fixture listen failure');
  state.server = undefined;
});
afterEach(() => state.server?.removeAllListeners());

for (const [name, start] of [
  ['Anthropic fixture', startFakeModel],
  ['Responses fixture', startResponsesModel],
] as const) {
  describe(name, () => {
    it('resolves once listening and removes its temporary error handler', async () => {
      const model = await start();
      expect(model.url).toBe('http://127.0.0.1:49152');
      expect(state.server?.listenerCount('error')).toBe(1);
      await model.close();
    });

    it('rejects an asynchronous listen error instead of leaving setup pending', async () => {
      state.mode = 'error';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          start().then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          ),
          new Promise<{ kind: 'pending' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'pending' }), 50);
          }),
        ]);
        expect(result.kind).toBe('rejected');
        if (result.kind === 'rejected') expect(result.error).toBe(state.failure);
      } finally {
        clearTimeout(timer);
      }
    });

    it('preserves a synchronous listen exception', async () => {
      state.mode = 'throw';
      await expect(start()).rejects.toBe(state.failure);
    });
  });
}
