import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { escapeHtml } from './html.js';

export interface ReviewView {
  runId: string;
  repository: string;
  exitCode: number;
  events: number;
  capture: string;
  captureIssues: readonly string[];
  state: 'queued' | 'empty' | 'preparation_failed' | 'awaiting_review' | 'declined';
  message: string;
  proposal?: {
    title: string;
    body: string;
    evidence: readonly { sequence: number; kind: string; description: string }[];
    revision: number;
    digest: string;
  };
}

export type ReviewAction = { revision: number; digest: string } & (
  { kind: 'revise'; body: string } | { kind: 'decline' }
);

interface ReviewController {
  read(): Promise<ReviewView>;
  decide(action: ReviewAction): Promise<ReviewView>;
}

function reviewMain(view: ReviewView, csrf: string): string {
  const escape = escapeHtml;
  const proposal = view.proposal;
  return `<main>
  <h1 tabindex="-1">Memory review</h1>
  <p role="status">${escape(view.message)}</p>
  <dl>
    <dt>Recording</dt><dd>${escape(view.runId)} · whole recording (${escape(view.events)} events)</dd>
    <dt>Repository scope</dt><dd>${escape(view.repository)}</dd>
    <dt>Process exit</dt><dd>${escape(view.exitCode)} · task outcome unverified</dd>
    <dt>Capture</dt><dd>${escape([view.capture, ...view.captureIssues].join(' · '))}</dd>
  </dl>
  ${
    proposal
      ? `
    <h2>${escape(proposal.title)}</h2>
    <details><summary>Evidence and limitations</summary>
      <ul>${proposal.evidence.map((e) => `<li>Event ${escape(e.sequence)} · ${escape(e.kind)} · ${escape(e.description)}</li>`).join('')}</ul>
      <p>Revision ${escape(proposal.revision)} · <code>${escape(proposal.digest)}</code></p>
    </details>
    <form method="post">
      <input type="hidden" name="csrf" value="${escape(csrf)}">
      <input type="hidden" name="revision" value="${escape(proposal.revision)}">
      <input type="hidden" name="digest" value="${escape(proposal.digest)}">
      <label for="review-body">Proposed memory</label>
      <textarea id="review-body" name="body" rows="8" maxlength="6000" required>
${escape(proposal.body)}</textarea>
      <p id="save-status">Saving requires a Kiokuko connection with a verified approval flow.</p>
      <div class="actions">
        <button type="submit" name="action" value="revise">Preview revision</button>
        <button type="button" disabled aria-describedby="save-status">Save to Kiokuko</button>
        <button type="submit" name="action" value="decline" formnovalidate>Discard review</button>
      </div>
    </form>`
      : view.state === 'preparation_failed'
        ? '<a href="">Retry review</a>'
        : ''
  }
  <p id="feedback" role="status"></p>
  </main>`;
}

const script = `
let busy = false;
function dirty() {
  const body = document.querySelector('textarea');
  return body && body.value !== body.defaultValue;
}
window.addEventListener('beforeunload', event => {
  if (dirty()) event.preventDefault();
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !event.submitter) return;
  const form = event.target;
  const submitter = event.submitter;
  const action = submitter.value;
  if (action === 'decline' && !window.confirm('Discard this review? It will no longer be offered for this recording.')) return;
  const fields = new URLSearchParams(new FormData(form, submitter));
  if (action === 'decline') fields.delete('body');
  const controls = Array.from(form.elements).filter(control => !control.disabled);
  const feedback = document.querySelector('#feedback');
  busy = true;
  form.setAttribute('aria-busy', 'true');
  controls.forEach(control => { control.disabled = true; });
  feedback.textContent = 'Updating review…';
  try {
    const response = await fetch(location.pathname, {
      method: 'POST', body: fields, mode: 'same-origin',
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      feedback.textContent = await response.text();
      return;
    }
    const next = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('main');
    if (!next) throw new Error('Missing review');
    document.querySelector('main').replaceWith(next);
    next.querySelector('h1').focus();
  } catch {
    feedback.textContent = 'Connection lost. Your edit is still here. Retry, or reopen the review from the terminal.';
  } finally {
    form.removeAttribute('aria-busy');
    controls.forEach(control => { control.disabled = false; });
    if (form.isConnected && document.activeElement === document.body) submitter.focus();
    busy = false;
  }
});`;

function document(view: ReviewView, csrf: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory review · AgenticReplay</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font: 1rem/1.5 system-ui, sans-serif; }
  main { max-width: 44rem; margin: 2rem auto; padding: 0 1rem; overflow-wrap: anywhere; }
  dt { font-weight: 650; } dd { margin: 0 0 .65rem; }
  details { margin: 1rem 0; } label { display: block; margin-bottom: .4rem; }
  textarea { box-sizing: border-box; width: 100%; padding: .6rem; font: inherit; resize: vertical; }
  .actions { display: flex; flex-wrap: wrap; gap: .6rem; }
  button { font: inherit; padding: .5rem .85rem; min-height: 44px; }
  :focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
</style>
${reviewMain(view, csrf)}
<script nonce="${nonce}">${script}</script></html>`;
}

const maxBody = 80 * 1024;
async function readAction(request: IncomingMessage, csrf: string): Promise<ReviewAction> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBody) throw new Error('Review form exceeds its size limit.');
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const token = Buffer.from(fields.get('csrf') ?? '');
  const expected = Buffer.from(csrf);
  if (token.length !== expected.length || !timingSafeEqual(token, expected))
    throw new Error('Invalid review form. Reopen the review.');
  const action = fields.get('action');
  const revision = Number(fields.get('revision'));
  const digest = fields.get('digest') ?? '';
  const body = fields.get('body') ?? '';
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    (action !== 'decline' && action !== 'revise')
  )
    throw new Error('Invalid review action.');
  return action === 'decline'
    ? { kind: action, revision, digest }
    : { kind: action, revision, digest, body };
}

function send(response: ServerResponse, status: number, body: string, html = false): void {
  response.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
  });
  response.end(body);
}

/** Owns a single loopback review. No write-to-memory route is registered here. */
export async function serveMemoryReview(controller: ReviewController) {
  const path = `/review/${randomBytes(24).toString('hex')}`;
  const csrf = randomBytes(24).toString('hex');
  let host: string;
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 5000 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent)
        send(res, 500, 'The review is unavailable. Reopen it from the terminal.');
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    if (req.headers.host !== host || req.url !== path)
      return send(res, 404, 'Review page not found.');
    if (req.method === 'GET')
      return send(res, 200, document(await controller.read(), csrf, nonce), true);
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed.');
    if (req.headers.origin !== `http://${host}`)
      return send(res, 403, 'Review must come from this page.');
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')
      return send(res, 415, 'Unsupported review form.');
    if (Number(req.headers['content-length']) > maxBody)
      return send(res, 413, 'Review form is too large.');
    let action: ReviewAction;
    try {
      action = await readAction(req, csrf);
    } catch (error) {
      return send(res, 400, error instanceof Error ? error.message : 'Invalid review form.');
    }
    try {
      return send(res, 200, document(await controller.decide(action), csrf, nonce), true);
    } catch (error) {
      return send(
        res,
        409,
        error instanceof Error ? error.message : 'The review could not be updated.',
      );
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not bind the local review.');
  }
  host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
