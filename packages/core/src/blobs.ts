import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobRef } from '@agenticreplay/schema';

/** Traces are sensitive material (design §7), so nothing is group- or world-readable. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const HEX64 = /^[0-9a-f]{64}$/;
const PREFIX = 'sha256:';
const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const BLOB_FILE_NAME = /^[0-9a-f]{64}(?:\.gz)?$/;
export class BlobLimitError extends Error {}

export async function encodeBlob(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; suffix: string }> {
  if (bytes.byteLength >= 4096) {
    const packed = await compress(bytes);
    if (packed.length < bytes.byteLength) return { bytes: packed, suffix: '.gz' };
  }
  return { bytes, suffix: '' };
}

/** Read a known storage path; bound both stored input and expanded output. */
export async function readBlobFile(path: string, maxBytes = MAX_BLOB_BYTES): Promise<Buffer> {
  const limit = Math.min(maxBytes, MAX_BLOB_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid blob read limit');
  if ((await stat(path)).size > MAX_BLOB_BYTES) throw new BlobLimitError('stored blob too large');
  const stored = await readFile(path);
  const bytes = /\.gz(?:\.[0-9a-f]+\.tmp)?$/.test(path)
    ? await decompress(stored, { maxOutputLength: Math.max(1, limit) })
    : stored;
  if (bytes.length > limit) throw new BlobLimitError('expanded blob too large');
  return bytes;
}

/** Accepts `sha256:<hex>` or a bare hex digest and returns the bare hex. */
function bareDigest(ref: BlobRef | string): string {
  const raw = typeof ref === 'string' ? ref : ref.$blob;
  const hex = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
  if (!HEX64.test(hex)) throw new Error(`invalid blob digest: ${JSON.stringify(raw)}`);
  return hex;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : data;
}

/**
 * Content-addressed blob store, laid out as `<dir>/<first two hex>/<full hex>` (spec §2.2).
 *
 * Every model turn resends the whole conversation, so identical content arrives over and over.
 * Addressing by digest deduplicates identical content (not changing conversation prefixes) —
 * hence `put` of existing content must not touch the file at all.
 */
export class BlobStore {
  readonly #dir: string;
  readonly #maxStoredBytes: number;
  #tail: Promise<unknown> = Promise.resolve();
  #storedBytes: number | undefined;

  /** @param dir The blob root, conventionally `<runDir>/blobs`. */
  constructor(dir: string, maxStoredBytes = MAX_BLOB_BYTES) {
    if (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 0)
      throw new Error('invalid blob storage limit');
    this.#dir = dir;
    this.#maxStoredBytes = maxStoredBytes;
  }

  get dir(): string {
    return this.#dir;
  }

  async put(data: Uint8Array | string, mediaType?: string): Promise<BlobRef> {
    const result = this.#tail.then(() => this.#put(data, mediaType));
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #put(data: Uint8Array | string, mediaType?: string): Promise<BlobRef> {
    const bytes = toBytes(data);
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new BlobLimitError('expanded blob too large');
    const hex = createHash('sha256').update(bytes).digest('hex');
    const ref: BlobRef = { $blob: `${PREFIX}${hex}`, bytes: bytes.byteLength };
    if (mediaType !== undefined) ref.media_type = mediaType;

    const shard = join(this.#dir, hex.slice(0, 2));
    let path = join(shard, hex);
    if ((await exists(path)) || (await exists(`${path}.gz`))) return ref;
    const encoded = await encodeBlob(bytes);
    path += encoded.suffix;
    if (this.#storedBytes === undefined) {
      let total = 0;
      const shards = await readdir(this.#dir, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      for (const shard of shards) {
        if (!shard.isDirectory()) continue;
        for (const name of await readdir(join(this.#dir, shard.name))) {
          const info = await stat(join(this.#dir, shard.name, name));
          if (info.isFile()) total += info.size;
        }
      }
      this.#storedBytes = total;
    }
    if (this.#storedBytes + encoded.bytes.byteLength > this.#maxStoredBytes)
      throw new BlobLimitError('blob storage limit reached');

    await mkdir(shard, { recursive: true, mode: DIR_MODE });
    // Write then rename so a reader never sees a half-written blob under its final digest.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, encoded.bytes, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
      this.#storedBytes += encoded.bytes.byteLength;
    } finally {
      await rm(tmp, { force: true });
    }
    return ref;
  }

  async get(ref: BlobRef | string): Promise<Uint8Array> {
    const hex = bareDigest(ref);
    const path = join(this.#dir, hex.slice(0, 2), hex);
    let buf: Buffer;
    try {
      buf = await readBlobFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        buf = await readBlobFile(`${path}.gz`);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        throw new Error(`blob not found: ${PREFIX}${hex} (looked in ${path})`, { cause });
      }
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async has(digest: BlobRef | string): Promise<boolean> {
    const hex = bareDigest(digest);
    const path = join(this.#dir, hex.slice(0, 2), hex);
    return (await exists(path)) || (await exists(`${path}.gz`));
  }

  async count(): Promise<number> {
    let n = 0;
    for (const shard of await readdir(this.#dir, { withFileTypes: true }).catch(() => [])) {
      if (!shard.isDirectory()) continue;
      const files = await readdir(join(this.#dir, shard.name)).catch(() => []);
      n += new Set(files.filter((f) => BLOB_FILE_NAME.test(f)).map((f) => f.replace(/\.gz$/, '')))
        .size;
    }
    return n;
  }
}

/** SHA-256 of a whole file, streamed — this is the integrity root of a run (spec §6). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
