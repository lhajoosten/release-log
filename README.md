# Rolling Release

Rolling Release is a GitHub Actions release bot for repositories that ship one shared, stable version from `main`. It turns the titles of merged pull requests into a changelog, updates package versions and lockfiles, and keeps those changes together in one standalone release PR. **Merging that release PR is how a maintainer approves a release.**

<img width="2172" height="724" alt="image" src="https://github.com/user-attachments/assets/e414345c-7151-4dbc-8277-d2791a54e147" />

## From merged PR to published release

1. **Merge ordinary PRs into `main`.** The bot finds the changes introduced since the last stable tag using Git ancestry and GitHub PR identities. This works with squash merges and supported stacked PRs. A missing or ambiguous association names the blocking commit.
2. **Review one accumulating release PR.** The first releasable change opens `release/next`. Later merges refresh the same PR. It contains the next version, the changelog, the applicable manifest and lockfile edits, and a small reviewed record. Earlier changelog sections keep their original bytes.
3. **Merge when ready to ship.** The bot verifies the reviewed files and tags the exact commit where the release PR landed. It publishes the versioned Docker image to GHCR and creates a GitHub Release with the same reviewed notes. A retry verifies existing outputs and finishes missing work, even after `main` has advanced.

## How titles determine the version

| Merged PR title                                   | Effect from `v1.2.3`                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `feat(export): add CSV export`                    | Minor → `v1.3.0`                                                        |
| `fix: retain export settings`                     | Patch → `v1.2.4`. Performance improvements and reverts also bump patch. |
| `feat(api)!: remove the old endpoint`             | Major → `v2.0.0`. A breaking change before 1.0 bumps minor.             |
| `docs: explain exports` or `chore: update checks` | Waits for the next releasable batch.                                    |

The highest bump in a batch wins. The title description supplies the changelog text, with a link to the PR and credit for its author when available. A single optional `Required action: ...` line in the PR description supplies a migration instruction. The renderer groups entries under ✨ Features, 🐛 Fixes, 📚 Documentation, 🛠️ Required actions and 🔧 Internal maintenance, omits empty sections, and ends each release after the first with a linked `Full changelog v1.2.3...v1.3.0`.

## What the bot updates

The release PR synchronizes supported npm, pnpm and Bun manifests and lockfiles, static Python projects using Poetry or uv, and Cargo packages and workspaces. Shared-version workspace members move together. The [consumer guide](docs/consumer-setup.md) covers setup, supported file formats and the reviewed starting commit for a first release.

The current release PR stores its captured inputs in `.rolling-release/review.json`. This small record binds the reviewed titles, credits, required actions and generated file digests to their source commit. The bot can verify the landing and reproduce the notes even after someone edits a PR on GitHub. The older `.release-log/inputs.json` is only relevant when identifying historical releases created by earlier versions of the bot.

## Preview and historical backfill

Manually dispatch the release cycle to preview the next proposal without writing to GitHub. To replace an old or missing changelog, run the separate manual `changelog-backfill.yaml` workflow. It walks historical stable tags and their PRs, renders the same format, and opens a changelog-only review PR. It uses the available historical PR metadata and reports incomplete evidence.

See the [release contract and example changelog](docs/spec/186-release-cycle.md), [workflow operations](docs/release-workflow.md), and [container publication details](docs/container-release.md).
