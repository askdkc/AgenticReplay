import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, open, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertManifest } from '@agenticreplay/schema';
import { encodeBlob, MAX_BLOB_BYTES, readBlobFile, sha256File } from './blobs.js';

export interface CompactResult {
  runDir: string;
  converted: number;
  savedBytes: number;
  skipped: number;
  reason?: string;
  cursor?: string;
  pending?: boolean;
  scanned?: number;
}

async function ordinary(path: string, directory = false): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error(`unsafe compaction path: ${path}`);
}

export interface CompactBudget {
  after?: string;
  deadline?: number;
  maxInputBytes?: number;
  maxFiles?: number;
}

/** Maintenance of sealed runs; callers must account for legacy direct-file readers. */
export async function compactRun(
  runDir: string,
  dryRun = false,
  budget: CompactBudget = {},
): Promise<CompactResult> {
  // Normalize system aliases such as macOS /var -> /private/var, but never a linked run.
  if ((await lstat(runDir)).isSymbolicLink()) throw new Error(`unsafe compaction path: ${runDir}`);
  runDir = await realpath(runDir);
  const result: CompactResult = { runDir, converted: 0, savedBytes: 0, skipped: 0 };
  await ordinary(runDir, true);
  const manifestPath = join(runDir, 'manifest.json');
  await ordinary(manifestPath);
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  assertManifest(manifest);
  if (!manifest.ended_at || !manifest.integrity?.events_sha256) {
    return { ...result, reason: 'run is not sealed' };
  }
  const eventsPath = join(runDir, 'events.jsonl');
  await ordinary(eventsPath);
  if ((await sha256File(eventsPath)) !== manifest.integrity.events_sha256)
    throw new Error('cannot compact a run with invalid event integrity');
  const root = join(runDir, 'blobs');
  try {
    await ordinary(root, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  let inputBytes = 0;
  let scanned = 0;
  for (const shard of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!/^[0-9a-f]{2}$/.test(shard.name)) continue;
    const shardDir = join(root, shard.name);
    await ordinary(shardDir, true);
    for (const name of (await readdir(shardDir)).sort()) {
      if (!/^[0-9a-f]{64}$/.test(name) || !name.startsWith(shard.name)) continue;
      const key = `${shard.name}/${name}`;
      if (budget.after && key <= budget.after) continue;
      if (
        scanned >= (budget.maxFiles ?? Infinity) ||
        inputBytes >= (budget.maxInputBytes ?? Infinity) ||
        (scanned > 0 && Date.now() >= (budget.deadline ?? Infinity))
      )
        return { ...result, scanned, pending: true };
      const source = join(shardDir, name);
      await ordinary(source);
      const before = await lstat(source);
      scanned++;
      result.scanned = scanned;
      result.cursor = key;
      if (before.size < 4096 || before.size > MAX_BLOB_BYTES) {
        result.skipped++;
        continue;
      }
      inputBytes += before.size;
      const bytes = await readBlobFile(source);
      if (createHash('sha256').update(bytes).digest('hex') !== name)
        throw new Error(`blob integrity mismatch: ${name}`);
      const encoded = await encodeBlob(bytes);
      if (!encoded.suffix) {
        result.skipped++;
        continue;
      }
      const target = `${source}.gz`;
      let existing = false;
      try {
        await ordinary(target);
        const decoded = await readBlobFile(target, bytes.length);
        if (!decoded.equals(bytes)) throw new Error(`compressed blob mismatch: ${name}`);
        existing = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!dryRun) {
        // No overwrite: concurrent compactors may publish the same verified bytes.
        const temporary = `${source}.gz.${randomBytes(6).toString('hex')}.tmp`;
        try {
          if (!existing) {
            const handle = await open(temporary, 'wx', 0o600);
            try {
              await handle.writeFile(encoded.bytes);
              await handle.sync();
            } finally {
              await handle.close();
            }
            if (!(await readBlobFile(temporary, bytes.length)).equals(bytes))
              throw new Error('compressed verification failed');
            try {
              await link(temporary, target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
          }
          await ordinary(target);
          if (!(await readBlobFile(target, bytes.length)).equals(bytes))
            throw new Error(`compressed blob mismatch: ${name}`);
          // Abort if another maintenance operation or writer changed the source/run.
          const now = await lstat(source);
          if (
            now.ino !== before.ino ||
            now.size !== before.size ||
            now.mtimeMs !== before.mtimeMs ||
            now.ctimeMs !== before.ctimeMs ||
            (await readFile(manifestPath, 'utf8')) !== manifestText
          )
            throw new Error('run changed during compaction');
          if (process.platform !== 'win32') {
            const directory = await open(shardDir, 'r');
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          }
          await unlink(source);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      result.converted++;
      result.savedBytes += existing ? before.size : before.size - encoded.bytes.byteLength;
    }
  }
  return result;
}
