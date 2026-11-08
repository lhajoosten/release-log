# release-log

`release-log` is a GitHub-first TypeScript CLI project for deterministic changelogs and optional AI-assisted, user-facing release notes based on pull requests between Git tags.

## Current status

The project is in development. Local Git tag inspection, conventional metadata validation, and PR release-context parsing are implemented as tested components. There is no packaged CLI, end-to-end release generation, GitHub integration, or AI integration yet.

These docs describe the available components and their boundaries, not a released command-line interface. For development setup and repository checks, see the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md).

## Intended release flow

1. Resolve the previous and target Git tags and inspect the commits between them.
2. Associate those commits with merged GitHub PRs, rather than selecting PRs by merge date.
3. Validate conventional metadata and structured release context from PR descriptions.
4. Capture normalized release data for repeatable generation.
5. Generate a deterministic changelog, with optional AI-written release notes as a separate artifact.

AI must not determine release membership, classification, or breaking-change status. It should preserve supported user impact, warnings, required actions, and source PR references. Ordinary changelog generation must not require AI credentials or an available provider.

Release policies for tag ancestry, merge strategies, PR association, and historical or missing context still need to be defined. The [repository README](https://github.com/lhajoosten/release-log#readme) describes the product direction in more detail.

## Component guides

- [PR release context](release-context.md): author the version 1 `release-log` block and understand its validation rules.
- [Conventional metadata](conventional-metadata.md): understand commit and PR-title parsing, including breaking-change declarations.
- [Git tag inspection](git-tag-range.md): inspect exact tag endpoints and commit membership without network calls.

## Maintaining these docs

The site renders the Markdown files in `docs/` with VitePress. See [Documentation site](github-pages.md) for preview commands, deployment setup, and publication limitations.
