# Writing an adapter

Adapters tell AgenticReplay how to launch an agent and route its supported model traffic through
the recording proxy. They do not implement model providers or replay behavior.

```ts
import type { Adapter, Launch, RecordContext } from '@agenticreplay/plugin-api';

export const myAgent: Adapter = {
  id: 'my-agent',
  harnessVersions: '>=1.2.0 <2',
  async detect(cwd) {
    return existsSync(join(cwd, '.myagent'));
  },
  async prepare(ctx: RecordContext): Promise<Launch> {
    return {
      command: 'my-agent',
      args: ctx.userArgs,
      env: { OPENAI_BASE_URL: `${ctx.proxyUrl}/v1` },
    };
  },
};
```

`RecordContext` provides the working directory, run directory, original arguments and environment,
and the local proxy URL. `Launch` supplies a command, argument vector and environment overlay.
Adapters may declare ignored output paths in `artifacts.capture` so meaningful generated files are
included in file-change capture.

The adapter contract checks the identifier, detector, launch shape, proxy routing, credential
handling, context immutability, paths, and declared harness version. Run
`checkAdapterContract()` from `@agenticreplay/adapters` when validating an adapter.

A PR that adds an adapter should include a fixture naming the environment variables it sets and the
harness version checked. Plugins import the public `@agenticreplay/plugin-api`; they should not
reach into AgenticReplay implementation packages.
