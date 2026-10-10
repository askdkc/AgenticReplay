# Releasing

## npm CLI

Publish the repository root as `agenticreplay`. It declares the CLI binary and bundles the
internal workspace libraries and their runtime dependencies. Publishing the CLI does not require
an `@agenticreplay` npm organization or separate library uploads.

Use Node 24 or newer and an npm account authorized to publish `agenticreplay`. The checkout has
`ci.yml`; it does not currently contain an automatic npm release workflow.

From a clean checkout, this standard command updates all workspace versions and internal pins,
reconciles the lockfile, and includes every manifest in the release commit and tag:

```console
npm version patch -m "chore(release): v%s"
npm ci
npm run check
node scripts/installed-smoke.mjs
npm audit
npm publish
```

The root `version` lifecycle runs `scripts/npm-version.mjs` after npm bumps the root version.
For a metadata-only bump without staging, committing, or tagging, use
`npm version patch --no-git-tag-version`. For a specific version without Git operations,
`node scripts/set-version.mjs 0.1.2 --lock` remains available. Do not disable scripts when using
`npm version`: that would skip synchronization. Neither version command pushes or publishes.

`npm publish` runs `prepack`, which builds the CLI and validates internal dependency versions.
The resulting package includes the executable, quickstart assets, and bundled runtime libraries.
Do not use `--workspace=agenticreplay` for this release: that selects the development CLI
workspace, whose hoisted dependencies are not bundled into its archive.

To create an actual archive without publishing:

```console
npm pack
# agenticreplay-<version>.tgz
```

`npm pack --dry-run` previews the file list without writing an archive. `npm publish --dry-run`
checks packaging without uploading. Both still run the build lifecycle unless scripts are disabled.
Avoid `--ignore-scripts` when releasing, because it skips that build.

A published version cannot be replaced. After changes to an already published version, choose a
new version before publishing again. `--tag next` can be used for a prerelease without changing
`latest`.

## The three Python packages

They are not part of the npm release and do not share its version. Each ships on its own tag:

| package | source | tag | workflow |
| --- | --- | --- | --- |
| `agenticreplay-trace` — the read-only reader for the trace format | `python/` | `py-v<version>` | `release-python.yml` |
| `agenticreplay-openai-agents` — records the Agents SDK's own run structure | `python-openai-agents/` | `agents-v<version>` | `release-openai-agents.yml` |
| `agenticreplay-langgraph` — records which LangGraph node ran, and in which superstep | `python-langgraph/` | `langgraph-v<version>` | `release-langgraph.yml` |

```console
# edit the version in the package's pyproject.toml, merge that, then:
git tag agents-v0.1.0 && git push origin agents-v0.1.0
```

Each workflow refuses a tag that disagrees with its own `pyproject.toml`, runs the package's tests,
builds, and `twine check`s before it uploads — the same gate the npm release applies, for the same
reason. **Actions → Release (…) → Run workflow** with *dry run* left checked does everything except
the upload, which is how to find out whether a release would work without making one.

> **Why four workflows rather than one.** A Python-only fix must not force a version bump across
> twelve npm packages, and the npm publish must not fail because PyPI had a bad day. The Python
> packages are separated from each other for the same reason: they share a repository and nothing
> else, so one tag publishing several would make every `agenticreplay-trace` fix reissue the adapters — and
> PyPI does not allow reusing a version number.

## Workspace version validation

`scripts/publish-order.mjs` verifies exact internal dependency pins and rejects mismatched versions
or dependency cycles. Root `prepack` invokes it with `--quiet`. Its default output is useful if
publishing individual libraries separately; that route still requires ownership of the scope.

## Verifying the installed package

`node scripts/installed-smoke.mjs` creates one root archive, installs it offline in an empty
consumer directory with a fresh cache, and exercises help, record, show, export, replay, and MCP.
Installing all workspace tarballs together would mask missing bundled dependencies.

After publishing, check the registry installation too:

```console
npm i -g agenticreplay
agenticreplay --version
agenticreplay quickstart
```
