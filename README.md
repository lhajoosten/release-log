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
4. Validate conventional commit messages, conventional PR titles, and structured release context in PR descriptions under a trusted required/optional policy.
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

Consumers may configure [optional PR release context](docs/release-context.md#consumer-context-policy); omission preserves strict validation, and this repository explicitly keeps context required.

The [accepted release-policy ADR](docs/release-policy.md) defines bootstrap, membership, versioning, orchestration, and safety rules with worked acceptance examples. The [PR metadata gate](docs/pr-readiness.md) checks ordinary PR readiness using the [version 1 release-context format](docs/release-context.md); controlled GitHub rollout validation is still required.

## Release automation scope

The [accepted rolling-release workflow](docs/release-workflow.md) maintains one release PR as ordinary changes merge: calculate the next version, update Node/Python manifests, and regenerate the pending changelog. A human reviews and manually merges that PR; the workflow then tags the exact landing without starting another release roll. The tag is the next release boundary and the handoff to repository-owned image, packaging, IaC, or deployment jobs. A GitHub App supplies the bot identity; custom approval receipts and publication orchestration are not required. This repository runs the source-pinned caller with proposal/tag writes enabled; its [first live cycle and remaining validation](docs/release-workflow.md#live-evidence-and-remaining-validation) are documented separately from downstream publication.

## Status

Core Git/PR collection, snapshots, version planning, and changelog rendering are implemented with tests. A locally packable [CLI](docs/cli.md) exposes online collection and offline planning/rendering, with dry-run or opt-in writes for root `package.json` and static `pyproject.toml` versions. The live rolling-release caller maintains proposals and tags manually merged release PRs. The first release, [v0.1.0](https://github.com/lhajoosten/release-log/tree/v0.1.0), tags the exact landing of [PR #62](https://github.com/lhajoosten/release-log/pull/62). Subsequent tag-bound cycles and controlled safety/recovery exercises remain to be validated live; see the [evidence and limits](docs/release-workflow.md#live-evidence-and-remaining-validation).

The package is private at `0.1.0`. Local/runner tarball packaging and CI container builds are available, but this rollout delivered no GitHub Release, downloadable CLI assets, npm package, or published OCI image. Installation/distribution remains open. AI-written notes are unimplemented; no provider or model is configured.

The separate [approval verifier](docs/release-approval.md) and [publication reconciliation/GitHub executor](docs/release-publication.md) retain their documented trust and retry limits. They are not prerequisites for the rolling-release flow, and no workflow enables the publication executor. Downstream publication remains consumer-owned. The read-only [PR metadata gate](docs/pr-readiness.md) retains rollout limitations.

## Documentation

Start with the [documentation overview](docs/index.md) for component guides and current implementation status. The [documentation site guide](docs/github-pages.md) covers local previewing and GitHub Pages setup; deployment requires a separate repository-settings step.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pinned toolchain, installation, commands, hooks, and CI. [AGENTS.md](AGENTS.md) defines guidance for coding agents.

## License

Licensed under the [MIT License](LICENSE.md).
