import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not built output, so `npx vitest` needs no prior `tsc --build`.
    // CONTRIBUTING promises a five-minute dev loop; a mandatory build step is how that promise
    // quietly becomes twenty.
    alias: {
      '@agenticreplay/schema': pkg('schema'),
      '@agenticreplay/plugin-api': pkg('plugin-api'),
      '@agenticreplay/core': pkg('core'),
      '@agenticreplay/fs-capture': pkg('fs-capture'),
      '@agenticreplay/providers': pkg('providers'),
      '@agenticreplay/proxy': pkg('proxy'),
      '@agenticreplay/adapters': pkg('adapters'),
      '@agenticreplay/node-instrument': pkg('node-instrument'),
      '@agenticreplay/mcp-shim': pkg('mcp-shim'),
      '@agenticreplay/shell-shim': pkg('shell-shim'),
      '@agenticreplay/viewer': pkg('viewer'),
    },
  },
  test: {
    // `scripts/` too, because the release scripts are code with no package to live in, and a test
    // that is never collected is worse than no test: `set-version.test.ts` guards an edit that is
    // permanent on npm if it goes wrong, and would have sat here green and unrun.
    include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Every worker starts with an empty XDG_CONFIG_HOME — see the file for why that is not a
    // convenience but the difference between a hermetic suite and one that calls a real gateway.
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
