import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { selectedProvider } from '@agenticreplay/adapters';

export const codexServiceBaseUrl = (port: number): string =>
  `http://127.0.0.1:${port}/backend-api/codex`;

const baseAssignment = /^[ \t]*(?:openai_base_url|"openai_base_url"|'openai_base_url')[ \t]*=/mu;

async function configFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new Error('The Codex configuration must be a regular file owned by you.');
  const text = await readFile(file, 'utf8');
  return { text, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
}

const ownedLine = (port: number) => `openai_base_url = "${codexServiceBaseUrl(port)}"`;

function ownedSetting(text: string, port: number): string | undefined {
  const endOfHeader = text.search(/^[ \t]*\[/mu);
  const header = endOfHeader === -1 ? text : text.slice(0, endOfHeader);
  const line = ownedLine(port);
  const parts = header.match(/[^\n]*(?:\n|$)/gu) ?? [];
  const exact = parts.find((part) => part.replace(/\r?\n$/u, '') === line);
  if (!exact || header.split(exact).length !== 2) return;
  const before = header.slice(0, header.indexOf(exact));
  // Refuse to interpret a line that could be inside a multiline TOML string.
  if (before.includes('"""') || before.includes("'''")) return;
  return exact;
}

export async function codexConfigStatus(
  file: string,
  port?: number,
): Promise<'clear' | 'owned' | 'conflict'> {
  const { text } = await configFile(file);
  if (port !== undefined && ownedSetting(text, port)) return 'owned';
  if (baseAssignment.test(text)) return 'conflict';
  return 'clear';
}

async function replaceConfig(
  file: string,
  before: Awaited<ReturnType<typeof configFile>>,
  text: string,
) {
  const temporary = file + '.agenticreplay-' + randomUUID();
  await writeFile(temporary, text, { mode: before.mode, flag: 'wx' });
  try {
    const current = await configFile(file);
    if (
      current.text !== before.text ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.mode !== before.mode
    )
      throw new Error(
        'Codex configuration changed during the update. Retry after it stops changing.',
      );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function setCodexServiceEndpoint(file: string, port: number, enable: boolean) {
  const before = await configFile(file);
  if (enable) {
    if (selectedProvider(before.text) !== 'openai')
      throw new Error(
        'The Codex service requires the built-in OpenAI provider and ChatGPT sign-in.',
      );
    if (baseAssignment.test(before.text))
      throw new Error(
        'Codex already has an openai_base_url. Resolve the conflict before registering.',
      );
    const newline = before.text.includes('\r\n') ? '\r\n' : '\n';
    await replaceConfig(file, before, ownedLine(port) + newline + before.text);
    return;
  }
  const setting = ownedSetting(before.text, port);
  const text = setting ? before.text.replace(setting, '') : before.text;
  if (text.includes(`127.0.0.1:${port}`))
    throw new Error(
      'Codex still refers to the service port. Resolve the changed setting before disabling.',
    );
  if (setting) await replaceConfig(file, before, text);
}
