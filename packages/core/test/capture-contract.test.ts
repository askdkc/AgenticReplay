import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { INLINE_PAYLOAD_LIMIT, isBlobRef, validateManifest } from '@agenticreplay/schema';
import { TraceWriter } from '../src/writer.js';
import { TraceReader } from '../src/reader.js';

const dirs: string[] = [];
it('scrubs URL credentials on start evidence and records the transformation without changing other query bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-url-'));
  dirs.push(dir);
  const writer = await TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: [],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
    envAllowlist: [],
  });
  const event = await writer.append({
    type: 'net.request',
    actor: 'agent',
    attrs: {
      phase: 'start',
      url: 'https://alice:shortpass@api.test/v1/messages?api-version=1&api_key=shortkey',
      path: '/v1/messages?%74oken=abc&keep=a%20b',
    },
  });
  await writer.close(0);
  expect(JSON.stringify(event)).not.toMatch(/shortpass|shortkey|token=abc/);
  expect(event.attrs?.url).toBe(
    'https://api.test/v1/messages?api-version=1&api_key=%3Credacted%3E',
  );
  expect(event.attrs?.path).toBe('/v1/messages?%74oken=%3Credacted%3E&keep=a%20b');
  expect(event.transformations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'url_scrubbed', location: 'attrs.url', count: 2 }),
    ]),
  );
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('retains full serialized input and explains every body redaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-capture-'));
  dirs.push(dir);
  const writer = await TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: [],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
    envAllowlist: [],
  });
  const secret = 'sk-' + 'a'.repeat(32);
  const input =
    '{ "instructions": "' +
    'context '.repeat(150_000) +
    '", "unknown": "keep", "key": "' +
    secret +
    '" }';
  const event = await writer.append({ type: 'net.request', actor: 'agent', payload: input });
  await writer.close(0);
  expect(isBlobRef(event.payload)).toBe(true);
  const reader = await TraceReader.open(writer.runDir);
  const body = await reader.resolvePayload(event);
  expect(typeof body).toBe('string');
  expect(body).toContain('"unknown": "keep"');
  expect(body).not.toContain(secret);
  expect((body as string).replace(/<secret:sk_api_key:[^>]+>/g, secret)).toBe(input);
  expect(event.transformations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'redaction',
        rule: 'sk_api_key',
        location: 'payload',
        count: 1,
      }),
    ]),
  );
  expect(event.attrs?.body_sha256).toBe(
    createHash('sha256')
      .update(body as string)
      .digest('hex'),
  );
  expect(event.attrs?.body_bytes).toBe(Buffer.byteLength(body as string));
});

for (const type of ['net.request', 'net.response'] as const) {
  for (const padding of [0, INLINE_PAYLOAD_LIMIT]) {
    it(`keeps redacted ${type} JSON parseable with ${padding} padding bytes`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-json-'));
      dirs.push(dir);
      const writer = await TraceWriter.create(dir, {
        adapter: { id: 'test' },
        argv: [],
        cwd: dir,
        agenticreplayVersion: '0.5.0',
        envAllowlist: [],
      });
      const secret = 'Zx81Qp0vR7mT2sL9wK4yH6nB3cF5jD';
      const input = JSON.stringify({ content: '\n' + secret, pad: 'x'.repeat(padding) });
      const event = await writer.append({ type, actor: 'agent', payload: input });
      await writer.close(0);
      expect(isBlobRef(event.payload)).toBe(padding !== 0);
      const reader = await TraceReader.open(writer.runDir);
      const body = (await reader.resolvePayload(event)) as string;
      expect(typeof body).toBe('string');
      expect(() => JSON.parse(body)).not.toThrow();
      expect(body).not.toContain(secret);
      expect(body.replace(/<secret:high_entropy:[0-9a-f]{8}>/, secret)).toBe(input);
      expect(event.attrs?.body_bytes).toBe(Buffer.byteLength(body));
      expect(event.attrs?.body_sha256).toBe(createHash('sha256').update(body).digest('hex'));
      expect((await reader.verifyIntegrity()).ok).toBe(true);
    });
  }
}

it('rejects pre-AgenticReplay manifests rather than treating them as current traces', () => {
  expect(
    validateManifest({
      schema_version: '0.3.0',
      run_id: 'run_123abc',
      created_at: new Date().toISOString(),
      agenticreplay_version: '0.5.0',
      adapter: { id: 'test' },
      argv: [],
      cwd: '/test',
    }).valid,
  ).toBe(false);
});

it('redacts a prompt secret in launch arguments before writing the initial manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-capture-'));
  dirs.push(dir);
  const secret = 'sk-' + 'b'.repeat(32);
  const writer = await TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: ['agent', secret],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
    envAllowlist: [],
  });
  const initial = await readFile(join(writer.runDir, 'manifest.json'), 'utf8');
  await writer.close(0);
  expect(initial).not.toContain(secret);
});

it('preserves operational paths even when their directory names look like tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-Secretish23-XyZ-'));
  dirs.push(dir);
  const script = join(dir, 'agent.mjs');
  await writeFile(script, '');
  const writer = await TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: ['node', script],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
    envAllowlist: [],
  });
  const manifest = await writer.close(0);
  expect(manifest.cwd).toBe(dir);
  expect(manifest.argv).toEqual(['node', script]);
});

it('keeps a failed write visible when later writes and close succeed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-capture-'));
  dirs.push(dir);
  const writer = await TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: [],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
    envAllowlist: [],
  });
  await expect(writer.append({ type: 'note', actor: 'invalid' as never })).rejects.toThrow();
  await writer.append({ type: 'note', actor: 'agenticreplay' });
  const manifest = await writer.close(0);
  expect(manifest.capture?.status).toBe('incomplete');
  expect(manifest.capture?.issues).toContain('event_write_failed');
  expect(
    JSON.parse(await readFile(join(writer.runDir, 'manifest.json'), 'utf8')).capture.status,
  ).toBe('incomplete');
});

it('fails closed when the blob storage directory becomes unwritable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenticreplay-capture-'));
  dirs.push(dir);
  const writer = await TraceWriter.create(dir, {
    adapter: { id: 'test' },
    argv: [],
    cwd: dir,
    agenticreplayVersion: '0.5.0',
    envAllowlist: [],
  });
  // A regular file at the shard root fails on every OS, including a test runner using root.
  await writeFile(join(writer.runDir, 'blobs'), 'blocked');
  await expect(
    writer.append({
      type: 'net.response',
      actor: 'agenticreplay',
      payload: 'large body '.repeat(1000),
    }),
  ).rejects.toThrow();
  const manifest = await writer.close(0);
  expect(manifest.capture?.status).toBe('incomplete');
  expect(manifest.counts?.blobs).toBe(0);
});
