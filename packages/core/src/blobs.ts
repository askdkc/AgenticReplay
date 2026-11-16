import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { BlobRef } from '@agenticreplay/schema';

/** Traces are sensitive material (design §7), so nothing is group- or world-readable. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const HEX64 = /^[0-9a-f]{64}$/;
const PREFIX = 'sha256:';
const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const BLOB_FILE_NAME = /^[0-9a-f]{64}(?:\.gz|\.delta)?$/;
export const TEMPORARY_DELTA_FILE_NAME = /^[0-9a-f]{64}\.delta\.[0-9a-f]+\.tmp$/;
const DELTA_HEADER_BYTES = 41;
const MIN_SHARED_BYTES = 4096;

export function blobFileDigest(name: string): string {
  return name.replace(/\.(?:gz|delta)$/, '');
}
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
  if (path.endsWith('.delta')) return readDelta(path, limit);
  const compressed = /\.gz(?:\.[0-9a-f]+\.tmp)?$/.test(path);
  if ((await stat(path)).size > (compressed ? MAX_BLOB_BYTES : limit))
    throw new BlobLimitError('stored blob too large');
  const stored = await readFile(path);
  const bytes = compressed
    ? await decompress(stored, { maxOutputLength: Math.max(1, limit) })
    : stored;
  if (bytes.length > limit) throw new BlobLimitError('expanded blob too large');
  return bytes;
}

function checkDeltaHeader(header: Buffer): void {
  if (header.length < DELTA_HEADER_BYTES || header[40]! > 1)
    throw new Error('invalid request blob delta header');
}

export async function readBlobDeltaBase(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(DELTA_HEADER_BYTES);
    const { bytesRead } = await handle.read(header);
    checkDeltaHeader(header.subarray(0, bytesRead));
    return header.subarray(0, 32).toString('hex');
  } finally {
    await handle.close();
  }
}

async function readFullBlob(path: string, maxBytes = MAX_BLOB_BYTES): Promise<Buffer> {
  try {
    return await readBlobFile(path, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readBlobFile(`${path}.gz`, maxBytes);
  }
}

/** Resolve a digest path in priority order, while keeping the expanded-byte budget. */
export async function readStoredBlob(path: string, maxBytes = MAX_BLOB_BYTES): Promise<Buffer> {
  try {
    return await readFullBlob(path, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readBlobFile(`${path}.delta`, maxBytes);
  }
}

async function readDelta(path: string, limit: number): Promise<Buffer> {
  if ((await stat(path)).size > MAX_BLOB_BYTES) throw new BlobLimitError('stored blob too large');
  const delta = await readFile(path);
  checkDeltaHeader(delta);
  const baseHex = delta.subarray(0, 32).toString('hex');
  const prefix = delta.readUInt32BE(32);
  const suffix = delta.readUInt32BE(36);
  const middleLimit = limit - prefix - suffix;
  if (middleLimit < 0) throw new BlobLimitError('expanded blob too large');
  const base = await readFullBlob(join(dirname(dirname(path)), baseHex.slice(0, 2), baseHex));
  if (prefix + suffix > base.length) throw new Error('invalid request blob delta range');
  const stored = delta.subarray(DELTA_HEADER_BYTES);
  const middle =
    delta[40] === 1
      ? await decompress(stored, { maxOutputLength: Math.max(1, middleLimit) })
      : stored;
  if (middle.length > middleLimit) throw new BlobLimitError('expanded blob too large');
  const bytes = Buffer.concat([
    base.subarray(0, prefix),
    middle,
    base.subarray(base.length - suffix),
  ]);
  if (createHash('sha256').update(bytes).digest('hex') !== blobFileDigest(basename(path)))
    throw new Error('request blob delta integrity mismatch');
  return bytes;
}

async function encodeDelta(
  bytes: Uint8Array,
  base: Buffer,
  baseHex: string,
): Promise<Buffer | undefined> {
  const max = Math.min(bytes.length, base.length);
  let prefix = 0;
  while (prefix < max && bytes[prefix] === base[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    bytes[bytes.length - suffix - 1] === base[base.length - suffix - 1]
  )
    suffix++;
  if (prefix + suffix < MIN_SHARED_BYTES) return;
  const middle = await encodeBlob(bytes.subarray(prefix, bytes.length - suffix));
  const header = Buffer.alloc(DELTA_HEADER_BYTES);
  header.write(baseHex, 0, 32, 'hex');
  header.writeUInt32BE(prefix, 32);
  header.writeUInt32BE(suffix, 36);
  header[40] = middle.suffix === '.gz' ? 1 : 0;
  return Buffer.concat([header, middle.bytes]);
}

/** Accepts `sha256:<hex>` or a bare hex digest and returns the bare hex. */
function bareDigest(ref: BlobRef | string): string {
  const raw = typeof ref === 'string' ? ref : ref.$blob;
  const hex = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
  if (!HEX64.test(hex)) throw new Error(`invalid blob digest: ${JSON.stringify(raw)}`);
  return hex;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

/**
 * Content-addressed blob store, laid out as `<dir>/<first two hex>/<full hex>` (spec §2.2).
 *
 * Addresses logical content by digest, regardless of its physical encoding.
 * Request deltas use a complete earlier request as a base, with no delta chains.
 */
export class BlobStore {
  readonly #dir: string;
  readonly #maxStoredBytes: number | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #storedBytes: number | undefined;
  #requestBase: string | undefined;

  /** Cumulative storage is unlimited by default; the per-blob read/write ceiling still applies. */
  constructor(dir: string, maxStoredBytes?: number) {
    if (
      maxStoredBytes !== undefined &&
      (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 0)
    )
      throw new Error('invalid blob storage limit');
    this.#dir = dir;
    this.#maxStoredBytes = maxStoredBytes;
  }

  get dir(): string {
    return this.#dir;
  }

  async put(data: Uint8Array | string, mediaType?: string): Promise<BlobRef> {
    const prepared = this.prepare(data, mediaType);
    await prepared.publish();
    return prepared.ref;
  }

  /** Compute the reference without publishing bytes, then keep new bytes only if commit succeeds. */
  prepare(
    data: Uint8Array | string,
    mediaType?: string,
    shareRequestHistory = false,
  ): {
    ref: BlobRef;
    publish: (commit?: () => Promise<void>) => Promise<void>;
  } {
    const bytes = toBytes(data);
    const hex = createHash('sha256').update(bytes).digest('hex');
    const ref: BlobRef = { $blob: `${PREFIX}${hex}`, bytes: bytes.byteLength };
    if (mediaType !== undefined) ref.media_type = mediaType;
    return {
      ref,
      publish: (commit) => {
        const result = this.#tail.then(() =>
          this.#publish(bytes, hex, shareRequestHistory, commit),
        );
        this.#tail = result.catch(() => undefined);
        return result;
      },
    };
  }

  async #publish(
    bytes: Uint8Array,
    hex: string,
    shareRequestHistory: boolean,
    commit?: () => Promise<void>,
  ): Promise<void> {
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new BlobLimitError('expanded blob too large');
    const shard = join(this.#dir, hex.slice(0, 2));
    let path = join(shard, hex);
    if (await this.has(hex)) {
      await commit?.();
      return;
    }
    let encoded = await encodeBlob(bytes);
    if (shareRequestHistory && this.#requestBase !== undefined) {
      const baseHex = this.#requestBase;
      // GC ignores open runs. A base published by this writer remains available until sealing.
      const base = await readFullBlob(join(this.#dir, baseHex.slice(0, 2), baseHex));
      const delta = await encodeDelta(bytes, base, baseHex);
      if (delta !== undefined && delta.length < encoded.bytes.length) {
        encoded = { bytes: delta, suffix: '.delta' };
      }
    }
    path += encoded.suffix;
    if (this.#maxStoredBytes !== undefined && this.#storedBytes === undefined) {
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
    if (
      this.#maxStoredBytes !== undefined &&
      this.#storedBytes! + encoded.bytes.byteLength > this.#maxStoredBytes
    )
      throw new BlobLimitError('blob storage limit reached');

    await mkdir(shard, { recursive: true, mode: DIR_MODE });
    // Write then rename so a reader never sees a half-written blob under its final digest.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, encoded.bytes, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    try {
      await commit?.();
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    if (this.#storedBytes !== undefined) this.#storedBytes += encoded.bytes.byteLength;
    if (shareRequestHistory && encoded.suffix !== '.delta') this.#requestBase = hex;
  }

  async get(ref: BlobRef | string): Promise<Uint8Array> {
    const hex = bareDigest(ref);
    const path = join(this.#dir, hex.slice(0, 2), hex);
    let buf: Buffer;
    try {
      buf = await readStoredBlob(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      throw new Error(`blob not found: ${PREFIX}${hex} (looked in ${path})`, { cause });
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async has(digest: BlobRef | string): Promise<boolean> {
    const hex = bareDigest(digest);
    const path = join(this.#dir, hex.slice(0, 2), hex);
    return (await exists(path)) || (await exists(`${path}.gz`)) || (await exists(`${path}.delta`));
  }

  async count(): Promise<number> {
    let n = 0;
    for (const shard of await readdir(this.#dir, { withFileTypes: true }).catch(() => [])) {
      if (!shard.isDirectory()) continue;
      const files = await readdir(join(this.#dir, shard.name)).catch(() => []);
      n += new Set(files.filter((f) => BLOB_FILE_NAME.test(f)).map(blobFileDigest)).size;
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
