import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  agenticreplayDir,
  assertPrivatePathIdentity,
  privatePathIdentity,
  resolveRunSelector,
  restrictToOwner,
  sha256File,
} from '@agenticreplay/core';
import type { RecordingReviewSource } from '@agenticreplay/plugin-api';
import { assertManifest, RUN_ID_PATTERN } from '@agenticreplay/schema';

const exec = promisify(execFile);
const hashPattern = /^[0-9a-f]{64}$/;

export async function reviewRepository(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: 3000,
    maxBuffer: 64 * 1024,
  }).catch(() => {
    throw new Error('Memory review requires a local Git repository.');
  });
  const repository = await realpath(stdout.replace(/\r?\n$/, ''));
  const fromRoot = relative(repository, await realpath(cwd));
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw new Error('The recording directory is outside its Git repository.');
  return repository;
}

export type ReviewEntry =
  | { state: 'queued' | 'empty' | 'preparation_failed' }
  | { state: 'awaiting_review' | 'declined'; digest: string };

export type StoredReview = ReviewEntry & { revision: number };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Write the complete next generation before atomically claiming its number. */
async function createOnce(dir: string, name: string, data: unknown): Promise<boolean> {
  const staged = join(dir, `.${randomUUID()}.incoming`);
  await writeFile(staged, '', { flag: 'wx', mode: 0o600 });
  try {
    await restrictToOwner(staged, 0o600);
    const file = await open(staged, 'w');
    try {
      await file.writeFile(`${JSON.stringify(data)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(staged, join(dir, name));
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(staged, { force: true });
  }
}

async function sourceFor(
  traceDirectory: string,
  runId: string,
  repository: string,
): Promise<RecordingReviewSource> {
  const bytes = await readFile(join(traceDirectory, 'manifest.json'));
  const manifest: unknown = JSON.parse(bytes.toString('utf8'));
  assertManifest(manifest);
  if (
    manifest.run_id !== runId ||
    !manifest.ended_at ||
    !manifest.integrity?.events_sha256 ||
    manifest.counts === undefined ||
    manifest.exit_code === undefined
  ) {
    throw new Error('The recording is missing its finalized manifest.');
  }
  return {
    version: 1,
    kind: 'recorded_process',
    repository,
    runId,
    hostSessionId: null,
    range: { kind: 'whole_run', events: manifest.counts.events },
    manifestDigest: createHash('sha256').update(bytes).digest('hex'),
    eventsDigest: manifest.integrity.events_sha256,
    capture: manifest.capture?.status ?? 'unverified',
    captureIssues: manifest.capture?.issues ?? [],
    exitCode: manifest.exit_code,
  };
}

/** Private operational state adjacent to the recording store, outside individual run directories. */
export class RecordingReviewStore {
  private constructor(
    private readonly directory: string,
    readonly traceDirectory: string,
    readonly source: RecordingReviewSource,
  ) {}

  static async enqueue(cwd: string, runId: string, traceDirectory: string, repository: string) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid recording ID.');
    const parent = join(agenticreplayDir(cwd), 'reviews');
    const directory = join(parent, runId);
    const source = await sourceFor(traceDirectory, runId, repository);
    for (const path of [parent, directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const identity = await privatePathIdentity(path);
      await restrictToOwner(path, 0o700);
      await assertPrivatePathIdentity(path, identity);
    }
    await createOnce(directory, 'source.json', source);
    const stored = await readFile(join(directory, 'source.json'), 'utf8');
    if (JSON.stringify(JSON.parse(stored)) !== JSON.stringify(source))
      throw new Error('This review is already bound to a different recording.');
    return new RecordingReviewStore(directory, traceDirectory, source);
  }

  static async open(cwd: string, runId: string) {
    if (!RUN_ID_PATTERN.test(runId))
      throw new Error('Specify an exact run ID from agenticreplay list.');
    const directory = join(agenticreplayDir(cwd), 'reviews', runId);
    const stored = await readFile(join(directory, 'source.json'), 'utf8').catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      throw new Error(`No queued memory review for ${runId}.`);
    });
    const { dir } = await resolveRunSelector(cwd, runId);
    const source = await sourceFor(dir, runId, await reviewRepository(cwd));
    if (JSON.stringify(JSON.parse(stored)) !== JSON.stringify(source))
      throw new Error('The recording or its repository changed since review was queued.');
    return new RecordingReviewStore(directory, dir, source);
  }

  async verifySource(): Promise<void> {
    const [manifest, events] = await Promise.all([
      sha256File(join(this.traceDirectory, 'manifest.json')),
      sha256File(join(this.traceDirectory, 'events.jsonl')),
    ]).catch(() => {
      throw new Error('The source recording is unavailable.');
    });
    if (manifest !== this.source.manifestDigest || events !== this.source.eventsDigest)
      throw new Error('The source recording changed. Its queued review is invalid.');
  }

  async current(): Promise<StoredReview> {
    const revision = (await readdir(this.directory)).reduce((latest, name) => {
      const match = /^([1-9][0-9]*)\.json$/.exec(name);
      return match ? Math.max(latest, Number(match[1])) : latest;
    }, 0);
    if (revision === 0) return { state: 'queued', revision };
    const record = JSON.parse(await readFile(join(this.directory, `${revision}.json`), 'utf8'));
    if (
      !Number.isSafeInteger(revision) ||
      !record ||
      !(
        record.state === 'empty' ||
        record.state === 'preparation_failed' ||
        ((record.state === 'awaiting_review' || record.state === 'declined') &&
          typeof record.digest === 'string' &&
          hashPattern.test(record.digest))
      )
    ) {
      throw new Error('The queued review state is invalid.');
    }
    return { ...record, revision };
  }

  async advance(current: StoredReview, entry: ReviewEntry): Promise<StoredReview | null> {
    if (current.state === 'declined') return null;
    const revision = current.revision + 1;
    if (!(await createOnce(this.directory, `${revision}.json`, entry))) return null;
    return { ...entry, revision };
  }
}
