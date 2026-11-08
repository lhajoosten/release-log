# release-log

`release-log` is a GitHub-first TypeScript CLI project for deterministic changelogs and optional AI-assisted, user-facing release notes based on pull requests between Git tags.

## Current status

The project is in development. Local Git tag inspection, conventional metadata validation, and PR release-context parsing are implemented as tested components. A read-only PR metadata workflow is defined, but controlled GitHub rollout validation is still required. There is no packaged CLI, end-to-end release generation, release controller, publication, or AI integration yet.

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

## Maintaining these docs

The site renders the Markdown files in `docs/` with VitePress. See [Documentation site](github-pages.md) for preview commands, deployment setup, and publication limitations.
