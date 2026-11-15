# release-log

`release-log` is a GitHub-first TypeScript CLI project for deterministic changelogs and optional AI-assisted, user-facing release notes based on pull requests between Git tags.

## Current status

Git inspection, PR association, validated snapshots, version planning, and deterministic changelog rendering are implemented with tests and a locally packable CLI. Node and Python version manifests are supported. This repository runs the [rolling-release workflow](release-workflow.md) with source-pinned tool/workflow revisions and proposal/tag writes enabled. Its first live cycle refreshed [release PR #62](https://github.com/lhajoosten/release-log/pull/62), then tagged its exact manual-merge landing as `v0.1.0`. A private sandbox has since demonstrated same-PR refresh, a subsequent `v0.1.0` → `v0.2.0` cycle with byte-preserved released changelog content, exact-landing tagging without a recursive proposal, and a successful matching-tag retry with unchanged refs/files. [Evidence and remaining live validation](release-workflow.md#live-evidence-and-remaining-validation) distinguish those results from outstanding controlled safety/recovery exercises and production subsequent-cycle validation.

The package remains private at `0.1.0`. Runner/local tarball packaging and CI container builds do not establish published distribution: this rollout delivered no GitHub Release, downloadable CLI assets, npm package, or published OCI image. AI-written release notes remain unimplemented, with no provider/model configured. Existing approval/publication APIs are separate components; downstream publication belongs to each repository. The read-only [PR metadata workflow](pr-readiness.md) retains rollout limitations.

For development setup and repository checks, see the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md).

## Release flow

1. After an ordinary merge, inspect the full range from the released version tag to captured main.
2. Associate commits with merged GitHub PRs and validate their conventional metadata and release context.
3. Capture inputs and deterministically regenerate the next version, manifests, and pending changelog.
4. Create or append a non-force commit to the one release PR; a human reviews and manually merges it.
5. Tag that exact release landing without starting another release roll. Repository-owned downstream jobs react to the tag.

AI must not determine release membership, classification, or breaking-change status. It should preserve supported user impact, warnings, required actions, and source PR references. Ordinary changelog generation must not require AI credentials or an available provider.

The [accepted release policy](release-policy.md) defines bootstrap, membership, versioning, orchestration, and safety rules with worked acceptance examples. The [repository README](https://github.com/lhajoosten/release-log#readme) describes the product direction in more detail.

## Component guides

- [Rolling release workflow](release-workflow.md): the accepted scope, manual-merge/automatic-tag lifecycle, source-pinned live caller, successive sandbox cycles, matching-tag retry evidence, and remaining validation.
- [Release policy](release-policy.md): deterministic membership, metadata, versioning, and changelog rules.
- [Initial adoption](initial-adoption.md): start a reviewed first release without rewriting legacy PRs, with a fixed cutoff and strict rules for new changes.
- [PR metadata readiness](pr-readiness.md): understand the read-only gate, diagnostics, and rollout limitations.
- [PR release context](release-context.md): author the version 1 `release-log` block and understand its validation rules.
- [Conventional metadata](conventional-metadata.md): understand commit and PR-title parsing, including breaking-change declarations.
- [Git range inspection](git-tag-range.md): inspect tag-to-tag or baseline-to-SHA commit membership, including explicit bootstrap, without network calls.
- [GitHub PR association](github-association.md): collect merged PR evidence for a captured range, verify landing footprints, and understand failure/automation boundaries.
- [Verified automation exclusions](automation-exclusions.md): collect and replay complete graphs with independently pinned release-automation evidence, without dropping ordinary changes.
- [Release input snapshots](release-snapshot.md): validate and serialize captured inputs, then replay them offline under the same configuration and normalization policy.

- [Release version planning](release-plan.md): calculate the next version or an explicit no-release result from validated snapshots.

- [Deterministic changelog](changelog.md): render escaped release entries and update a digest-checked pending section without rewriting released content.

- [Deterministic CLI](cli.md): route rolling release events, collect online, replay/plan/render offline, and prepare Node/Python proposal files with explicit opt-in writes.

- [Read-only release rehearsal](release-rehearsal.md): exercise the installed CLI against an explicit main baseline without creating proposals or publishing.

- [Rolling release proposal controller](release-proposal.md): preview or explicitly create/refresh a proposal, with conflict checks and remaining safety gates.

- [Read-only approval verification](release-approval.md): verify an independently recorded reviewed proposal against its actual merge/squash landing, without publishing.

- [Publication reconciliation and GitHub execution](release-publication.md): inspect approved outputs or explicitly execute GitHub tag/Release/asset steps, with documented trust, retry and rollout limits.

- [Container runtime and local builds](container.md): build and smoke-test the packaged CLI in a pinned Linux/amd64 image.
- [Stable-tag container publication](container-release.md): the accepted GHCR contract, version/digest identity, gates, safe retries and pending live publication/pull verification.

## Maintaining these docs

The site renders the Markdown files in `docs/` with VitePress. See [Documentation site](github-pages.md) for preview commands, deployment setup, and publication limitations.
