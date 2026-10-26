// Packing bundles the installed tree, so a patched lockfile alone is insufficient.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const schemaRequire = createRequire(new URL('../packages/schema/package.json', import.meta.url));
const ajvRequire = createRequire(schemaRequire.resolve('ajv'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const expected = lock.packages['node_modules/fast-uri'].version;
const installed = ajvRequire('fast-uri/package.json').version;
if (installed !== expected)
  throw new Error(
    `Cannot pack: installed fast-uri ${installed} differs from lockfile ${expected}. Run npm ci before packing or publishing.`,
  );
if (ajvRequire('fast-uri').normalize('%6Aavascript:alert(1)').startsWith('javascript:'))
  throw new Error(
    'Cannot pack: the bundled URI resolver decodes executable schemes. Run npm ci with the patched lockfile.',
  );
