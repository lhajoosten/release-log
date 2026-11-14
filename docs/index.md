# release-log

`release-log` is a GitHub-first TypeScript CLI project for deterministic changelogs and optional AI-assisted, user-facing release notes based on pull requests between Git tags.

## Current status

The project is in development. Git inspection, PR association, validated snapshots, version planning, and deterministic changelog rendering are implemented as tested components, with a locally packable CLI. Node and Python version manifests are supported. A read-only PR metadata workflow is defined, but rollout limitations remain. The [accepted rolling-release workflow](release-workflow.md) is narrower: maintain one release PR, let a human merge, and tag the exact landing automatically. That workflow is not deployed. Existing approval/publication APIs are separate components, not prerequisites for the release roll; downstream publication belongs to each repository.

These docs describe the available components and their boundaries, not a released command-line interface. For development setup and repository checks, see the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md).

## Intended release flow

1. After an ordinary merge, inspect the full range from the released version tag to captured main.
2. Associate commits with merged GitHub PRs and validate their conventional metadata and release context.
3. Capture inputs and deterministically regenerate the next version, manifests, and pending changelog.
4. Create or append a non-force commit to the one release PR; a human reviews and manually merges it.
5. Tag that exact release landing without starting another release roll. Repository-owned downstream jobs react to the tag.

AI must not determine release membership, classification, or breaking-change status. It should preserve supported user impact, warnings, required actions, and source PR references. Ordinary changelog generation must not require AI credentials or an available provider.

The [accepted release policy](release-policy.md) defines bootstrap, membership, versioning, orchestration, and safety rules with worked acceptance examples. The [repository README](https://github.com/lhajoosten/release-log#readme) describes the product direction in more detail.

## Component guides

- [Rolling release workflow](release-workflow.md): the accepted scope, manual-merge/automatic-tag lifecycle, bot setup, and remaining implementation work.
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

- [Deterministic CLI](cli.md): collect online, replay/plan/render offline, and prepare Node/Python proposal files with explicit opt-in writes.

- [Read-only release rehearsal](release-rehearsal.md): exercise the installed CLI against an explicit main baseline without creating proposals or publishing.

- [Rolling release proposal controller](release-proposal.md): preview or explicitly create/refresh a draft proposal, with conflict checks and remaining safety gates.

- [Read-only approval verification](release-approval.md): verify an independently recorded reviewed proposal against its actual merge/squash landing, without publishing.

- [Publication reconciliation and GitHub execution](release-publication.md): inspect approved outputs or explicitly execute GitHub tag/Release/asset steps, with documented trust, retry and rollout limits.

- [Local OCI distribution](container.md): build and smoke-test the packaged CLI in a pinned Linux/amd64 image without publishing it.

## Maintaining these docs

The site renders the Markdown files in `docs/` with VitePress. See [Documentation site](github-pages.md) for preview commands, deployment setup, and publication limitations.
