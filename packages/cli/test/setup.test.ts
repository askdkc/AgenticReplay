import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, stripAnsi } from '../src/out.js';
import { readConfig } from '../src/config.js';
import { modelsCommand, setupCommand } from '../src/commands/setup.js';
import { withoutCredentials } from '@agenticreplay/proxy';
import { writeConfig } from '../src/config.js';
import { upstreamPlan } from '../src/upstream.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

/**
 * `agenticreplay setup` is the answer to "how do I compare four models without wiring anything up". It asks
 * for a gateway and a key, checks they work, and writes them down once.
 *
 * The recurring assertion in here is that the key never appears in output. A debugger that prints
 * your credential into a terminal you are about to paste into an issue has undone the point of
 * every redaction rule in the write path.
 */
describe('agenticreplay setup', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let lines: string[];
  let out: Output;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agenticreplay-setup-'));
    env = { XDG_CONFIG_HOME: home };
    lines = [];
    out = new Output({ write: (l) => void lines.push(l), isTTY: false });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const text = () => stripAnsi(lines.join('\n'));

  describe('explicit gateway selection', () => {
    it('rejects an empty answer without writing configuration or contacting a gateway', async () => {
      let probed = false;
      await expect(
        setupCommand(parseArgs(['setup']), out, {
          env,
          ask: async () => '',
          probe: async () => {
            probed = true;
            return [];
          },
        }),
      ).rejects.toThrow('explicit gateway');
      expect(probed).toBe(false);
      expect(await readConfig(env)).toEqual({});
    });
    it('records the gateway the user names', async () => {
      const config = await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example']),
        out,
        { env, ask: async () => '', probe: async () => [] },
      );
      expect(config.gateway).toMatchObject({ url: 'https://gw.example', url_source: 'named' });
    });
    it('leaves unconfigured recording on the selected provider', async () => {
      const plan = await upstreamPlan(parseArgs(['record', 'claude']), env);
      expect(plan.upstream).toBeUndefined();
      expect(plan.headers).toBeUndefined();
    });
  });

  describe('the next-step line', () => {
    it('suggests models the gateway actually serves', async () => {
      // Model ids are gateway-specific — OrcaRouter namespaces them by provider, a direct provider
      // does not — so a hardcoded pair is a copyable line that fails against the gateway agenticreplay just
      // configured. It used to print `claude-opus-5,gpt-5.2` regardless.
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        {
          env,
          probe: async () => ['anthropic/claude-opus-5', 'openai/gpt-5.2', 'google/gemini-2.5-pro'],
          ask: async (q) => (q.startsWith('Models') ? '' : ''),
        },
      );
      // The ask above accepts the offered default, so a model list is stored and the line is short.
      expect(text()).toContain('agenticreplay record claude');
      expect(text()).toContain('3 models available:');
      expect(text()).toContain('anthropic/claude-opus-5');
      expect(text()).not.toMatch(/agenticreplay (?:compare|replay)\b/);
    });

    it('names real ids when no default list was chosen', async () => {
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        { env, probe: async () => ['anthropic/claude-opus-5', 'openai/gpt-5.2'] },
      );
      const printed = text();
      expect(printed).toContain('anthropic/claude-opus-5');
      expect(printed).toContain('openai/gpt-5.2');
      expect(printed, 'never a model id nobody confirmed exists').not.toContain(
        '--models claude-opus-5,gpt-5.2',
      );
    });

    it('points at agenticreplay models when the gateway could not be reached', async () => {
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        {
          env,
          probe: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
      );
      const printed = text();
      expect(printed).toContain('gateway.unreachable');
      expect(printed).toContain('run agenticreplay setup again');
      expect(printed, 'inventing ids for an unreachable gateway is worse than none').not.toMatch(
        /--models \S/,
      );
    });
  });

  it('writes a gateway and key given on the command line', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => ['claude-opus-5', 'gpt-5.2'] },
    );

    const config = await readConfig(env);
    expect(config.gateway?.url).toBe('https://gw.example');
    expect(config.gateway?.api_key).toBe('sk-secret-value');
  });

  it('says whether a key was stored, without the guard eating the answer', async () => {
    // `key:` as a field name is redacted by the terminal guard — correctly, but it would hide the
    // one fact this line exists to convey.
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => [] },
    );
    expect(text()).toContain('auth=stored');
  });

  it('never prints the key back', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => ['claude-opus-5'] },
    );
    expect(text()).not.toContain('sk-secret-value');
    expect(text()).toContain('gw.example');
  });

  it('reports the models the gateway actually serves', async () => {
    // Writing the config is not the same as it working. Asking the gateway what it has turns a
    // silent 401 later into an answer now, which is the entire reason this command exists.
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-x']),
      out,
      { env, probe: async () => ['claude-opus-5', 'gpt-5.2', 'qwen3-coder'] },
    );
    expect(text()).toContain('claude-opus-5');
    expect(text()).toContain('qwen3-coder');
  });

  it('still saves, and says what went wrong, when the gateway cannot be reached', async () => {
    // Being offline should not stop you configuring the thing you are about to use online.
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-x']),
      out,
      {
        env,
        probe: async () => {
          throw new Error('getaddrinfo ENOTFOUND gw.example');
        },
      },
    );
    expect((await readConfig(env)).gateway?.url).toBe('https://gw.example');
    expect(text()).toMatch(/ENOTFOUND|could not/i);
  });

  it('stores an env var name instead of the key when asked', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key-env', 'MY_GATEWAY_KEY']),
      out,
      { env: { ...env, MY_GATEWAY_KEY: 'sk-from-env' }, probe: async () => [] },
    );
    const config = await readConfig(env);
    expect(config.gateway?.api_key_env).toBe('MY_GATEWAY_KEY');
    expect(config.gateway?.api_key).toBeUndefined();
  });

  it('asks, when nothing was given and someone is there to answer', async () => {
    const asked: string[] = [];
    await setupCommand(parseArgs(['setup']), out, {
      env,
      probe: async () => ['claude-opus-5'],
      ask: async (question) => {
        asked.push(question);
        return question.toLowerCase().includes('key') ? 'sk-typed' : 'https://typed.example';
      },
    });
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect((await readConfig(env)).gateway?.url).toBe('https://typed.example');
    expect(text()).not.toContain('sk-typed');
  });

  it('leaves the model list unset when there is nothing to suggest and nothing typed', async () => {
    await setupCommand(parseArgs(['setup', '--gateway', 'https://gw.example']), out, {
      env,
      probe: async () => [],
      ask: async () => '',
    });
    expect((await readConfig(env)).models).toBeUndefined();
  });

  it('requires a gateway in non-interactive setup', async () => {
    await expect(
      setupCommand(parseArgs(['setup']), out, { env, probe: async () => [] }),
    ).rejects.toThrow('explicit gateway');
    expect(await readConfig(env)).toEqual({});
  });
  /**
   * The credential in a *gateway URL*, in every shape one can be written.
   *
   * A table rather than three tests, and asserted on the whole of stdout rather than on a field,
   * because the two P1s here were both "the sanitiser handled the shape it was written against and
   * not a neighbouring one". `no-credential-in-attrs.test.ts` guards the same class for trace
   * attributes; this guards it for the terminal, which is where these leaked:
   *
   *   - a password containing '@' — ordinary — ended the userinfo regex early, and the remainder
   *     stayed in userinfo position: `https://myuser:p@ssw0rd@gw` printed as `https://ssw0rd@gw`.
   *   - a scheme-less URL made `new URL` read the username as the protocol, so the sanitiser
   *     returned a value carrying the password and every `?? url` guard saw a success.
   *
   * Refused rather than sanitised, because nothing here could have worked: undici rejects a URL
   * carrying credentials, and a scheme-less one has no host to reach.
   */
  describe('a gateway URL that carries a credential', () => {
    /**
     * Two groups, because the answer differs and the difference is the point.
     *
     * A gateway that authenticates by query is an ordinary working configuration — undici sends it
     * without complaint — so refusing it would break a setup to close a leak that was never about
     * sending. Userinfo undici does reject at request time, but it is *sanitisable*, and the
     * recording path already accepts it and keeps it out of the trace. Both are therefore accepted
     * and stripped from every display.
     *
     * A scheme-less URL is the one with nothing to sanitise: it parses with the username as the
     * protocol, so the sanitiser answers with a value that still carries the password and a
     * `?? url` guard never fires. Nothing to strip, and nothing that could have worked.
     */
    const sanitised = [
      {
        what: 'a password with an @ in it',
        url: 'https://myuser:p@ssw0rd@gw.example/v1',
        secret: 'ssw0rd',
      },
      {
        what: 'a password with several @s',
        url: 'https://u:p@ss@w0rd@gw.example/v1',
        secret: 'w0rd',
      },
      {
        what: 'an ordinary password',
        url: 'https://myuser:PASSWORD@gw.example/v1',
        secret: 'PASSWORD',
      },
      {
        what: 'a key in the query',
        url: 'https://gw.example/v1?key=SECRETKEY',
        secret: 'SECRETKEY',
      },
    ];
    const refused = [
      { what: 'no scheme at all', url: 'my.gateway.example?key=SECRETKEY', secret: 'SECRETKEY' },
      {
        what: 'no scheme, username read as one',
        url: 'myuser:PASSWORD@gw.example/v1',
        secret: 'PASSWORD',
      },
    ];

    it.each(sanitised)(
      'agenticreplay setup takes $what and never prints it',
      async ({ url, secret }) => {
        await setupCommand(parseArgs(['setup', '--gateway', url, '--key-env', 'FAKE_KEY']), out, {
          env,
          ask: undefined,
          probe: async () => {
            // What undici says about a userinfo URL, so the error path is exercised too.
            throw new Error(
              `Request cannot be constructed from a URL that includes credentials: ${url}/v1/models`,
            );
          },
        });
        expect((await readConfig(env)).gateway?.url, 'it still has to be sent').toBe(url);
        expect(text(), 'and never printed').not.toContain(secret);
      },
    );

    it.each(refused)(
      'agenticreplay setup refuses $what without echoing it',
      async ({ url, secret }) => {
        await expect(
          setupCommand(parseArgs(['setup', '--gateway', url, '--key-env', 'FAKE_KEY']), out, {
            env,
            ask: undefined,
            probe: async () => [],
          }),
        ).rejects.toThrow(/is not an origin agenticreplay can use/);
        expect(text(), 'the refusal must not print the value it refused').not.toContain(secret);
        expect(await readConfig(env), 'nothing refused may reach the file').toEqual({});
      },
    );

    it.each([...sanitised, ...refused])(
      'agenticreplay models never prints $what from a hand-edited config',
      async ({ url, secret }) => {
        // readConfig deliberately accepts a hand-edited file, so this is the one way such a URL can
        // still arrive — and modelsCommand exists to report a gateway it cannot reach.
        await writeConfig({ gateway: { url, api_key_env: 'FAKE_KEY' } }, env);
        const models = await modelsCommand(parseArgs(['models']), out, {
          env,
          probe: async () => {
            throw new Error(`Failed to parse URL from ${url}/v1/models`);
          },
        });
        expect(models).toEqual([]);
        expect(text(), 'the diagnostic must not print the value it is diagnosing').not.toContain(
          secret,
        );
      },
    );

    it('a good gateway still passes, so the guard is not simply refusing everything', async () => {
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example/team-a/v1', '--key-env', 'FAKE_KEY']),
        out,
        {
          env,
          ask: undefined,
          probe: async () => ['gpt-5.2'],
        },
      );
      expect((await readConfig(env)).gateway?.url).toBe('https://gw.example/team-a/v1');
      expect(text()).toContain('https://gw.example/team-a/v1');
    });
  });

  describe('withoutCredentials', () => {
    it('takes the whole userinfo, not up to the first @ inside the password', () => {
      expect(withoutCredentials('https://myuser:p@ssw0rd@gw.example/v1/models')).toBe(
        'https://gw.example/v1/models',
      );
    });

    it('leaves an @ in a path segment alone', () => {
      expect(withoutCredentials('https://gw.example/v1/@scope/pkg')).toBe(
        'https://gw.example/v1/@scope/pkg',
      );
    });

    it('cleans every URL in one string', () => {
      expect(withoutCredentials('a https://x:1@p.example/v1 b https://y:2@q.example/v1')).toBe(
        'a https://p.example/v1 b https://q.example/v1',
      );
    });
  });
});

describe('agenticreplay models', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let lines: string[];
  let out: Output;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agenticreplay-models-'));
    env = { XDG_CONFIG_HOME: home };
    lines = [];
    out = new Output({ write: (l) => void lines.push(l), isTTY: false });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('says how to configure a gateway when there is none', async () => {
    await modelsCommand(parseArgs(['models']), out, { env, probe: async () => [] });
    expect(stripAnsi(lines.join('\n'))).toContain('agenticreplay setup');
  });

  it('lists what the gateway serves, with prices where they are known', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-x']),
      out,
      { env, probe: async () => [] },
    );
    lines.length = 0;

    await modelsCommand(parseArgs(['models']), out, {
      env,
      probe: async () => ['claude-opus-5', 'some-unpriced-model'],
    });

    const text = stripAnsi(lines.join('\n'));
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('some-unpriced-model');
    // A known model shows its input price; an unknown one must not invent one.
    expect(text).toMatch(/15/);
  });

  it('never prints the key', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => [] },
    );
    lines.length = 0;
    await modelsCommand(parseArgs(['models']), out, { env, probe: async () => ['claude-opus-5'] });
    expect(stripAnsi(lines.join('\n'))).not.toContain('sk-secret-value');
  });
});
