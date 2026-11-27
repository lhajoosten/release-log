# Set up Rolling Release

Use a GitHub repository whose release branch is `main`. Install a GitHub App with repository contents and pull request write access. Set `RELEASE_APP_ID`, `ROLLING_RELEASE_BOT` (the App login including `[bot]`) and the secret `RELEASE_APP_PRIVATE_KEY`. Allow the publication job to write the repository's GHCR package. Reserve the two branches `release/next` and `release/changelog-backfill` for this App. Make the release workflow the sole writer of version and candidate image tags.

Copy the release-cycle, release-quality and manual backfill callers from the provider's examples. Set their provider references to the same reviewed provider revision that contains the replacement workflows. The proposed `consumer-v1` channel needs to be activated before a consumer can use that ref. For the first release without a stable tag, set `ROLLING_RELEASE_START_SHA` to the reviewed exclusive starting commit. The first releasable batch starts at 0.1.0. Returning consumers can adopt an existing stable tag.

Use conventional PR titles. A feature bumps minor, a fix, performance improvement or revert bumps patch, and a breaking title bumps major (minor before 1.0). Documentation and maintenance wait for the next releasable batch. An optional single `Required action: ...` line in a PR description appears in the changelog.

Manually dispatch the release cycle to preview. After an ordinary PR lands the App refreshes one release PR. Review its changelog, version changes and captured metadata. Merging it authorizes a tag at the landing, a versioned Docker image and a GitHub Release with the reviewed notes. Configure your consumer Dockerfile at the repository root. Inspect the source and digest reported by GHCR when recovering publication.

Run the separate manual changelog backfill to reconstruct historical sections from stable tags and available PR metadata. Review its changelog-only PR. If another PR merges into `main` first, rerun backfill before merging so the proposal includes the current tree. A missing or ambiguous association blocks the rebuild and identifies the affected release.

## Version files

| Project | Managed files                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm     | Root and shared `package.json` versions and first-party references, plus `package-lock.json` or `npm-shrinkwrap.json` mirrors                                                  |
| pnpm    | Shared packages selected by `pnpm-workspace.yaml` and their local importer entries in `pnpm-lock.yaml`                                                                         |
| Bun     | Shared package manifests and the text `bun.lock` format. Migrate older binary `bun.lockb` with Bun before adoption.                                                            |
| Python  | Static versions in `pyproject.toml`; local project entries in `uv.lock` or Poetry 2.1 lockfiles. Generated or backend-computed versions require a static version for adoption. |
| Rust    | Single crates and shared Cargo workspaces with inherited versions, local dependency requirements, and `Cargo.lock`                                                             |

In uv workspaces, members inherit dependency sources from the root and can override individual sources. The planner updates a pin when the effective source is unconditionally local. If a workspace source is conditional and the planner cannot establish that the pin is local in every case, it stops and names the dependency for review before rewriting the pin.

The writer expects participating packages to share the previous stable version. Ambiguous ownership or independently versioned packages require maintainer review. An image-only repository can release using the changelog and reviewed record alone.

The review record also retains the provider commit that generated it. Quality, promotion and publication select that producer from verified provider history for replay. If it is unavailable, restore access to the reviewed provider revision and rerun the original release event. Set `RELEASE_LOG_WRITE_ENABLED=false` to pause automatic writes while retaining manual preview.
