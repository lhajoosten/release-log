# Contributing

## Local setup

Use Node.js **26.13.0** and pnpm **12.14.0**, pinned by `.node-version` and `package.json`. With fnm already installed, `fnm install` and `fnm use` select the project runtime. Install the pinned pnpm version separately if needed; Node.js 26 does not bundle Corepack.

From the repository root:

```sh
pnpm install --frozen-lockfile

pnpm verify
```

Installation runs `prepare` to install Lefthook's Git hooks in this checkout. If hooks need reinstalling, run `pnpm exec lefthook install`. Review dependency and lifecycle changes before installing untrusted code.

Lefthook's dependency-level postinstall is explicitly disabled in `pnpm-workspace.yaml`; its platform binary is supplied by an optional dependency, and the root `prepare` command installs the hooks. Unreviewed dependency build scripts remain blocked by pnpm.

CI uses `--ignore-scripts` because it runs checks directly and does not need local Git hooks.

## Commands

| Command                                                | Purpose                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm format`                                          | Format supported maintained files with Oxfmt.                           |
| `pnpm check:format`                                    | Check formatting without changing files.                                |
| `pnpm check:lint`                                      | Run type-aware Oxlint; warnings and unused suppression directives fail. |
| `pnpm check:types`                                     | Run strict TypeScript checks without emitting files.                    |
| `pnpm check`                                           | Run formatting, lint, types, and tests sequentially.                    |
| `pnpm test`                                            | Run Node.js tests with coverage reporting.                              |
| `pnpm verify`                                          | Run formatting, lint, types, and tests.                                 |
| `pnpm check:commits --from <base-sha> --to <head-sha>` | Validate a Git commit range with Commitlint.                            |

Dependencies are exact-pinned and the pnpm lockfile is committed. Generated lockfile formatting is left to pnpm, not Oxfmt.

Type checks cover tooling configuration and maintained TypeScript source and tests. Tests run directly through Node.js 26's TypeScript support, without a transpiler or test-framework dependency. There is no packaged CLI or build yet.

Run `pnpm test` for the behavioral suite or `pnpm verify` for all checks. Coverage is reported; no completeness claim or coverage threshold is implied.

## Hooks and conventional messages

Lefthook runs the same `pnpm check` command before a commit. The hook checks the whole working tree without rewriting or automatically staging files. Unstaged changes can therefore block a commit; resolve the issue rather than bypassing the hook.

The `commit-msg` hook uses Commitlint's conventional configuration. For example:

```text
chore: configure repository tooling
feat: generate a changelog between tags
fix: reject ambiguous PR associations
```

PR titles must follow the same convention. CI checks both the PR title and every commit in the PR range. These are repository contribution conventions; release classification remains a separate product decision.

Prefer squash merging with a conventional final message, or rebase merging when each commit is valid. Automatic non-conventional merge commits are not exempt from validation. Do not rewrite existing published history just to apply the new convention retroactively.

## PR release context

Use the PR template's `release-log` block to provide the [version 1 release context](docs/release-context.md). Fill in a summary, impact, and any required action; select `users` or `internal` explicitly. The template's empty text values deliberately fail validation until completed.

The parser reports missing or invalid context without returning partial data. This component does not yet add a live PR-body CI gate or define how release generation will handle historical PRs without context.

## Continuous integration

The `verify` job runs on PRs, pushes to `main`, and manual dispatch. PR title edits retrigger validation. Feature-branch pushes rely on the PR event rather than starting duplicate push workflows.

CI installs frozen dependencies, runs the same `pnpm verify` command as local development, and validates the applicable commit range and PR title. GitHub event text is passed through environment variables, not interpolated into shell source. Actions are pinned to immutable SHAs and the workflow has read-only repository permissions.

Requiring `verify` through branch protection and selecting allowed merge methods are separate repository-settings operations. This tooling does not configure either setting, deploy artifacts, or publish a package.

## Changes and reviews

Keep each PR focused. Explain the problem, intended behavior, relevant tradeoffs, and verification actually performed. Add tests for implemented behavior and document unverified risks. Passing checks do not replace review.

Read [AGENTS.md](AGENTS.md) when working with an agent. Keep the current task's scope explicit; a request to implement does not automatically authorize publication, merging, or deployment.
