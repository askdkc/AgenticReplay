import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isBlobRef, type CaptureTransformation, type TraceEvent } from '@agenticreplay/schema';
import { BlobStore } from '../src/blobs.js';
import { TraceWriter } from '../src/writer.js';

// Fix the redaction salt so the fixture's 32-bit placeholder hashes cannot collide randomly.
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomBytes: (size: number) => (size === 16 ? Buffer.alloc(size) : crypto.randomBytes(size)),
  };
});

let root: string;
let writer: TraceWriter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ar-transformations-'));
  writer = await TraceWriter.create(root, {
    adapter: { id: 'test' },
    argv: [],
    cwd: root,
    agenticreplayVersion: '0.1.24',
    envAllowlist: [],
  });
});

afterEach(async () => {
  await writer.close();
  await rm(root, { recursive: true, force: true });
});

it('keeps spilled request redaction metadata proportional to the number of rules', async () => {
  const count = 14_600;
  const secrets = Array.from(
    { length: count },
    (_, index) => 'sk-' + String(index).padStart(24, '0'),
  );
  await writer.append({ type: 'net.request', actor: 'agent', payload: secrets.join('\n') });
  await writer.close();

  const raw = await readFile(join(writer.runDir, 'events.jsonl'), 'utf8');
  const event = JSON.parse(raw.split('\n')[0]!) as TraceEvent;
  const { payload, transformations } = event;
  if (!isBlobRef(payload)) throw new Error('Expected the request payload to spill to a blob');
  const blob = await new BlobStore(join(writer.runDir, 'blobs')).get(payload);
  const body = JSON.parse(Buffer.from(blob).toString('utf8')) as string;
  const hashes = body.split('\n').map((placeholder) => {
    const match = /^<secret:sk_api_key:([0-9a-f]{8})>$/.exec(placeholder);
    if (!match) throw new Error('Expected each request line to be a placeholder');
    return match[1];
  });
  expect(hashes).toHaveLength(count);
  expect(new Set(hashes).size).toBe(count);
  const identifier = `event:${event.seq}:payload:sk_api_key`;
  expect(Buffer.byteLength(raw)).toBeLessThan(1024);
  expect(event.redacted).toEqual([identifier]);
  const { records } = JSON.parse(
    await readFile(join(writer.runDir, 'redactions.json'), 'utf8'),
  ) as {
    records: { identifier: string; rule: string; count: number }[];
  };
  expect(
    records.filter((record) => record.identifier.startsWith(`event:${event.seq}:payload:`)),
  ).toEqual([expect.objectContaining({ identifier, rule: 'sk_api_key', count })]);
  expect(transformations?.filter(({ kind }) => kind === 'redaction')).toHaveLength(1);
  expect(transformations).toHaveLength(2);
  expect(transformations).toEqual([
    {
      kind: 'redaction',
      location: 'payload',
      rule: 'sk_api_key',
      count,
      reason: 'secret redaction policy',
    },
    expect.objectContaining({ kind: 'encoding', rule: 'json_string', count: 1 }),
  ]);
});

it('preserves first occurrence order, separates keys, and leaves transport annotations intact', async () => {
  const redaction = {
    kind: 'redaction',
    location: 'payload',
    rule: 'test',
    count: 1,
    reason: 'first',
  } satisfies CaptureTransformation;
  const transport = { ...redaction, kind: 'encoding' } satisfies CaptureTransformation;
  const location = { ...redaction, location: 'envelope' };
  const reason = { ...redaction, reason: 'second' };
  const rule = { ...redaction, rule: 'other' };
  const transformations = [redaction, transport, location, reason, rule, redaction, transport];
  const original = structuredClone(transformations);
  transformations.forEach(Object.freeze);
  Object.freeze(transformations);
  const event = await writer.append({ type: 'note', actor: 'agent', transformations });
  expect(event.transformations).toEqual([
    { ...redaction, count: 2 },
    transport,
    location,
    reason,
    rule,
    transport,
  ]);
  expect(transformations).toEqual(original);
});

it('keeps overflow and invalid counts as separate entries', async () => {
  const redaction = {
    kind: 'redaction',
    location: 'payload',
    rule: 'test',
    reason: 'boundary',
  } as const;
  const max = Number.MAX_SAFE_INTEGER;
  const counts = [0, max - 1, 1, 2, max + 1, 3];
  const event = await writer.append({
    type: 'note',
    actor: 'agent',
    transformations: counts.map((count) => ({ ...redaction, count })),
  });
  expect(event.transformations?.map(({ count }) => count)).toEqual([max, 2, max + 1, 3]);
});

it.each([-1, 0.5])('leaves invalid count %s subject to schema validation', async (count) => {
  const redaction = {
    kind: 'redaction',
    location: 'payload',
    rule: 'test',
    reason: 'boundary',
  } as const;
  await expect(
    writer.append({
      type: 'note',
      actor: 'agent',
      transformations: [
        { ...redaction, count: 2 },
        { ...redaction, count },
      ],
    }),
  ).rejects.toThrow('/transformations/1/count');
});

it('omits empty annotations and still scrubs secrets in caller annotations', async () => {
  const empty = await writer.append({ type: 'note', actor: 'agent', transformations: [] });
  expect(empty.transformations).toBeUndefined();
  const secret = 'sk-' + 'a'.repeat(24);
  const event = await writer.append({
    type: 'note',
    actor: 'agent',
    transformations: [
      { kind: 'encoding', location: 'storage', rule: 'test', count: 1, reason: secret },
    ],
  });
  expect(event.transformations?.[0]?.reason).toMatch(/^<secret:sk_api_key:[0-9a-f]{8}>$/);
});
