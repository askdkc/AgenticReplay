import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

/** A capture limit limits retention, never the request sent to the provider. */
export async function readRequestBody(
  req: IncomingMessage,
  limit: number,
  reserve: (bytes: number) => boolean,
  release: (bytes: number) => void,
): Promise<{
  buffer?: Buffer;
  stream?: ReadableStream<Uint8Array>;
  bytes: () => number;
  dispose: () => void;
}> {
  const chunks: Buffer[] = [];
  const iterator = req[Symbol.asyncIterator]();
  let bytes = 0;
  let reserved = 0;
  const dispose = () => {
    release(reserved);
    reserved = 0;
    chunks.length = 0;
  };
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) return { buffer: Buffer.concat(chunks), bytes: () => bytes, dispose };
      const chunk = next.value as Buffer;
      bytes += chunk.length;
      if (bytes <= limit && reserve(chunk.length)) {
        reserved += chunk.length;
        chunks.push(chunk);
        continue;
      }
      // Do not exit a for-await loop here: its implicit return() destroys IncomingMessage.
      // Hand the same iterator to fetch and stream the remainder with its backpressure.
      async function* forward(): AsyncGenerator<Buffer> {
        try {
          while (chunks.length > 0) {
            const prefix = chunks.shift()!;
            yield prefix;
            const held = Math.min(reserved, prefix.length);
            reserved -= held;
            release(held);
          }
          yield chunk;
          while (true) {
            const part = await iterator.next();
            if (part.done) return;
            const tail = part.value as Buffer;
            bytes += tail.length;
            yield tail;
          }
        } finally {
          dispose();
          await iterator.return?.();
        }
      }
      return {
        stream: Readable.toWeb(
          Readable.from(forward(), { objectMode: false, highWaterMark: 65536 }),
          {
            strategy: { highWaterMark: 65536, size: (chunk: Uint8Array) => chunk.byteLength },
          },
        ) as ReadableStream<Uint8Array>,
        bytes: () => bytes,
        dispose,
      };
    }
  } catch (error) {
    dispose();
    throw error;
  }
}
