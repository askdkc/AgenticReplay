import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvent } from '@agenticreplay/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blobs.js';

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agenticreplay-blobs-'));
  store = new BlobStore(join(dir, 'blobs'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every file under the blob root, relative to it. */
async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const shards = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const f of await readdir(join(root, shard.name))) out.push(`${shard.name}/${f}`);
  }
  return out.sort();
}

describe('BlobStore.put', () => {
  it('returns a spec-shaped ref with the sha256 of the content', async () => {
    const ref = await store.put('hello');
    // sha256('hello')
    expect(ref.$blob).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(ref.bytes).toBe(5);
    expect(ref.media_type).toBeUndefined();
  });

  it('produces a ref the event schema accepts as a payload', async () => {
    const ref = await store.put('hello', 'text/plain');
    const r = validateEvent({
      seq: 0,
      ts: '2026-08-29T10:00:00.000Z',
      mono_us: 0,
      turn: 0,
      type: 'note',
      actor: 'agenticreplay',
      payload: ref,
    });
    expect(r.valid, r.errors.join(',')).toBe(true);
  });

  it('shards by the first two hex chars of the digest (spec §2.2)', async () => {
    const ref = await store.put('hello');
    const hex = ref.$blob.slice('sha256:'.length);
    const files = await allFiles(join(dir, 'blobs'));
    expect(files).toEqual([`${hex.slice(0, 2)}/${hex}`]);
  });

  it('stores identical content once — this is what keeps a trace O(n), not O(n²)', async () => {
    const a = await store.put('the whole conversation, resent every turn');
    const b = await store.put('the whole conversation, resent every turn');
    expect(b.$blob).toBe(a.$blob);
    expect(await store.count()).toBe(1);
    expect(await allFiles(join(dir, 'blobs'))).toHaveLength(1);
  });

  it('does not rewrite a blob that already exists', async () => {
    const ref = await store.put('immutable');
    const hex = ref.$blob.slice('sha256:'.length);
    const path = join(dir, 'blobs', hex.slice(0, 2), hex);
    const before = await stat(path);
    await new Promise((r) => setTimeout(r, 12));
    await store.put('immutable');
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps distinct content in distinct files', async () => {
    const a = await store.put('one');
    const b = await store.put('two');
    expect(a.$blob).not.toBe(b.$blob);
    expect(await store.count()).toBe(2);
  });

  it('counts bytes, not characters, for multi-byte strings', async () => {
    const ref = await store.put('héllo 🐳');
    expect(ref.bytes).toBe(Buffer.byteLength('héllo 🐳', 'utf8'));
  });

  it('records the media type when given', async () => {
    const ref = await store.put(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(ref.media_type).toBe('application/octet-stream');
    expect(ref.bytes).toBe(3);
  });

  // POSIX only. Windows has no mode bits: `chmod 0o600` is a no-op on NTFS and `stat` answers
  // 0o666 whatever was asked for, so this asserts something the platform cannot provide. Skipped
  // rather than loosened — the guarantee is real where it can be made, and a test that accepted
  // 0o666 would stop noticing if it were lost on Linux too.
  it.skipIf(process.platform === 'win32')(
    'writes blobs unreadable by other users — a trace is sensitive material',
    async () => {
      const ref = await store.put('secret-ish');
      const hex = ref.$blob.slice('sha256:'.length);
      const s = await stat(join(dir, 'blobs', hex.slice(0, 2), hex));
      expect(s.mode & 0o777).toBe(0o600);
    },
  );

  it('stores an empty blob', async () => {
    const ref = await store.put('');
    expect(ref.bytes).toBe(0);
    expect(await store.count()).toBe(1);
    expect(await store.get(ref)).toEqual(new Uint8Array());
  });
});

describe('BlobStore.get', () => {
  it('round-trips binary content exactly', async () => {
    const data = new Uint8Array([0, 1, 254, 255, 10, 13]);
    const ref = await store.put(data);
    expect(await store.get(ref)).toEqual(data);
  });

  it('round-trips utf-8 text', async () => {
    const ref = await store.put('héllo 🐳');
    expect(Buffer.from(await store.get(ref)).toString('utf8')).toBe('héllo 🐳');
  });

  it('accepts a prefixed digest string as well as a ref', async () => {
    const ref = await store.put('by digest');
    expect(await store.get(ref.$blob)).toEqual(await store.get(ref));
  });

  it('accepts a bare hex digest', async () => {
    const ref = await store.put('bare hex');
    expect(await store.get(ref.$blob.slice('sha256:'.length))).toEqual(await store.get(ref));
  });

  it('throws an error naming the digest when the blob is missing', async () => {
    const missing = `sha256:${'a'.repeat(64)}`;
    await expect(store.get(missing)).rejects.toThrow(/a{64}/);
  });

  it('rejects a malformed digest rather than reading an arbitrary path', async () => {
    await expect(store.get('sha256:../../etc/passwd')).rejects.toThrow(/digest/i);
  });
});

describe('BlobStore.has / count', () => {
  it('reports presence by digest, with or without the prefix', async () => {
    const ref = await store.put('present');
    expect(await store.has(ref.$blob)).toBe(true);
    expect(await store.has(ref.$blob.slice('sha256:'.length))).toBe(true);
    expect(await store.has(`sha256:${'b'.repeat(64)}`)).toBe(false);
  });

  it('counts zero for a store that has never been written to', async () => {
    expect(await store.count()).toBe(0);
    expect(await store.has(`sha256:${'c'.repeat(64)}`)).toBe(false);
  });

  it('counts blobs across shards', async () => {
    for (let i = 0; i < 25; i++) await store.put(`content ${i}`);
    expect(await store.count()).toBe(25);
  });
});

describe('compressed storage', () => {
  it('compresses large blobs, preserving the raw hash, length, permissions and deduplication', async () => {
    const { createHash } = await import('node:crypto');
    const { gunzipSync } = await import('node:zlib');
    const { readFile } = await import('node:fs/promises');
    const input = '日本語 conversation '.repeat(10000);
    const ref = await store.put(input);
    const digest = createHash('sha256').update(input).digest('hex');
    expect(ref.$blob).toBe(`sha256:${digest}`);
    expect(ref.bytes).toBe(Buffer.byteLength(input));
    const path = join(store.dir, digest.slice(0, 2), `${digest}.gz`);
    const packed = await readFile(path);
    expect(packed.length).toBeLessThan(ref.bytes / 10);
    expect(gunzipSync(packed).toString()).toBe(input);
    expect(Buffer.from(await store.get(ref)).toString()).toBe(input);
    expect(await store.has(ref)).toBe(true);
    const before = await stat(path);
    await store.put(input);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await store.count()).toBe(1);
    if (process.platform !== 'win32') expect(before.mode & 0o777).toBe(0o600);
  });

  it('retains incompressible data and legacy blobs without rewriting', async () => {
    const { randomBytes } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    const input = randomBytes(8192);
    const ref = await store.put(input);
    expect((await allFiles(store.dir))[0]).not.toMatch(/\.gz$/);
    expect(Buffer.from(await store.get(ref))).toEqual(input);
    // A legacy large blob at its original digest must win over compression.
    const legacy = await store.put('small');
    const hex = legacy.$blob.slice(7);
    await writeFile(join(store.dir, hex.slice(0, 2), hex), 'small');
    expect(await store.put('small')).toEqual(legacy);
  });

  it('enforces stored-byte limits at the boundary, across reopen and concurrent puts', async () => {
    const limited = new BlobStore(store.dir, 5);
    await limited.put('hello');
    await expect(limited.put('!')).rejects.toThrow(/limit/);
    await expect(new BlobStore(store.dir, 5).put('!')).rejects.toThrow(/limit/);
    expect(await limited.put('hello')).toBeDefined();
    const concurrent = new BlobStore(join(dir, 'concurrent'), 5);
    const results = await Promise.allSettled([concurrent.put('aaaa'), concurrent.put('bbbb')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const compressed = new BlobStore(join(dir, 'compressed'), 100);
    await compressed.put('x'.repeat(10000));
    expect(await compressed.count()).toBe(1);
  });

  it('bounds decompression and rejects corrupt gzip without treating it as missing', async () => {
    const { readBlobFile } = await import('../src/blobs.js');
    const { writeFile } = await import('node:fs/promises');
    const ref = await store.put('x'.repeat(10000));
    const hex = ref.$blob.slice(7);
    const path = join(store.dir, hex.slice(0, 2), `${hex}.gz`);
    expect((await readBlobFile(path, 10000)).length).toBe(10000);
    await expect(readBlobFile(path, 9999)).rejects.toThrow();
    await writeFile(path, 'broken gzip');
    await expect(store.get(ref)).rejects.not.toThrow(/not found/);
  });
});
