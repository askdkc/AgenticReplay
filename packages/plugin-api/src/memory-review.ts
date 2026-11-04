/** A sealed recording of a single CLI process. It can span multiple conversation turns. */
export interface RecordingReviewSource {
  readonly version: 1;
  readonly kind: 'recorded_process';
  readonly repository: string;
  readonly runId: string;
  readonly hostSessionId: null;
  readonly range: { readonly kind: 'whole_run'; readonly events: number };
  readonly manifestDigest: string;
  readonly eventsDigest: string;
  readonly capture: 'complete' | 'incomplete' | 'unverified';
  readonly captureIssues: readonly string[];
  readonly exitCode: number;
}

export interface ReviewCandidate {
  readonly title: string;
  readonly body: string;
  readonly evidence: readonly {
    readonly sequence: number;
    readonly kind: 'observed' | 'inferred' | 'unverified';
    readonly description: string;
  }[];
}

/** Read-only host integration. The preparer owns trace input validation and secret removal. */
export interface ReviewPreparer {
  prepare(input: {
    source: RecordingReviewSource;
    traceDirectory: string;
    signal: AbortSignal;
  }): Promise<ReviewCandidate | null>;
}
