import { compactRun, listRuns, resolveRunSelector, type CompactResult } from '@agenticreplay/core';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';

export async function compactCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<CompactResult[]> {
  const dryRun = args.bool('dry-run');
  const selector = args.positionals[0];
  const runs = selector ? [await resolveRunSelector(cwd, selector)] : await listRuns(cwd);
  const results: CompactResult[] = [];
  out.plain(
    dryRun
      ? 'dry run — no files changed'
      : 'compacting sealed runs; readers must support gzip blobs',
  );
  for (const run of runs) {
    const result = await compactRun(run.dir, dryRun);
    results.push(result);
    out.info('compact.run', { run: run.runId, ...result, dry_run: dryRun });
  }
  out.plain(
    `${results.reduce((n, r) => n + r.converted, 0)} blobs; ${results.reduce((n, r) => n + r.savedBytes, 0)} bytes ${dryRun ? 'reclaimable' : 'reclaimed'}`,
  );
  return results;
}
