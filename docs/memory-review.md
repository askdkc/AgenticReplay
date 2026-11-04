# Post-recording memory review

The CLI can keep a local review queue for finished recordings. The current CLI reports when the
Kiokuko connection needed to prepare and save proposals is unavailable.

Add this setting to the AgenticReplay config at
`$XDG_CONFIG_HOME/agenticreplay/config.json` or `~/.config/agenticreplay/config.json`.
Keep any existing keys in the file.

```json
{
  "memory_review": { "enabled": true }
}
```

From the same directory where you ran `agenticreplay record`, use the exact ID printed in
`memory_review.pending`.

```console
agenticreplay review run_0123456789ab --status
agenticreplay review run_0123456789ab
```

The second command serves a local page until Ctrl-C or SIGTERM. An interactive invocation on
macOS or Linux attempts to open the page. If the browser does not open, use the URL printed in
the terminal. Keep that URL private while the server is running.

| Source | Identity and boundary | Verified on 2026-11-04 |
| --- | --- | --- |
| AgenticReplay `record` | Exact local run ID, canonical Git worktree, sealed manifest and event stream, entire recorded process | A process exit can queue a review after the writer seals the recording. A nonzero code is shown as a process exit with an unverified task outcome. A signal or interrupt does not queue a review. |
| Codex desktop rollout | The current desktop chat's `session_meta.id` matched the chat ID. Its `task_started` event supplied `turn_id` and `root_turn_id`. | The observed runtime identified itself as `codex_work_desktop`, version `0.166.0-alpha.6`. This probe observed the start only. |
| Codex lifecycle hooks | `Stop` can cause continuation, `Interrupt` identifies an interrupted turn, and `SessionEnd` concerns the session lifecycle. | Documented event types. A live desktop completion or interrupt has yet to be correlated with a finalized AgenticReplay trace. |
| Codex app-server | A client can correlate `turn/completed` using its thread and turn identity and inspect the completion status. | Documented for the connecting client. Access to the running desktop app's events has yet to be established. |

See [OpenAI's hook configuration](https://developers.openai.com/plugins/build/plugins#bundle-lifecycle-hooks)
and the [app-server client flow](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Desktop review needs a verified producer that supplies both the completion event and the exact
recorded range. CLI review uses a whole recording, which can include multiple turns.

Review state lives under `.agenticreplay/reviews/<run-id>/` alongside the recording store.
It contains the source binding, revision, digest, and decision state. The original recording
and its export and upload formats are separate. Preview text and edits live in the running
review server. Edits stay in the browser on a failed submission. After the server stops, the
preparer reconstructs the proposal and any content change receives a new revision. Local
metadata stays until manually removed. After deleting a recording and stopping its review
server, the corresponding review directory can be removed as well. Keep discard records
while their source recordings exist to prevent duplicate notifications from offering them again.

## Kiokuko host integration

`ReviewPreparer` in `@agenticreplay/plugin-api` defines the read-only side of the handoff. A
trusted host integration receives the exact source binding and returns a repository-scoped
candidate or an explicit empty result. It must validate the full selected input, verify any
referenced blob bytes, and exclude secrets, system instructions, and private reasoning. The
review coordinator checks proposed text again before display and rejects obsolete revisions.

Kiokuko 1.0.56 exposes standalone interactive maintenance and native MCP elicitation. This
workflow needs a separate Kiokuko host interface for preparation, approved persistence, and
read-only reconciliation. The persistence request needs the source binding, exact reviewed
revision and digest, and a stable decision ID issued through the agreed approval channel.
The reconciliation request must use that same identity, including after restart or a lost
reply. Kiokuko owns repository scope validation, transactional deduplication, the save receipt,
and the tombstone that prevents a purged entry from returning.

The loopback page protects its own operations with origin and Host checks, a private URL,
and a form token. Processes running as the same OS user can still operate it. Save is disabled
until a Kiokuko host integration supplies an approved user-consent boundary. Review actions
in automated browser tests operate on disposable fixtures and establish UI behavior only.
