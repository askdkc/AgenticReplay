import { randomBytes } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compactRun } from './compact.js';
import { listRuns } from './paths.js';

const MARKER = '.blob-compaction-v1.json';
const started = new Map<string, Promise<AutoCompactResult>>();
export interface AutoCompactResult {
  converted: number;
  savedBytes: number;
  failed: number;
}

/** One cooperative maintenance slice per workspace per process. No output or fatal errors. */
export function autoCompact(cwd: string): Promise<AutoCompactResult> {
  const existing = started.get(cwd);
  if (existing) return existing;
  const work = migrate(cwd).catch(() => ({ converted: 0, savedBytes: 0, failed: 1 }));
  started.set(cwd, work);
  return work;
}

async function migrate(cwd: string): Promise<AutoCompactResult> {
  const totals = { converted: 0, savedBytes: 0, failed: 0 };
  const deadline = Date.now() + 250;
  let processed = 0;
  for (const run of await listRuns(cwd)) {
    if (processed >= 4 || (processed > 0 && Date.now() >= deadline)) break;
    try {
      const manifestPath = join(run.dir, 'manifest.json');
      const info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const fingerprint = manifest.integrity?.events_sha256;
      if (!manifest.ended_at || typeof fingerprint !== 'string') continue;
      const marker = join(run.dir, MARKER);
      let after: string | undefined;
      try {
        const info = await lstat(marker);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 4096) {
          const state = JSON.parse(await readFile(marker, 'utf8'));
          if (state.eventsSha256 === fingerprint) {
            if (state.complete === true) continue;
            if (
              typeof state.cursor === 'string' &&
              /^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(state.cursor)
            )
              after = state.cursor;
          }
        }
      } catch {
        /* Missing or invalid checkpoints are retried from the raw files. */
      }
      processed++;
      const result = await compactRun(run.dir, false, {
        ...(after ? { after } : {}),
        deadline,
        maxFiles: 8,
        maxInputBytes: 64 * 1024 * 1024,
      });
      totals.converted += result.converted;
      totals.savedBytes += result.savedBytes;
      if (result.reason) continue;
      const temporary = `${marker}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            eventsSha256: fingerprint,
            complete: !result.pending,
            cursor: result.cursor ?? after,
          }),
          { mode: 0o600, flag: 'wx' },
        );
        await rename(temporary, marker);
      } finally {
        await rm(temporary, { force: true });
      }
    } catch {
      totals.failed++;
    }
  }
  return totals;
}
