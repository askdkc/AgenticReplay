import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readRequestBody } from '../src/request-body.js';

function budget(limit: number) {
  let used = 0;
  let peak = 0;
  return {
    reserve(bytes: number) {
      if (used + bytes > limit) return false;
      used += bytes;
      peak = Math.max(peak, used);
      return true;
    },
    release(bytes: number) {
      used -= bytes;
      expect(used).toBeGreaterThanOrEqual(0);
    },
    get used() {
      return used;
    },
    get peak() {
      return peak;
    },
  };
}

describe('request body retention', () => {
  it('charges concurrent captures as they arrive and streams overflow without retaining the tail', async () => {
    const pool = budget(12);
    const source = (chunks: string[]) =>
      Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as IncomingMessage;
    const first = await readRequestBody(source(['abcd']), 100, pool.reserve, pool.release);
    const second = await readRequestBody(
      source(['12345678', 'overflow', 'tail']),
      100,
      pool.reserve,
      pool.release,
    );
    expect(first.buffer?.toString()).toBe('abcd');
    expect(second.buffer).toBeUndefined();
    expect(await new Response(second.stream).text()).toBe('12345678overflowtail');
    expect(second.bytes()).toBe(20);
    expect(pool.peak).toBe(12);
    expect(pool.used).toBe(4);
    second.dispose();
    first.dispose();
    expect(pool.used).toBe(0);
  });

  it('releases a partial capture when the incoming request fails', async () => {
    const pool = budget(100);
    const req = Readable.from(
      (async function* () {
        yield Buffer.from('prefix');
        throw new Error('client disconnected');
      })(),
    ) as IncomingMessage;
    await expect(readRequestBody(req, 100, pool.reserve, pool.release)).rejects.toThrow(
      'client disconnected',
    );
    expect(pool.used).toBe(0);
  });

  it('bounds stream read-ahead and releases reservations when an overflow upload is cancelled', async () => {
    const pool = budget(65536);
    let produced = 0;
    let closed = false;
    const req = Readable.from(
      (async function* () {
        try {
          while (produced < 1000) {
            produced++;
            yield Buffer.alloc(32768);
          }
        } finally {
          closed = true;
        }
      })(),
      { objectMode: false, highWaterMark: 32768 },
    ) as IncomingMessage;
    const body = await readRequestBody(req, 65536, pool.reserve, pool.release);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced).toBeLessThan(12);
    await body.stream!.cancel();
    body.dispose();
    expect(closed).toBe(true);
    expect(pool.used).toBe(0);
  });
});
