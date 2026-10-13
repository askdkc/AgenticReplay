import { chmod, cp, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRunsDir } from '@agenticreplay/core';
import type { ParsedArgs } from '../args.js';
import { cdCommand, Output } from '../out.js';
import { showCommand } from './inspect.js';

/** A shipped example project and its captured trace, ready to inspect without making API calls. */
const ASSET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'quickstart');
const DEFAULT_DIR = 'agenticreplay-quickstart';

export interface TraceEvent {
  type: string;
  attrs?: Record<string, unknown>;
  payload?: string;
}

async function events(): Promise<TraceEvent[]> {
  const data = await import('node:fs/promises');
  const jsonl = await data.readFile(join(ASSET, 'trace', 'events.jsonl'), 'utf8');
  return jsonl.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as TraceEvent);
}

async function shippedRunId(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(ASSET, 'trace', 'manifest.json'), 'utf8')) as { run_id?: string };
  if (!manifest.run_id) throw new Error('the shipped quickstart trace has no run_id');
  return manifest.run_id;
}

async function applyStoreModes(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await applyStoreModes(path);
    else await chmod(path, 0o600).catch(() => undefined);
  }
}

async function isEmptyish(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function recordingSummary(all: TraceEvent[]): string[] {
  const turns = all.filter((event) => event.type === 'model.response');
  const model = String(turns[0]?.attrs?.['model'] ?? 'a model').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const tokensIn = turns.reduce((n, event) => n + Number(event.attrs?.['input_tokens'] ?? 0), 0);
  const tokensOut = turns.reduce((n, event) => n + Number(event.attrs?.['output_tokens'] ?? 0), 0);
  const read = new Set<string>();
  for (const event of all) {
    if (event.type !== 'tool.call') continue;
    const input = event.attrs?.['input'] as { path?: string } | undefined;
    if (event.attrs?.['name'] === 'read_file' && input?.path) read.add(input.path);
  }
  const wrote = all.filter((event) => event.type === 'fs.change').map((event) => {
    const attrs = event.attrs ?? {};
    return `${String(attrs['path'])} (+${attrs['insertions']} −${attrs['deletions']})`;
  });
  const lines = [`${all.length} events · ${turns.length} model turns · ${model} · ${tokensIn.toLocaleString()} in · ${tokensOut.toLocaleString()} out`];
  if (read.size > 0) lines.push(`read ${[...read].join(', ')}`);
  if (wrote.length > 0) lines.push(`wrote ${wrote.join(', ')}`);
  return lines;
}

export interface QuickstartResult {
  dir: string;
  runId: string;
  events: number;
  turns: number;
}

export async function quickstartCommand(args: ParsedArgs, out: Output, cwd = process.cwd()): Promise<QuickstartResult> {
  const target = resolve(cwd, args.str('dir') ?? DEFAULT_DIR);
  if (!(await isEmptyish(target))) {
    throw new Error(`${target} already exists and is not an empty directory\n  pick somewhere else: agenticreplay quickstart --dir <path>`);
  }
  const runId = await shippedRunId();
  await ensureRunsDir(target);
  await cp(join(ASSET, 'project'), target, { recursive: true });
  const runDir = join(target, '.agenticreplay', 'runs', runId);
  await cp(join(ASSET, 'trace'), runDir, { recursive: true });
  await applyStoreModes(runDir);

  const all = await events();
  const turns = all.filter((event) => event.type === 'model.response').length;
  out.info('quickstart.ready', { dir: target, run: runId });
  out.plain('');
  out.plain('  A captured example of an agent fixing a reminder scheduler.');
  out.plain('  Nothing here needs a key, a network, or an agent installed.');
  out.plain('');
  for (const line of recordingSummary(all)) out.plain(`  ${line}`);
  out.plain('');
  if (args.bool('full')) {
    await showCommand({ ...args, command: 'show', positionals: [runId] }, out, target);
    out.plain('');
  }
  out.plain(`  ${cdCommand(target)}`);
  out.plain('');
  out.plain('  See it      agenticreplay ui                       # inspect the timeline');
  out.plain('  Dig in      agenticreplay show · agenticreplay graph · agenticreplay export -o run.html');
  out.plain('  Your own    agenticreplay record claude -- -p "..."');
  if (!args.bool('full')) out.plain('  --full for the complete recorded timeline.');
  return { dir: target, runId, events: all.length, turns };
}
