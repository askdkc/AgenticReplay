import { createHash } from 'node:crypto';
import { Redactor } from '@agenticreplay/core';
import type { ReviewCandidate, ReviewPreparer } from '@agenticreplay/plugin-api';
import type { ReviewAction, ReviewView } from '@agenticreplay/viewer';
import { type ReviewEntry, RecordingReviewStore, type StoredReview } from './review-store.js';

const unavailable = 'Kiokuko review integration is unavailable. The recording remains queued.';
const changed = 'This review changed in another window. Refresh before continuing.';

function safeText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || !value.trim())
    throw new Error('Review text is empty or exceeds its size limit.');
  if (new Redactor().redactString(value, 'memory-review').hits.length)
    throw new Error('Review text contains a possible secret. Remove it before continuing.');
  return value.replace(/\r\n?/g, '\n');
}

function validateCandidate(value: ReviewCandidate, events: number): ReviewCandidate {
  if (!Array.isArray(value.evidence) || value.evidence.length > 20)
    throw new Error('Invalid review evidence.');
  return {
    title: safeText(value.title, 200),
    body: safeText(value.body, 6000),
    evidence: value.evidence.map(({ sequence, kind, description }) => {
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence > events ||
        !['observed', 'inferred', 'unverified'].includes(kind)
      ) {
        throw new Error('Review evidence is outside the source recording.');
      }
      return { sequence, kind, description: safeText(description, 500) };
    }),
  };
}

export class ReviewCoordinator {
  #preview: { digest: string; candidate: ReviewCandidate } | undefined;

  constructor(
    private readonly store: RecordingReviewStore,
    private readonly preparer?: ReviewPreparer,
  ) {}

  async read(): Promise<ReviewView> {
    const current = await this.store.current();
    if (current.state === 'declined') return this.view(current, 'This review was discarded.');
    try {
      await this.store.verifySource();
    } catch {
      return this.view(
        { ...current, state: 'preparation_failed' },
        'The source recording is missing or changed.',
      );
    }

    if (current.state === 'awaiting_review' && this.#preview?.digest === current.digest)
      return this.view(
        current,
        'Review the proposed memory and its evidence.',
        this.#preview.candidate,
      );

    if (!this.preparer) return this.failure(current, unavailable);
    let candidate: ReviewCandidate | null;
    try {
      const signal = AbortSignal.timeout(10_000);
      // Pass the timeout to the adapter and also stop waiting if the adapter fails to honor it.
      const raw = await new Promise<ReviewCandidate | null>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(() =>
            this.preparer!.prepare({
              source: structuredClone(this.store.source),
              traceDirectory: this.store.traceDirectory,
              signal,
            }),
          )
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      candidate = raw === null ? null : validateCandidate(raw, this.store.source.range.events);
      await this.store.verifySource();
    } catch {
      return this.failure(current, 'Kiokuko could not prepare a valid proposal. Refresh to retry.');
    }
    if (!candidate) {
      const entry = await this.transition(current, { state: 'empty' });
      return this.view(entry, 'Kiokuko found no memory candidates for this recording.');
    }
    return this.present(current, candidate);
  }

  async decide(action: ReviewAction): Promise<ReviewView> {
    const current = await this.store.current();
    const preview = this.#preview;
    if (
      current.state !== 'awaiting_review' ||
      current.revision !== action.revision ||
      current.digest !== action.digest ||
      preview?.digest !== action.digest
    ) {
      throw new Error(changed);
    }
    await this.store.verifySource();
    if (action.kind === 'decline') {
      const result = await this.transition(current, { state: 'declined', digest: current.digest });
      this.#preview = undefined;
      return this.view(result, 'This review was discarded.');
    }
    return this.present(
      current,
      { ...preview.candidate, body: safeText(action.body, 6000) },
      'Review the updated proposal before continuing.',
    );
  }

  private async failure(current: StoredReview, message: string): Promise<ReviewView> {
    // Preserve the known proposal binding if an adapter temporarily disappears on restart.
    const entry =
      current.state === 'awaiting_review'
        ? { ...current, state: 'preparation_failed' as const }
        : await this.transition(current, { state: 'preparation_failed' });
    return this.view(entry, message);
  }

  private async present(
    current: StoredReview,
    candidate: ReviewCandidate,
    message = 'Review the proposed memory and its evidence.',
  ): Promise<ReviewView> {
    const digest = createHash('sha256')
      .update(JSON.stringify({ version: 1, source: this.store.source, candidate }))
      .digest('hex');
    const entry = await this.transition(current, { state: 'awaiting_review', digest });
    this.#preview = { digest, candidate };
    return this.view(entry, message, candidate);
  }

  private async transition(current: StoredReview, next: ReviewEntry): Promise<StoredReview> {
    if (
      current.state === next.state &&
      (!('digest' in next) || ('digest' in current && current.digest === next.digest))
    ) {
      return current;
    }
    const result = await this.store.advance(current, next);
    if (!result) throw new Error(changed);
    return result;
  }

  private view(entry: StoredReview, message: string, candidate?: ReviewCandidate): ReviewView {
    const source = this.store.source;
    return {
      runId: source.runId,
      repository: source.repository,
      exitCode: source.exitCode,
      events: source.range.events,
      capture: source.capture,
      captureIssues: source.captureIssues,
      state: entry.state,
      message,
      ...(candidate && 'digest' in entry
        ? {
            proposal: { ...candidate, revision: entry.revision, digest: entry.digest },
          }
        : {}),
    };
  }
}
