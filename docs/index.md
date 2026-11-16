# release-log

`release-log` is a GitHub-first TypeScript CLI project for deterministic changelogs and optional AI-assisted, user-facing release notes based on pull requests between Git tags.

## Current status

Git inspection, PR association, validated snapshots, version planning, and deterministic changelog rendering are implemented with tests and a locally packable CLI. Node and Python version manifests are supported. This repository runs the [rolling-release workflow](release-workflow.md) with source-pinned tool/workflow revisions and proposal/tag writes enabled. Its first live cycle refreshed [release PR #62](https://github.com/lhajoosten/release-log/pull/62), then tagged its exact manual-merge landing as `v0.1.0`. Subsequent self-use releases `v0.2.0` and `v0.2.1` also completed from their prior tags, preserving the original released section. A private sandbox separately demonstrated same-PR refresh, a subsequent `v0.1.0` → `v0.2.0` cycle with byte-preserved released changelog content, exact-landing tagging without a recursive proposal, and a successful matching-tag retry with unchanged refs/files. [Evidence and remaining live validation](release-workflow.md#live-evidence-and-remaining-validation) distinguish those results from outstanding controlled safety/recovery exercises and independent consumer adoption.

The npm package remains private at `0.2.1`. The Linux/amd64 GHCR image `v0.2.1` is published with verified anonymous pull/run access; see the [installation commands and evidence](container-release.md). The authorized same-event retry retained the digest with `reused: true` and no push. No npm package or GitHub Release assets are distributed. AI-written release notes remain unimplemented, with no provider/model configured. Existing approval/publication APIs are separate components; downstream publication belongs to each repository. The read-only [PR metadata workflow](pr-readiness.md) retains rollout limitations.

For development setup and repository checks, see the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md).

## Release flow

1. After an ordinary merge, inspect the full range from the released version tag to captured main.
2. Associate commits with merged GitHub PRs and validate their conventional metadata and release context.
3. Capture inputs and deterministically regenerate the next version, manifests, and pending changelog.
4. Create or append a non-force commit to the one release PR; a human reviews and manually merges it.
5. Tag that exact release landing without starting another release roll. Repository-owned downstream jobs react to the tag.

AI must not determine release membership, classification, or breaking-change status. It should preserve supported user impact, warnings, required actions, and source PR references. Ordinary changelog generation must not require AI credentials or an available provider.

The [accepted release policy](release-policy.md) defines bootstrap, membership, versioning, orchestration, and safety rules with worked acceptance examples. The [repository README](https://github.com/lhajoosten/release-log#readme) describes the product direction in more detail.

## Start here

- To run the CLI: use the [published image and digest](container-release.md#pull-and-run), then follow the [mounted-input examples](container.md#run-with-mounted-inputs) and [command reference](cli.md).
- To automate a repository: read the [rolling workflow setup and recovery](release-workflow.md), select its [initial adoption boundary](initial-adoption.md), and configure [PR metadata/context](pr-readiness.md).
- To contribute: follow the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md) and run `pnpm verify`.

## Core workflow and deterministic components

- [Rolling release workflow](release-workflow.md): the accepted scope, manual-merge/automatic-tag lifecycle, source-pinned live caller, successive sandbox cycles, matching-tag retry evidence, and remaining validation.
- [Release policy](release-policy.md): deterministic membership, metadata, versioning, and changelog rules.
- [Initial adoption](initial-adoption.md): start a reviewed first release without rewriting legacy PRs, with a fixed cutoff and strict rules for new changes.
- [PR metadata readiness](pr-readiness.md): understand the read-only gate, diagnostics, and rollout limitations.
- [PR release context](release-context.md): author the version 1 `release-log` block and understand its validation rules.
- [Conventional metadata](conventional-metadata.md): understand commit and PR-title parsing, including breaking-change declarations.
- [Git range inspection](git-tag-range.md): inspect tag-to-tag or baseline-to-SHA commit membership, including explicit bootstrap, without network calls.
- [GitHub PR association](github-association.md): collect merged PR evidence for a captured range, verify landing footprints, and understand failure/automation boundaries.
- [Release input snapshots](release-snapshot.md): validate and serialize captured inputs, then replay them offline under the same configuration and normalization policy.

- [Release version planning](release-plan.md): calculate the next version or an explicit no-release result from validated snapshots.

- [Deterministic changelog](changelog.md): render escaped release entries and update a digest-checked pending section without rewriting released content.

- [Deterministic CLI](cli.md): route rolling release events, collect online, replay/plan/render offline, and prepare Node/Python proposal files with explicit opt-in writes.

- [Read-only release rehearsal](release-rehearsal.md): exercise the installed CLI against an explicit main baseline without creating proposals or publishing.

- [Rolling release proposal controller](release-proposal.md): preview or explicitly create/refresh a proposal, with conflict checks and remaining safety gates.

- [Container runtime and local builds](container.md): build and smoke-test the packaged CLI in a pinned Linux/amd64 image.
- [Stable-tag container publication](container-release.md): the accepted GHCR contract, version/digest identity, gates, verified publication/pull evidence and safe retry procedures.
- [Container vulnerability review](container-security.md): dated published-image scan results and historical remediation evidence.
- [Container distribution decision](adr/0001-container-distribution.md): accepted architecture and sole-writer requirement.

## Separate approval and publication APIs

These components remain available for explicitly designed integrations. They are not prerequisites for the active rolling workflow or stable-tag GHCR publisher, and their host/credential paths have separate validation limits.

- [Read-only approval verification](release-approval.md): verify an independently recorded reviewed proposal against its actual merge/squash landing.
- [Verified automation exclusions](automation-exclusions.md): retain complete captured graphs with independently pinned approval-backed exclusions.
- [Publication reconciliation and GitHub execution](release-publication.md): inspect receipt-bound outputs or explicitly execute GitHub tag/Release/asset steps.

## Maintaining these docs

The site renders the Markdown files in `docs/` with VitePress. See [Documentation site](github-pages.md) for preview commands, deployment setup, and publication limitations.
