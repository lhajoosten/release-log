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

| Command                                                     | Purpose                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm format`                                               | Format supported maintained files with Oxfmt.                           |
| `pnpm check:format`                                         | Check formatting without changing files.                                |
| `pnpm check:lint`                                           | Run type-aware Oxlint; warnings and unused suppression directives fail. |
| `pnpm check:types`                                          | Run strict TypeScript checks without emitting files.                    |
| `pnpm check`                                                | Run formatting, lint, types, tests, and the documentation build.        |
| `pnpm test`                                                 | Run Node.js tests with coverage reporting.                              |
| `pnpm verify`                                               | Run the same checks as `pnpm check`.                                    |
| `pnpm docs:dev`                                             | Start the documentation development server.                             |
| `pnpm docs:build`                                           | Build documentation and check internal page links.                      |
| `pnpm docs:preview`                                         | Preview the built documentation site locally.                           |
| `pnpm check:commits`                                        | Validate a single unscoped commit message from stdin.                   |
| `pnpm check:commit-range --from <base-sha> --to <head-sha>` | Validate non-merge commits in a Git range with Commitlint.              |
| `pnpm check:pr-title`                                       | Validate a scoped PR title from stdin.                                  |

Dependencies are exact-pinned and the pnpm lockfile is committed. Generated lockfile formatting is left to pnpm, not Oxfmt.

Type checks cover tooling configuration and maintained TypeScript source and tests. Tests run directly through Node.js 26's TypeScript support, without a transpiler or test-framework dependency. There is no packaged CLI or CLI build yet. The separate documentation build uses VitePress; its configuration is included in type checks.

Run `pnpm test` for the behavioral suite or `pnpm verify` for all checks, including the production documentation build. Coverage is reported; no completeness claim or coverage threshold is implied.

The [documentation site guide](docs/github-pages.md) explains local previewing, adding pages, and the manual GitHub Pages settings and visibility review required before deployment.

## Hooks and conventional messages

Lefthook runs the same `pnpm check` command before a commit. The hook checks maintained files across the working tree without rewriting or automatically staging them; the documentation build writes ignored output and cache files. Unstaged changes can therefore block a commit; resolve the issue rather than bypassing the hook.

The `commit-msg` hook requires an unscoped conventional message (`type: description`). For example:

```text
chore: configure repository tooling
feat: generate a changelog between tags
fix: reject ambiguous PR associations
```

PR titles require a scope (`type(scope): description`) identifying the affected feature or component, for example:

```text
feat(exports): support selected rows
fix(ci): validate merged commit ranges
refactor(release-context): simplify field validation
```

Both policies accept the conventional types `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`. CI checks the scoped PR title and every unscoped non-merge commit in the PR range. These are repository contribution conventions; release classification remains a separate product decision.

`pnpm check:commit-range` uses Git's `--no-merges` filter so GitHub-generated merge commits do not fail after an otherwise valid PR is merged. It invokes the same Commitlint configuration as the commit hook for each selected message; the pinned Commitlint version does not reliably forward `--git-log-args` filters. This excludes commits with multiple parents, not messages matching a pattern. Commits from merged branches are still checked; the traversal is not restricted to the first parent. Direct message validation (including PR titles and the `commit-msg` hook) remains strict.

Merge commits, squash merges, and rebase merges are supported by this CI policy. Squash messages and ordinary commits must remain unscoped and conventional. When squash merging, edit the generated commit subject to remove the PR title's scope (for example, `feat(exports): add CSV output` becomes `feat: add CSV output`). The release metadata validator still rejects non-conventional merge messages; this CI exception does not define a release classification or PR-association policy. Do not rewrite existing published history just to apply the convention retroactively.

## PR release context

Use the PR template's `release-log` block to provide the [version 1 release context](docs/release-context.md). Fill in a summary, impact, and any required action; select `users` or `internal` explicitly. The template's empty text values deliberately fail validation until completed.

The parser reports missing or invalid context without returning partial data. This component does not yet add a live PR-body CI gate or define how release generation will handle historical PRs without context.

## Continuous integration

The `verify` job runs on PRs, pushes to `main`, and manual dispatch. PR title edits retrigger validation. Feature-branch pushes rely on the PR event rather than starting duplicate push workflows.

CI installs frozen dependencies, runs the same `pnpm verify` command as local development, and validates non-merge commits in the applicable range and the PR title. GitHub event text is passed through environment variables, not interpolated into shell source. Actions are pinned to immutable SHAs and the workflow has read-only repository permissions.

Requiring `verify` through branch protection and selecting allowed merge methods are separate repository-settings operations. The Quality workflow does not configure either setting or publish a package. A separate Documentation workflow builds and deploys the static site from `main` after Pages is configured; it does not deploy PRs. See the [documentation site guide](docs/github-pages.md) for permissions, environment protection, and visibility prerequisites.

## Changes and reviews

Keep each PR focused. Explain the problem, intended behavior, relevant tradeoffs, and verification actually performed. Add tests for implemented behavior and document unverified risks. Passing checks do not replace review.

Read [AGENTS.md](AGENTS.md) when working with an agent. Keep the current task's scope explicit; a request to implement does not automatically authorize publication, merging, or deployment.
