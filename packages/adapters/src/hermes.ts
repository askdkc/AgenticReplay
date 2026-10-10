import type { Adapter, Launch, RecordContext } from '@agenticreplay/plugin-api';
import { detectAgent } from './detect.js';

/**
 * Hermes, Nous Research's agent — the first Python harness agenticreplay records.
 *
 * Every other adapter here fronts a Node harness, and that difference is the whole reason this
 * one exists. Nothing is redirected: `OPENAI_BASE_URL` is not a route into Hermes. Its origin
 * lives in `config.yaml` under `model.base_url`, and the environment variable is read in only one
 * place -- an advisory warning that fires when it is set and the provider is *not* `custom`.
 * Verified against a logging listener rather than inferred: with `model.base_url` pointed at a
 * dead port and `OPENAI_BASE_URL` at a live one, the run dies on the dead port and the listener
 * records nothing, `--provider custom` included.
 *
 * What does work is the transport. Hermes honours `HTTPS_PROXY` all the way down -- through a
 * proxy that logs CONNECT targets, a single question sends two of them to the model origin, the
 * model-catalogue read and the completion -- so `--tls-intercept` reaches it.
 *
 * TLS trust is process-local. Standard Python clients use SSL_CERT_FILE; current Hermes
 * additionally uses OS-backed truststore contexts that ignore that variable. The recording
 * bootstrap adds the run CA to those contexts, preserving platform roots and certificate
 * verification. No system trust store or Hermes configuration is modified.
 *
 * `inference-api.nousresearch.com` is in `DEFAULT_TLS_HOSTS`, so Hermes on Nous' own models needs
 * no extra `--tls-hosts`. Deliberately not in that list: `portal.nousresearch.com`, which is
 * billing and subscription management and where the API key is issued.
 *
 * The fixture below was verified against `--provider opencode-free`, whose tier is served
 * anonymously -- no key, so no credential to leak into a recording. That origin needs
 * `--tls-hosts '+opencode.ai'` and does not get a default entry: unlike `api.kilo.ai` or
 * `api.xiaomimimo.com` it is a website as much as a gateway, and a default that decrypted it would
 * decrypt whatever else is served there.
 *
 *     agenticreplay record hermes --tls-intercept --tls-hosts '+opencode.ai' -- \
 *       --provider opencode-free -m nemotron-3.5-lightning-free -z 'your question'
 *
 * `-z` is the non-interactive flag; without it Hermes opens a session and waits.
 *
 * Three things about a Hermes recording that are worth knowing before reading one, all measured
 * against v0.21.0 rather than reasoned about:
 *
 * **It does not work in the directory agenticreplay launched it in.** `_restore_session_cwd` in Hermes'
 * own CLI chdirs to the cwd stored in its session metadata, so a run started in a project reports
 * the home directory when asked, and writes land there. Per-turn filesystem diffs are taken of
 * the directory agenticreplay recorded from, so they read `0 changed` on a run that did change files --
 * the evidence is still in the trace, as the absolute path inside the `write_file` tool call.
 * `TERMINAL_CWD` is the lever, and the adapter deliberately does not pull it: forcing it would
 * make a recorded run write somewhere different from the same command uninstrumented, which is
 * the one thing an adapter here must never do. Export it yourself when you want the diffs.
 *
 * **How much of a multi-turn run replays depends on the recording, not on you.** Hermes makes a
 * one-message background call and abandons it, and where that lands decides the outcome. Landing
 * after the turns, a three-exchange recording replays `reused=3/3 exact=3 divergences=0`. Landing
 * between them, the matcher meets it where the recording has a three-message turn and strict
 * replay stops at `reused=1/3`; `--loose` carries the run to the same answer. Recording the same
 * task four times gave two of each, and each recording then replays the same way every time --
 * deterministic per recording, roughly even across them. The `unmatched=1` is that call in both
 * cases: the recording holds no answer for it, deliberately, because an exchange with no response
 * cannot be replayed.
 *
 * **The prompt carries Hermes' own skills catalogue, so a short one means a broken install.** It
 * is 14,058 characters and 19 tools, byte-identical across runs, and about 6,300 of that is an
 * `<available_skills>` block listing the 51 skills `hermes skills list` calls builtin -- Hermes'
 * content, not the operator's. A split install can hide it: `HERMES_HOME` is a persisted user
 * variable here, and a shell whose environment predates the install falls back to a home with no
 * skills directory, where the same prompt comes out 7,742 characters. That also degrades replay,
 * from `3/3 exact=3` to `1/3` on the same task -- which is worth knowing, because it looks
 * exactly like a matcher bug. Check `hermes skills list` first: 0 builtin means the harness cannot
 * find itself.
 */
export const hermesAdapter: Adapter = {
  id: 'hermes',
  aliases: ['hermes-agent', 'nous-hermes'],
  harnessVersions: '>=0.21.0',

  // Redirecting nothing is the intent, not a defect. See the `capture` field on `Adapter`.
  capture: 'transport',

  async detect(_cwd: string): Promise<boolean> {
    // `AppData/Local/hermes` is where the Windows install keeps `config.yaml`; the XDG paths are
    // the same directory on the other platforms. Home-relative, so an install moved with
    // `HERMES_HOME` is still found by its binary.
    return detectAgent(['hermes'], ['AppData/Local/hermes', '.config/hermes', '.hermes']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    // No origin and no credential. Hermes keeps both in `config.yaml` and its own secret store,
    // and an adapter that injected either would override a choice made there -- for the origin it
    // could not anyway, per the note above.
    return { command: 'hermes', args: [...ctx.userArgs], env: {} };
  },
};
