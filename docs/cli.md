# Deterministic release CLI

Build with `pnpm build`; run `node dist/src/cli.js --help`. `pnpm pack` builds a local tarball through `prepack`. No registry publication or visibility change is performed. The executable requires Node.js `>=26.13.0 <27`; online collection and approval verification require Git with complete local history and GitHub.com repository/PR read access.

## Configuration and commands

The configuration file is JSON containing exactly the [snapshot configuration](release-snapshot.md) fields:

```json
{
  "schemaVersion": 1,
  "repository": "example/project",
  "repositoryId": 17,
  "releaseBranch": "main",
  "releasePolicy": "release-policy-v1"
}
```

Explicit online collection:

```sh
release-log collect --config release-config.json --repository . --source FULL_COMMIT_SHA --baseline-tag v1.2.3
```

Supply `GITHUB_TOKEN` through the environment, never arguments or configuration. Collection writes the validated snapshot JSON to stdout and makes bounded read-only GitHub requests. For bootstrap, replace `--baseline-tag` with `--bootstrap-sha FULL_COMMIT_SHA`. It does not fetch Git history, infer a baseline, write local files, or mutate GitHub. See [association limitations](github-association.md), especially unverified automation-only exclusion.

With an explicit bootstrap baseline, collection retains eligible unassociated single-parent commits as real commit-only entries; tagged cycles remain PR-only. Known PRs still require valid metadata. Snapshot and plan output now use schema version 2; recapture version 1 snapshots with the new tool rather than relabeling or silently migrating them. See [bootstrap association rules](github-association.md#explicit-bootstrap-commit-evidence).

Offline operations:

```sh
release-log plan --config release-config.json --snapshot inputs.json --current-version 1.2.3
release-log render --config release-config.json --snapshot inputs.json --current-version 1.2.3
release-log prepare --config release-config.json --snapshot inputs.json --current-version 1.2.3 --repository . --dry-run
```

`plan` emits version-decision JSON. `render` emits the deterministic Markdown section, or empty stdout for no release. `prepare` emits `{ mode, plan, files }` JSON with each fixed output path and exact before/after text. It defaults to dry-run, without creating files/directories. Only explicit `--write` replaces local proposal files. `--write` and `--dry-run` are mutually exclusive. Bootstrap planning replaces `--current-version` with `--initial-version 0.1.0` and must match a captured bootstrap baseline.

The commands above do not commit, push or open PRs. The separate explicit [proposal controller](release-proposal.md) command performs online reads by default and only `propose --write` creates/refreshes a reserved remote branch and draft PR. It requires separate automation configuration, credentials and execution approval; no workflow enables it automatically. No command merges, publishes, calls AI, installs consumer dependencies, executes consumer lifecycle scripts, or runs a Python build backend. `prepare` output contains raw snapshot context: use approved storage and do not publish stdout indiscriminately. Exit codes are 0 for success (including no release), 1 for operation/validation failures, and 2 for usage errors. Errors omit raw bodies, tokens, and unexpected exception details.

The explicit read-only [approval verifier](release-approval.md) checks an independently trusted reviewed-head/landing record using GitHub reads and immutable local Git objects:

```sh
release-log verify-approval --config release-config.json --approval approved-release.json --policy approval-policy.json --repository .
```

It requires `GITHUB_TOKEN` with repository/PR read access, accepts no write flag, and emits verification evidence rather than publication permission. Approval/policy storage and the recorded merge method must be independently trusted; do not source them from the proposal branch.

## Node and Python version files

`prepareReleaseFiles()` and `writeReleaseFiles()` are the corresponding library APIs. Present root manifests are detected as one release stream:

- `package.json`: update exactly its root string `version` token. Preserve whitespace, property order, nested dependency versions, scripts, and unrelated values. Duplicate version properties are invalid.
- `pyproject.toml`: parse TOML and update the exact value ranges for static `[project].version` (PEP 621) and/or `[tool.poetry].version`. Quoted/dotted keys, inline tables, single/double/triple quotes, comments, unrelated tables, and line endings are preserved outside the version literal. If both supported Python fields exist, both must agree and are updated.
- A Node-only project needs no Python manifest; a Python-only project needs no Node manifest. When both exist, every supported version field must agree before any writes, including during bootstrap. Missing, invalid, mismatched, or dynamic versions fail explicitly.

A released version must match the captured tag and all selected manifests. Bootstrap permits a matching existing `0.0.0` placeholder or `0.1.0`, but uses the explicitly configured initial `0.1.0` only for a releasable batch. A no-release plan retains all files without advancing the baseline. Dynamic Python version schemes (`project.dynamic` including `version`, SCM-derived versions without static supported fields, backend execution) are unsupported.

Owned outputs are only the present version manifests, `CHANGELOG.md`, and `.release-log/inputs.json`. The snapshot is canonical, not regenerated from live metadata. Version updates do not install dependencies or regenerate lockfiles. The repository's pnpm lockfile has no root version mirror. Lockfiles with root version mirrors (such as npm/uv locks) need a dedicated adapter before preparation; they are rejected rather than silently left inconsistent. No monorepo adapter is implied.

Output paths and parents must be ordinary files/directories, not symlinks. Before replacing anything, all captured before-values are checked again; each file is rechecked immediately before its same-directory temporary-file rename. This detects ordinary intervening edits but is not an atomic multi-file transaction or protection against a hostile process swapping directories concurrently. Use a trusted, isolated worktree, serialize writers, and recover explicitly after a crash or partial write. No Git mutation/rollback is attempted. Controller-side Git tree/CAS checks are separate.

## Distribution and verification

The [local OCI image](container.md) wraps this packaged artifact with pinned Node/Git for Linux/amd64, with separate real-Docker smoke CI. It is not yet published or validated for private registry access.

The tarball allowlist contains compiled JavaScript/declarations, license/readme, and trusted runtime manifest, Commitlint configuration, and dependency lock bytes. The latter are copied to `dist/dependency-lock.txt` because package managers omit lockfile-named files from tarballs. Source and compiled replay use the same bytes and normalization identity. Production runtime dependencies are declared; development dependencies, tests, private configuration, and source tooling are not installed as runtime requirements. Keep the tarball and dependency resolution pinned for repeatable deployment; a copied lockfile is not itself enforcement of a consumer package manager's install.

The package remains private and version `0.0.0`; neither is changed by building/packing. The CLI package test builds and packs, unpacks the real tarball with the runner's `tar`, restores its preserved lock bytes as `pnpm-lock.yaml`, and installs only production dependencies with `--offline --frozen-lockfile --ignore-scripts` in a temporary directory. It rejects unexpected `fetch` and exercises help/version/errors, planning/rendering, and Node/Python/mixed dry-run and write behavior. The offline installation test requires the package content already cached by project installation, but does not require cached registry metadata or re-resolve transitive versions. Package smoke CI runs on Linux; an installed CLI does not require `tar`. No live collection compatibility, App provisioning, or release-controller rollout is claimed.
