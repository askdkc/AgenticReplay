import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  codexConfigStatus,
  codexServiceBaseUrl,
  setCodexServiceEndpoint,
} from '../src/codex-service-config.js';

it('removes its endpoint and keeps model changes made after registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-config-'));
  try {
    const file = join(dir, 'config.toml');
    const original =
      'model = "before"\nchatgpt_base_url = "https://chatgpt.com/backend-api/"\n[features]\nexample = true\n';
    const port = 54031;
    await writeFile(file, original, { mode: 0o600 });
    expect(await codexConfigStatus(file)).toBe('clear');
    await setCodexServiceEndpoint(file, port, true);
    const endpoint = `openai_base_url = "${codexServiceBaseUrl(port)}"\n`;
    expect(await readFile(file, 'utf8')).toBe(endpoint + original);
    const edited = original.replace('before', 'after');
    await writeFile(file, '# existing comment\n' + endpoint + edited);
    expect(await codexConfigStatus(file, port)).toBe('owned');
    await setCodexServiceEndpoint(file, port, false);
    expect(await readFile(file, 'utf8')).toBe('# existing comment\n' + edited);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('preserves user endpoints and refuses to stop a relay when its endpoint was edited in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-config-'));
  try {
    const file = join(dir, 'config.toml');
    const port = 54032;
    const external = 'openai_base_url = "https://gateway.example/v1"\n';
    await writeFile(file, external, { mode: 0o600 });
    await expect(setCodexServiceEndpoint(file, port, true)).rejects.toThrow(/already has/u);
    await setCodexServiceEndpoint(file, port, false);
    expect(await readFile(file, 'utf8')).toBe(external);
    const edited = `openai_base_url = 'http://127.0.0.1:${port}/v1'\n`;
    await writeFile(file, edited);
    await expect(setCodexServiceEndpoint(file, port, false)).rejects.toThrow(/still refers/u);
    expect(await readFile(file, 'utf8')).toBe(edited);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
