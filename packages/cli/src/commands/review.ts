import { spawn } from 'node:child_process';
import { serveMemoryReview } from '@agenticreplay/viewer';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import { ReviewCoordinator } from '../review-coordinator.js';
import { RecordingReviewStore } from '../review-store.js';

function openBrowser(url: string, out: Output): void {
  const launcher =
    process.platform === 'darwin'
      ? '/usr/bin/open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : undefined;
  if (!launcher) return;
  const opener = spawn(launcher, [url], { stdio: 'ignore' });
  const warn = () =>
    out.warn('memory_review.browser_unavailable', {
      next: 'Open the printed review URL in your browser.',
    });
  opener.once('error', warn);
  opener.once('exit', (code) => {
    if (code !== 0) warn();
  });
  opener.unref();
}

export async function reviewCommand(args: ParsedArgs, out: Output, cwd: string): Promise<void> {
  const coordinator = new ReviewCoordinator(
    await RecordingReviewStore.open(cwd, args.positionals[0] ?? ''),
  );
  if (args.bool('status')) {
    const view = await coordinator.read();
    out.plain(`${view.runId} · ${view.state}\n${view.message}`);
    return;
  }

  const server = await serveMemoryReview(coordinator);
  out.plain(`Open the memory review at ${server.url}`);
  out.plain('Press Ctrl-C to stop the local review server.');
  try {
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      if (
        process.stdout.isTTY &&
        process.stdin.isTTY &&
        !args.bool('ci') &&
        process.env.CI !== 'true'
      )
        openBrowser(server.url, out);
    });
  } finally {
    await server.close();
  }
}
