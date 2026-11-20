# Contributing

## Local setup

Use Node.js **26.13.1** and pnpm **12.14.0**, pinned by `.node-version` and `package.json`. With fnm already installed, `fnm install` and `fnm use` select the project runtime. Install the pinned pnpm version separately if needed; Node.js 26 does not bundle Corepack.

From the repository root:

```sh
pnpm install --frozen-lockfile

pnpm verify
```

Installation runs `prepare` to install Lefthook's Git hooks in this checkout. If hooks need reinstalling, run `pnpm exec lefthook install`. Review dependency and lifecycle changes before installing untrusted code.

Lefthook's dependency-level postinstall is explicitly disabled in `pnpm-workspace.yaml`; its platform binary is supplied by an optional dependency, and the root `prepare` command installs the hooks. Unreviewed dependency build scripts remain blocked by pnpm.

CI uses `--ignore-scripts` because it runs checks directly and does not need local Git hooks.

## Commands

| Command                                                     | Purpose                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm build`                                                | Compile the CLI/library and copy trusted replay runtime assets.                          |
| `pnpm pack`                                                 | Build and pack a local distributable tarball without publishing.                         |
| `pnpm format`                                               | Format supported maintained files with Oxfmt.                                            |
| `pnpm format:files <paths...>`                              | Format selected maintained files, used by the pre-commit hook.                           |
| `pnpm check:format`                                         | Check formatting without changing files.                                                 |
| `pnpm check:lint`                                           | Run type-aware Oxlint; warnings and unused suppression directives fail.                  |
| `pnpm check:architecture`                                   | Check capability boundaries, graph coverage, and contract fixtures.                      |
| `pnpm check:types`                                          | Run strict TypeScript checks without emitting files.                                     |
| `pnpm check`                                                | Run formatting, lint, types, architecture contracts, tests, and the documentation build. |
| `pnpm test`                                                 | Run fast behavioral tests. Pass test files or globs to select a subset.                  |
| `pnpm test:integration`                                     | Run tests that exercise Git, packages, and other subprocesses.                           |
| `pnpm test:all`                                             | Run both behavioral suites without collecting coverage.                                  |
| `pnpm test:coverage`                                        | Run the full behavioral suite with coverage reporting.                                   |
| `pnpm verify`                                               | Run the same checks as `pnpm check`.                                                     |
| `pnpm docs:dev`                                             | Start the documentation development server.                                              |
| `pnpm docs:build`                                           | Build documentation and check internal page links.                                       |
| `pnpm docs:preview`                                         | Preview the built documentation site locally.                                            |
| `pnpm check:commits`                                        | Validate a single unscoped commit message from stdin.                                    |
| `pnpm check:commit-range --from <base-sha> --to <head-sha>` | Validate non-merge commits in a Git range with Commitlint.                               |
| `pnpm check:pr-title`                                       | Validate a scoped PR title from stdin.                                                   |

`pnpm container:build --tag release-log-local:development` builds a local Linux/amd64 image from the packaged CLI. `pnpm check:container` runs real Docker smoke tests separately from `pnpm verify`; the Quality workflow also runs this integration gate. These commands need Docker and initial public base/snapshot downloads, not publishing credentials. See the [container guide](docs/container.md) for supported mounts/UIDs, cache requirements and dated scan limits. The separate [stable-tag publisher](docs/container-release.md) has verified GHCR publication, anonymous access and matching-digest retry; private-registry access remains unverified.

`pnpm check:pr-metadata` validates current PR title/context and commit evidence through read-only API calls in the trusted metadata workflow; it requires the GitHub event environment described in [PR metadata readiness](docs/pr-readiness.md).

Dependencies are exact-pinned and the pnpm lockfile is committed. Generated lockfile formatting is left to pnpm, not Oxfmt. The generated root `CHANGELOG.md` and tracked `.release-log/inputs.json` snapshot are also excluded from Oxfmt: their canonical bytes belong to the changelog renderer, release serializer and proposal verification. The changelog renderer preserves released sections byte for byte, including whitespace; a general formatter must not rewrite that history. Keep these files tracked and do not hand-format generated release evidence.

Type checks cover tooling configuration and maintained TypeScript source and tests. Tests run directly through Node.js 26's TypeScript support, without a transpiler or test-framework dependency. `pnpm build` compiles the distributable CLI/library; `pnpm pack` builds a local tarball. The package test installs it with only cached production dependencies in a temporary directory and exercises the executable without network access; project installation must populate the package-manager cache first. See the [CLI guide](docs/cli.md) for commands and Node/Python version-file support. The separate documentation build uses VitePress; its configuration is included in type checks.

Run `pnpm test` for fast feedback or pass a file to select it explicitly, as in `pnpm test tests/release-plan.test.ts`. Add a Node test filter before the file to select a test by name. Put tests that start Git, a CLI, or another subprocess in `tests/*.integration.test.ts` so `pnpm test:integration` picks them up. Run `pnpm verify` for all checks, including both suites with coverage and the production documentation build. Coverage reporting has no threshold.

The public [documentation site](https://lhajoosten.github.io/release-log/) deploys from main through the Documentation workflow. The [site guide](docs/github-pages.md) explains local previewing, navigation, observed deployment and settings required when adopting this setup. Review documentation for public access before merging; a source repository's permissions do not establish site visibility.

## Architecture contracts

`pnpm check:architecture` installs the independently locked development tool in `tools/architecture` with frozen dependencies and scripts disabled, then runs dependency-cruiser from the repository root. The first run needs access to the package registry or a populated pnpm cache. Its isolated TypeScript 6 compiler supports the analyzer while the application remains on TypeScript 7.0.2; the separate lockfile keeps tool dependencies out of release evidence. When adopting stable TypeScript 7.1 or newer, verify equivalent graph coverage before consolidating the compilers.

Named rules include transitive and type-only capability dependencies, prohibit production imports of test support and unresolved local imports, and reject runtime cycles on a separate graph that omits type-only edges. Fixtures exercise the contracts and the graph check verifies representative NodeNext imports, including a provider resolved through pnpm. Static analysis cannot follow runtime-loaded producer paths; the installed-producer compatibility test remains necessary.

New planning logic belongs in `src/planning/`, shared configuration in `src/config/`, snapshot capture, replay, evidence decoding, and identity in `src/snapshot/`, changelog rendering in `src/changelog/`, proposal preparation, identity, verification, history inspection, and guarded reconciliation writes in `src/proposal/`, and shared evidence decoding in `src/evidence/`. Existing root modules retain their public and producer-facing entry points; keep those paths and named exports compatible, and import owning implementations directly within the application. The proposal path policy and GitHub repository adapter remain shared root modules across lifecycle controllers. Production code imports owning implementations directly; the proposal root facades exist for package and pinned-producer compatibility. Other capability folders can be introduced as their work is refactored; update the architecture selectors and fixtures alongside moves.

Publication code belongs in `src/publication/`. The action planner derives ordered actions from approved intent and observed state. Its dependency contract permits publication types and Node’s crypto module for content digests. Keep filesystem reads, registry and GitHub requests, and pre-write freshness checks in the surrounding inspection and execution code.

## Hooks and conventional messages

Lefthook first formats staged maintained files through `pnpm format:files` and automatically restages those fixes, then runs the same `pnpm check` command through `scripts/check-hook.ts`. The commands run sequentially and a formatter failure stops the commit. Lefthook hides and restores unstaged portions of partially staged files, so formatting selected content does not stage the remaining edits. Generated changelog/snapshot bytes and lockfile formatting remain owned by their generators.

The runner clears Git's repository-local environment variables before starting checks, so Git fixture commands cannot inherit a linked worktree's absolute repository/index paths. It preserves the check exit status; no checks are skipped.

Only originally staged maintained files are formatted and restaged; unrelated files are not added. The subsequent checks still cover maintained files across the working tree, so unrelated unstaged formatting errors can block a commit. The documentation build writes ignored output and cache files. Resolve failed checks rather than bypassing the hook. CI runs `pnpm verify` without formatting or pushing changes, checking the committed result.

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

Both policies accept the conventional types `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`. CI checks the scoped PR title and every unscoped non-merge commit in the PR range. Release classification follows the [accepted release policy](docs/release-policy.md).

`pnpm check:commit-range` uses Git's `--no-merges` filter so GitHub-generated merge commits do not fail after an otherwise valid PR is merged. It invokes the same Commitlint configuration as the commit hook for each selected message; the pinned Commitlint version does not reliably forward `--git-log-args` filters. This excludes commits with multiple parents, not messages matching a pattern. Commits from merged branches are still checked; the traversal is not restricted to the first parent. Direct message validation (including PR titles and the `commit-msg` hook) remains strict.

Merge commits, squash merges, and rebase merges are supported by this CI policy. Squash messages and ordinary commits must remain unscoped and conventional. When squash merging, edit the generated commit subject to remove the PR title's scope (for example, `feat(exports): add CSV output` becomes `feat: add CSV output`). The release metadata validator still rejects non-conventional merge messages; this CI exception does not define a release classification or PR-association policy. Do not rewrite existing published history just to apply the convention retroactively.

## PR release context

This repository explicitly selects the required context policy in release configuration and the trusted metadata workflow. Consumers may select the [optional policy](docs/release-context.md#consumer-context-policy); it does not exempt PRs here.

Use the PR template's `release-log` block to provide the [version 1 release context](docs/release-context.md). Fill in a summary, impact, and any required action; select `users` or `internal` explicitly. The template's empty text values deliberately fail validation until completed.

The parser reports missing or invalid context without returning partial data. The separate [PR metadata gate](docs/pr-readiness.md) validates current title/body and commit evidence through read-only API calls, including title/body edits and internal PRs. Breaking commits require `!` in the PR title, and breaking PRs require nonempty `required_action`. There is no blanket bot or release-PR exemption.

## Continuous integration

The `verify` job runs on PRs, pushes to `main`, and manual dispatch. PR title edits retrigger validation. Feature-branch pushes rely on the PR event rather than starting duplicate push workflows.

CI installs frozen dependencies, runs the same `pnpm verify` command as local development, and validates non-merge commits in the applicable range and the PR title. GitHub event text is passed through environment variables, not interpolated into shell source. Actions are pinned to immutable SHAs and the workflow has read-only repository permissions.

The separate `PR metadata` workflow runs trusted base-SHA validator code under a metadata-only, explicitly read-only `pull_request_target` event. It never executes PR source; keep source testing in the unprivileged Quality workflow. Its observed ordinary/generated-PR checks and remaining controlled-run limitations are documented in [PR metadata readiness](docs/pr-readiness.md).

Requiring `verify` or `metadata` through branch protection and selecting allowed merge methods are separate repository-settings operations. The Quality workflow does not configure either setting or publish a package. A separate Documentation workflow builds and deploys the static site from `main` after Pages is configured; it does not deploy PRs. See the [documentation site guide](docs/github-pages.md) for permissions, environment protection, and visibility prerequisites.

## Changes and reviews

Keep each PR focused. Explain the problem, intended behavior, relevant tradeoffs, and verification actually performed. Add tests for implemented behavior and document unverified risks. Passing checks do not replace review.

Read [AGENTS.md](AGENTS.md) when working with an agent. Keep the current task's scope explicit; a request to implement does not automatically authorize publication, merging, or deployment.
