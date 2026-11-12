import { assertTurnReceipt, type TurnReceipt as SharedTurnReceipt } from '@agenticreplay/schema';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, open, rename, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export interface TurnReceipt {
  version: 1 | 2;
  key: string;
  root: string;
  runId: string;
  runDir: string;
  createdAt: string;
  state: 'active' | 'finalized';
  outcome?: 'completed' | 'interrupted' | 'failed';
  requestIds?: string[];
  requestIdsTruncated?: boolean;
  receipt?: SharedTurnReceipt;
  capture?: 'complete' | 'incomplete';
}

/** Private lifecycle metadata, separate from immutable historical recordings. */
export async function openTurnStore(directory: string, worktrees: ReadonlyMap<string, string>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(directory)) !== directory
  )
    throw new Error('unsafe turn store');
  const receipts = new Map<string, TurnReceipt>();
  const filename = (key: string) => createHash('sha256').update(key).digest('hex') + '.json';
  for (const entry of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry)) continue;
    const file = join(directory, entry);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077) !== 0)
      throw new Error('unsafe turn receipt');
    const r = JSON.parse(await readFile(file, 'utf8')) as TurnReceipt;
    if (
      (r.version !== 1 && r.version !== 2) ||
      typeof r.key !== 'string' ||
      filename(r.key) !== entry ||
      !/^run_[a-f0-9]{6,32}$/u.test(r.runId) ||
      typeof r.runDir !== 'string' ||
      (r.requestIds !== undefined &&
        (!Array.isArray(r.requestIds) ||
          r.requestIds.length > 32 ||
          r.requestIds.some((id) => typeof id !== 'string' || !/^[\w-]{1,128}$/u.test(id)))) ||
      !['active', 'finalized'].includes(r.state) ||
      (r.outcome !== undefined &&
        r.outcome !== 'completed' &&
        r.outcome !== 'interrupted' &&
        r.outcome !== 'failed') ||
      (r.state === 'finalized' &&
        (!r.outcome || !['complete', 'incomplete'].includes(r.capture ?? '')))
    )
      throw new Error('invalid turn receipt');
    if (r.receipt !== undefined) {
      assertTurnReceipt(r.receipt);
      if (
        r.state !== 'finalized' ||
        r.receipt.source !== 'codex-runtime' ||
        JSON.stringify([r.receipt.sessionId, r.receipt.turnId]) !== r.key ||
        r.receipt.recording.runId !== r.runId ||
        r.receipt.recording.directory !== r.runDir ||
        r.receipt.outcome !== r.outcome ||
        r.receipt.capture !== r.capture
      )
        throw new Error('turn receipt identity mismatch');
    }
    const runs = worktrees.get(r.root);
    if (runs === undefined) continue;
    if (dirname(r.runDir) !== runs) throw new Error('turn receipt scope mismatch');
    receipts.set(r.key, r);
  }
  let writes = Promise.resolve();
  return {
    receipts,
    save(receipt: TurnReceipt): Promise<void> {
      const snapshot = structuredClone(receipt);
      if (snapshot.receipt) assertTurnReceipt(snapshot.receipt);
      const result = writes.then(async () => {
        const target = join(directory, filename(snapshot.key));
        const temporary = target + '.' + randomBytes(6).toString('hex') + '.tmp';
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify(snapshot));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
          const dir = await open(directory, 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
          receipts.set(snapshot.key, snapshot);
        } finally {
          await rm(temporary, { force: true });
        }
      });
      writes = result.catch(() => {});
      return result;
    },
  };
}
