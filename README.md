# release-log

A GitHub-first TypeScript CLI for deterministic changelogs and AI-assisted, user-facing release notes based on pull requests between Git tags.

## Purpose

Release history should be accurate, reproducible, and understandable. Conventional commits and PR titles describe the kind of change; structured context in PR descriptions explains what changed and why it matters.

`release-log` will turn that information into two separate outputs:

- **A deterministic changelog:** generated from validated release data using explicit classification, grouping, and ordering rules.
- **User-facing release notes:** optionally written by AI from the same validated data, emphasizing user impact and avoiding unnecessary technical jargon.

## Planned approach

1. Resolve the previous and target tags to commit SHAs.
2. Identify commits reachable from the target but not the previous tag, rather than selecting PRs by merge date.
3. Associate those commits with merged GitHub PRs.
4. Validate conventional commit messages, conventional PR titles, and required structured release context in PR descriptions.
5. Capture the normalized release data so generation can be repeated without fetching mutable PR descriptions again.
6. Generate the changelog with stable grouping and ordering, without AI.
7. Optionally generate separate release notes through a structured AI input/output contract.

The same captured release data and generation configuration must produce the same changelog. Missing PR associations and invalid metadata must be surfaced explicitly rather than silently omitted.

## AI boundaries

AI does not determine release membership, change classification, or breaking-change status. Those come from Git history and explicit metadata interpreted by deterministic rules.

AI-written notes should explain supported user impact, preserve warnings and required actions, reference source PRs, and omit changes explicitly marked as internal. They must not invent capabilities or benefits absent from the supplied context.

AI output is not guaranteed to be reproducible. It is a separate artifact, and a provider failure must not prevent deterministic changelog generation. The AI provider, model, and AI input/output schemas remain to be selected.

## Initial scope

- A CLI, not a web application or hosted service.
- GitHub repositories only.
- Conventional commits and PR titles.
- Structured release context extracted from PR descriptions.
- Deterministic changelog generation before optional AI-assisted writing.

The [accepted release-policy ADR](docs/release-policy.md) defines bootstrap, membership, versioning, orchestration, and safety rules with worked acceptance examples. The [PR metadata gate](docs/pr-readiness.md) checks ordinary PR readiness using the [version 1 release-context format](docs/release-context.md); controlled GitHub rollout validation is still required.

## Status

Core Git/PR collection, snapshots, version planning, and changelog rendering are implemented with tests. A locally packable [CLI](docs/cli.md) exposes explicit online collection and offline planning/rendering, with dry-run or opt-in writes for root `package.json` and static `pyproject.toml` versions. A first-cycle [proposal controller](docs/release-proposal.md) and read-only [approval verifier](docs/release-approval.md) are available with explicit trust and rollout limitations. [Publication reconciliation and the explicit-write GitHub executor](docs/release-publication.md) inspect or execute approved tag/Release/asset steps with documented trust and retry limits; no workflow enables publication. Component boundaries are documented in `docs/` alongside `src/`. The read-only PR metadata workflow has documented rollout limitations; a deployed release controller, image publisher, authenticated publication host and AI integration are not implemented.

## Documentation

Start with the [documentation overview](docs/index.md) for component guides and current implementation status. The [documentation site guide](docs/github-pages.md) covers local previewing and GitHub Pages setup; deployment requires a separate repository-settings step.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pinned toolchain, installation, commands, hooks, and CI. [AGENTS.md](AGENTS.md) defines guidance for coding agents.

## License

Licensed under the [MIT License](LICENSE.md).
