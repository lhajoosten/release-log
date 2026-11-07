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

AI output is not guaranteed to be reproducible. It is a separate artifact, and a provider failure must not prevent deterministic changelog generation. The provider, model, and exact context and output schemas remain to be selected.

## Initial scope

- A CLI, not a web application or hosted service.
- GitHub repositories only.
- Conventional commits and PR titles.
- Structured release context extracted from PR descriptions.
- Deterministic changelog generation before optional AI-assisted writing.

Exact policies for tag ancestry, supported merge strategies, PR association, missing context, and conventional syntax need concrete examples and tests before implementation.

## Status

Repository tooling is configured: Oxfmt, type-aware Oxlint, strict TypeScript, Lefthook, conventional commit/PR-title checks, and GitHub Actions CI. The CLI, GitHub integration, release validation rules, and AI integration are not implemented.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pinned toolchain, installation, commands, hooks, and CI. [AGENTS.md](AGENTS.md) defines guidance for coding agents.

## License

Licensed under the [MIT License](LICENSE.md).
