# release-log

`release-log` is a GitHub-first TypeScript CLI project for deterministic changelogs and optional AI-assisted, user-facing release notes based on pull requests between Git tags.

## Current status

The project is in development. Git inspection, PR association, validated snapshots, version planning, and deterministic changelog rendering are implemented as tested components, with a locally packable CLI. Node and Python version manifests are supported. A read-only PR metadata workflow is defined, but rollout limitations remain. There is no deployed release controller, publication, or AI integration yet.

These docs describe the available components and their boundaries, not a released command-line interface. For development setup and repository checks, see the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md).

## Intended release flow

1. Resolve the previous and target Git tags and inspect the commits between them.
2. Associate those commits with merged GitHub PRs, rather than selecting PRs by merge date.
3. Validate conventional metadata and structured release context from PR descriptions.
4. Capture normalized release data for repeatable generation.
5. Generate a deterministic changelog, with optional AI-written release notes as a separate artifact.

AI must not determine release membership, classification, or breaking-change status. It should preserve supported user impact, warnings, required actions, and source PR references. Ordinary changelog generation must not require AI credentials or an available provider.

The [accepted release policy](release-policy.md) defines bootstrap, membership, versioning, orchestration, and safety rules with worked acceptance examples. The [repository README](https://github.com/lhajoosten/release-log#readme) describes the product direction in more detail.

## Component guides

- [Release policy](release-policy.md): review the accepted release contract and automation architecture.
- [PR metadata readiness](pr-readiness.md): understand the read-only gate, diagnostics, and rollout limitations.
- [PR release context](release-context.md): author the version 1 `release-log` block and understand its validation rules.
- [Conventional metadata](conventional-metadata.md): understand commit and PR-title parsing, including breaking-change declarations.
- [Git range inspection](git-tag-range.md): inspect tag-to-tag or baseline-to-SHA commit membership, including explicit bootstrap, without network calls.
- [GitHub PR association](github-association.md): collect merged PR evidence for a captured range, verify landing footprints, and understand failure/automation boundaries.
- [Release input snapshots](release-snapshot.md): validate and serialize captured inputs, then replay them offline under the same configuration and normalization policy.

- [Release version planning](release-plan.md): calculate the next version or an explicit no-release result from validated snapshots.

- [Deterministic changelog](changelog.md): render escaped release entries and update a digest-checked pending section without rewriting released content.

- [Deterministic CLI](cli.md): collect online, replay/plan/render offline, and prepare Node/Python proposal files with explicit opt-in writes.

- [Read-only release rehearsal](release-rehearsal.md): exercise the installed CLI against an explicit main baseline without creating proposals or publishing.

- [Rolling release proposal controller](release-proposal.md): preview or explicitly create/refresh a draft proposal, with conflict checks and remaining safety gates.

- [Read-only approval verification](release-approval.md): verify an independently recorded reviewed proposal against its actual merge/squash landing, without publishing.

## Maintaining these docs

The site renders the Markdown files in `docs/` with VitePress. See [Documentation site](github-pages.md) for preview commands, deployment setup, and publication limitations.
