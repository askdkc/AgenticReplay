# Record Codex launched from the Dock

The macOS service is for the built-in OpenAI provider with ChatGPT sign-in. Registration applies to one Codex profile per user. Run registration from a Git worktree that you explicitly want to record.

```sh
agenticreplay codex-service register
agenticreplay codex-service status --json
```

Quit and reopen Codex from the Dock after initial registration. Register from another worktree to add it to the allowlist. Registration from the same worktree is safe to repeat. A running job reloads the allowlist when another worktree is registered. Status reports `running`, `stopped`, `configuration_changed`, `disabled`, or `unsupported`. A running status includes `socketPath`, `baseUrl`, and the canonical `worktrees`.

The service binds IPv4 loopback and forwards API traffic to ChatGPT over verified HTTPS. It records only requests whose turn metadata identifies exactly one registered Git worktree. Other requests are forwarded without being written to a trace. Each authorized worktree keeps its own `.agenticreplay/runs`. The service manages its own top-level `openai_base_url`; a pre-existing value is a registration conflict. `chatgpt_base_url` and model selection stay with the user. `register --config <path>` selects an existing alternative profile when its launcher actually reads that file.

The service uses a user LaunchAgent and is restarted by launchd. No system proxy, custom app launcher, or installed certificate is required. The owner-only review socket is under `~/.agenticreplay/codex-dock/`. Query it with one newline-terminated JSON object `{cwd, sessionId, turnId}`. A complete recording returns `{status:"sealed", traceDirectory}`. An unfinished or not-yet-seen turn returns `pending`. A rejected scope or a capture that cannot prove a complete exchange returns `unavailable`. The live lookup cache is bounded. A recorder restart may make an earlier identity undiscoverable through the socket even though its trace files are still on disk.

Registration uses a stable Node launcher from `PATH`, such as `/opt/homebrew/bin/node`,
and preserves that symlink instead of saving its version-specific target. The CLI
installation must also have a stable path. Versioned runtime locations are rejected.
Normal Node updates can replace the symlink target without changing the service.
For an older registration that saved a deleted runtime, run `register` again from
an authorized worktree. It refreshes the owned launch definition and reloads it in
launchd, preserving the profile, service port, and registered worktrees. Repeating
registration with the same launch definition does not restart a healthy service.

The explicit `record codex --desktop` command can launch the app and use the active service for a registered worktree. With the service disabled, it uses the scoped recorder for the launched process. Per-run TLS flags apply to the scoped recorder.

To remove the service, quit Codex first so the current process releases the old endpoint, then run:

```sh
agenticreplay codex-service disable
```

The command removes only the endpoint it owns and preserves other edits, then unloads the LaunchAgent. If the managed value was edited in place and still points at the service, it reports the conflict and leaves the relay running. Reopen Codex from the Dock after a successful disable.
