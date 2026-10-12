import { RUN_ID_PATTERN } from '@agenticreplay/schema';
import anyAscii from 'any-ascii';

const MAX_DIRECTORY_LENGTH = 255;

/** Terminal-friendly ASCII only; transliterate rather than discarding non-Latin titles. */
function slug(value: string, limit: number, fallback: string): string {
  const clean = anyAscii(value.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const result = clean.slice(0, limit);
  return result.replace(/-+$/g, '') || fallback;
}

/** Start time is UTC, as in the manifest. The suffix preserves the stable public run ID. */
export function captureDirectoryName(
  startedAt: string,
  adapter: string,
  title: string,
  runId: string,
): string {
  const timestamp = new Date(startedAt).toISOString().slice(0, 19).replace(/\D/g, '');
  const prefix = `${timestamp}-${slug(adapter, 32, 'agent')}`;
  const suffix = runId.slice('run_'.length);
  const titleLimit = Math.min(80, MAX_DIRECTORY_LENGTH - prefix.length - suffix.length - 2);
  return `${prefix}-${slug(title, titleLimit, 'session')}-${suffix}`;
}

/** Recognize only live run names; staging, replacement and lock siblings remain invisible. */
export function runIdFromDirectory(name: string): string | undefined {
  if (RUN_ID_PATTERN.test(name)) return name;
  if (name.length > MAX_DIRECTORY_LENGTH) return undefined;
  const suffix = /^\d{14}-[a-z0-9-]+-([0-9a-f]{6,32})$/.exec(name)?.[1];
  return suffix === undefined ? undefined : `run_${suffix}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  return (
    value
      .map((block) => {
        const item = object(block);
        return typeof item?.text === 'string' ? item.text : '';
      })
      .join(' ')
      .trim() || undefined
  );
}

/** First human stimulus only: system messages, tools and later turns cannot rename a session. */
export function firstUserPrompt(payload: unknown): string | undefined {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  const body = object(payload);
  if (!body) return undefined;
  if (Array.isArray(body.prompts))
    return contentText(body.prompts.find((p) => typeof p === 'string' && p.trim()));
  const request = object(body.request) ?? body;
  const messages = request.messages ?? request.input;
  if (typeof messages === 'string') return contentText(messages);
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const item = object(message);
      if (item?.role !== 'user') continue;
      const text = contentText(item.content);
      if (text && !text.startsWith('<')) return text;
    }
  }
  return contentText(request.prompt);
}
