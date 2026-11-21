# Deterministic release CLI

Use the [published Linux/amd64 image](container-release.md#pull-and-run), or build from source with `pnpm build` and run `node dist/src/cli.js --help`. In the examples below, `release-log` denotes the installed executable; source users can substitute `node dist/src/cli.js`, and image users can append the arguments to the [Docker invocation](container.md#run-with-mounted-inputs). `pnpm pack` builds a local tarball through `prepack`. No registry publication or visibility change is performed. The executable requires Node.js `>=26.13.0 <27`; online collection and approval verification require Git with complete local history and GitHub.com repository/PR read access.

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
release-log collect --config release-config.json --repository . --source FULL_COMMIT_SHA --baseline-tag v1.2.3 > inputs.json
```

Supply `GITHUB_TOKEN` through the environment, never arguments or configuration. Collection writes the validated snapshot JSON to stdout and makes bounded read-only GitHub requests. For initial adoption, use a [version 2 configuration with a fixed onboarding record](initial-adoption.md), and replace `--baseline-tag` with `--bootstrap-sha FULL_COMMIT_SHA` matching that record. It does not fetch Git history, infer a baseline, write local files, or mutate GitHub. See [association limitations](github-association.md), especially unverified automation-only exclusion.

Initial adoption retains pre-onboarding PRs/commits that lack modern metadata as historical entries and review warnings, without editing old PRs. New changes after the pinned cutoff and all tagged cycles stay strict. The initial `0.1.0` proposal does not depend on old feature/fix labels. New online snapshot and plan output use schema version 5, including capture time and available PR author logins (also with explicit [automation exclusion pins](automation-exclusions.md)). Legacy schemas 3 and 4 retain their replay contract; recapture old snapshots with the new tool rather than relabeling or silently migrating them. Configuration version 1 remains supported for established releases; version 2 adds the required trusted onboarding record for initial collection.

Offline operations:

```sh
release-log plan --config release-config.json --snapshot inputs.json --current-version 1.2.3
release-log render --config release-config.json --snapshot inputs.json --current-version 1.2.3
release-log prepare --config release-config.json --snapshot inputs.json --current-version 1.2.3 --repository . --dry-run
```

`plan` emits version-decision JSON. `render` emits the deterministic Markdown section, or empty stdout for no release. `prepare` emits `{ mode, plan, files }` JSON with each generated output path and exact before/after text. It defaults to dry-run, without creating files/directories. Only explicit `--write` replaces local proposal files. `--write` and `--dry-run` are mutually exclusive. Bootstrap planning replaces `--current-version` with `--initial-version 0.1.0` and must match a captured bootstrap baseline.

## Draft user-facing release notes

```sh
release-log notes --config release-config.json --snapshot inputs.json --current-version 1.2.3 > release-notes.md
sha256sum release-notes.md
```

`notes` replays the captured snapshot against the trusted configuration and uses the same version arguments as `render`, including `--initial-version 0.1.0` for bootstrap. It writes one Markdown draft to stdout, with LF line endings and a final newline. A no-release plan yields empty stdout. A replay or planning failure exits nonzero with a diagnostic on stderr and no Markdown. Check the command succeeded and produced a draft before recording its digest.

The draft uses captured summaries and impact for entries marked `users`, even when the technical changelog uses reduced verbosity. Entries marked `internal` contribute breaking warnings and required actions when present. Unknown audience and missing or unusable context appear under **Needs review** with source links. Historical metadata warnings also appear there. Missing breaking explanations or migration actions are called out explicitly. Review the accuracy of captured claims against their sources. The renderer uses only captured evidence and makes no network or AI requests. See the [Markdown contract and example](rfc/0001-deterministic-release-notes.md).

Review the exact draft alongside the release proposal and record its version, full snapshot ID, contract revision, and SHA-256 digest in the maintainer review. Before relying on that review, regenerate from the currently selected snapshot using the trusted renderer and compare the binding and digest against the reviewed values. Check the saved draft's digest too. Recapture and review again when live evidence changes. A new capture, renderer contract change, or edit to the file that changes the binding or bytes requires fresh review, even if the version stays the same. Keep the original snapshot and matching renderer to replay a past draft.

This is a manual review step. The draft stays outside the generated proposal files and GitHub Release body. The [development AI preview](text-generation.md) is a separate command.

The commands above do not commit, push or open PRs. The separate explicit [proposal controller](release-proposal.md) command performs online reads by default and `propose --write` creates/refreshes a reserved remote branch and PR (new PRs are non-draft). It requires separate automation configuration, credentials and execution approval. This repository’s live caller uses `roll --write` to route ordinary merges through proposal generation and release merges through exact-landing tagging; see the [caller and rollout limits](release-workflow.md#reusable-workflow-and-callers). Only the separate explicit `publish-github --write` executor can publish a GitHub Release; it has no enabled workflow and requires separate execution approval. No command merges, pushes images, calls AI, installs consumer dependencies, executes consumer lifecycle scripts, or runs a Python build backend. `prepare` output contains raw snapshot context: use approved storage and do not publish stdout indiscriminately. Exit codes are 0 for success (including no release), 1 for operation/validation failures, and 2 for usage errors. Errors omit raw bodies, tokens, and unexpected exception details.

### Backfill existing releases

```sh
release-log backfill --config release-config.json --repository . --dry-run > changelog-preview.md
release-log backfill --config release-config.json --repository . --write
```

This optional command enriches existing `CHANGELOG.md` releases without regenerating their prose. Default/dry-run emits the complete proposed Markdown to stdout and leaves the file untouched. Explicit `--write` replaces only `CHANGELOG.md`, after checking that its original bytes have not changed. It does not update manifests, snapshots or proposal identities. Run it separately from an active proposal refresh, review the diff and commit it through your ordinary workflow.

Supply `GITHUB_TOKEN` for bounded read-only PR-author requests (at most 1000 distinct PRs). Backfill uses **current** GitHub PR authors, including bots, and omits unavailable authors. It adds the fixed [section icons](changelog.md#captured-release-context), missing author links and full comparisons between adjacent released version tags. Existing profile attributions and `Full changelog:` text are preserved. Repeating with unchanged evidence yields identical output. No capture timestamp is invented for old history. Date fallback follows [Git’s tagger/committer distinction](https://git-scm.com/docs/git-for-each-ref#_field_names).

Supported release headings are `## vMAJOR.MINOR.PATCH`, optionally followed by ` - YYYY-MM-DD` or a recorded snapshot date `(YYYY-MM-DD)`, ordered newest first. Their actual local tags must exist in complete history and follow ancestry order; missing/divergent tags or unsupported/duplicate headings fail. The oldest section has no inferred baseline comparison. PR entries must have links to the configured repository; commit-only and unrelated links remain untouched. Code blocks and authored prose retain their bytes. Added text uses LF. A fixed `<br>` spacer separates a closing internal-maintenance disclosure from its full-comparison link. Existing dates are preserved. Otherwise backfill uses a recorded capture timestamp, then the annotated tag’s tagger date, or the tagged commit’s committer date for lightweight tags. Fallback dates are normalized to UTC. Capture-time and generated date-source paragraphs are removed from released Markdown; timestamps remain in snapshots and the fallback rules remain documented here. The current clock and file modification times are not used. Pending generated blocks are validated. An untagged proposal is skipped byte for byte. If the matching local version tag contains that exact owned block in its committed ordinary `CHANGELOG.md`, backfill retires the stale pending markers and enriches the released section too. A tag with different changelog content fails rather than treating a conflicting proposal as released. Malformed/edited pending markers, malformed API evidence and read failures stop without writing.

Backfill is an explicit exception to normal refresh's released-history preservation. It does not establish historical capture evidence or approve a release. Tags are verified locally, not fetched or independently authenticated against GitHub; use your trusted complete checkout. Symlink output paths and concurrent changelog edits are rejected.

### Select a rolling release boundary

`release-log select-cycle --config release-config.json --automation release-automation.json --source FULL_COMMIT_SHA` performs read-only GitHub checks using `GITHUB_TOKEN` and outputs the verified bootstrap or tagged baseline and version as JSON. A merged release without its exact tag fails with `release-tag-pending`; rerun `tag-release` for the reported PR and landing. Closed unmerged proposals and conflicting tags also stop selection. Bootstrap selection requires the current release-branch tip; tagged selection requires a source descended from the latest verified landing. This command does not fetch local Git tags, collect a snapshot, or create a proposal; callers must verify local tag evidence and invoke those steps separately. The existing `collect` and `propose` commands do not invoke this guard automatically.

### Route a merged PR

```sh
release-log roll --config release-config.json --automation release-automation.json --repository . --event event.json --dry-run
```

`roll` consumes the GitHub event JSON with `GITHUB_EVENT_NAME=pull_request_target` (or `pull_request`) and requires `RELEASE_LOG_APP_TOKEN`, with no default `GITHUB_TOKEN` fallback. Supply a short-lived repository-scoped installation token at runtime. It defaults to dry-run; only separately approved `--write` mutates GitHub. Output is `{ mode, route, result }`, with route `proposal`, `tag`, or `ignored` (without a result). It never prints snapshots or credentials.

The router re-reads the event PR and checks its repository, release branch and exact landing. Reserved-head or configured-bot candidates must pass the full generated proposal and merge/squash verification before tagging; verification failures stop, without falling through to collection. Titles and labels do not select the tag path. Non-merge events and other base branches are ignored.

Ordinary merges capture the current remote source, including changes newer than a delayed trigger, and invoke cycle selection before collection. Pending tags, closed proposals, conflicting tags and divergent history stop. The local selected tag object and peeled commit must match the verified remote boundary. Fetch complete history and tags beforehand; stale/missing local evidence fails rather than guessing a baseline. Collection covers the entire selected range, then the proposal controller rechecks source and tag freshness before writes. A source race fails and requires a fresh run; partial/uncertain writes still require explicit reconciliation.

The [reusable workflow and callers](release-workflow.md#reusable-workflow-and-callers) build a packaged CLI from an explicitly reviewed tool SHA, without executing consumer source or dependencies. Neither ordinary `collect` nor `propose` changes its standalone interface; use `roll` for the integrated pre-collection guard.

### Tag a manually merged release PR

The [rolling-release workflow](release-workflow.md) uses a separate tag-only path, not the publication executor:

```sh
release-log tag-release --config release-config.json --automation release-automation.json --pull-number 123 --landing-sha FULL_RELEASE_LANDING_SHA --dry-run
```

`release-automation.json` contains the same numeric bot identity as `propose`. Supply the App installation token through `GITHUB_TOKEN`. The command reconstructs the merged generated proposal, derives its planned version, and verifies its exact merge/squash landing and unchanged baseline. It makes no application-CI, custom approval-record, receipt, registry, or GitHub Release requests. Later main commits never retarget the tag.

Default dry-run emits `{ mode, outcome, tag, landingSha, pullNumber }`; `outcome` is `would-create` or `unchanged`. Only separately authorized `--write` can create the absent version tag (`created`). A matching lightweight or annotated tag is reused without writes; a conflicting tag fails and is never moved. No PR, Release, asset, or image is created by this command. A failed/uncertain tag write requires inspecting state and explicitly rerunning for the same landing, not automatic write retries. Rebase release landings are unsupported. The corresponding library function is `reconcileReleaseTag()` from `release-log/tags`.

The reusable workflow calls `roll` to connect these components. This repository has an enabled source-pinned caller and observed self-use and successive sandbox cycles, including matching-tag retry; new consumers still need their own reviewed caller and App setup. See [live evidence and remaining validation](release-workflow.md#live-evidence-and-remaining-validation).

### Existing approval and publication APIs

These separate components are not prerequisites for the rolling-release workflow.

The explicit read-only [approval verifier](release-approval.md) checks an independently trusted reviewed-head/landing record using GitHub reads and immutable local Git objects:

```sh
release-log verify-approval --config release-config.json --approval approved-release.json --policy approval-policy.json --repository .
```

It requires `GITHUB_TOKEN` with repository/PR read access, accepts no write flag, and emits verification evidence rather than publication permission. Opt-in [approval policy 2](release-approval.md#strict-review-check-policy-2) also requires the intended human's native exact-head review and explicitly trusted workflow/current-attempt/job/App results, with Actions/checks read permissions. Policy 1 remains compatible; switching policy requires recapture, not relabeling old approvals. Approval/policy storage and the recorded merge method must be independently trusted; do not source them from the proposal branch.

The same [approval guide](release-approval.md#capture-before-merge-finalize-after-the-trusted-merge-action) describes `capture-review` and `finalize-approval`: capture an explicitly intended open head before merge, then bind the independently stored review to a trusted merge/squash outcome. Both are read-only and emit JSON, not a merge or publication. They do not authenticate the caller or provision protected review/attestation storage.

`audit-exclusion` reports a verified approved automation footprint and retained ordinary commits for an explicit Git range. See the [audit contract](release-approval.md#audit-an-automation-only-exclusion-footprint). It is read-only and does not by itself change membership or enable release publication. Applying exclusions requires `collect --exclusions FILE` with independently trusted original approval authorities and matching `automationExclusions` pins in current configuration. Collection freshly verifies those records; schema-5 capture/replay (and legacy schema-4 replay) retains the full raw graph while excluding verified automation only from product entries. See [authority setup and replay](automation-exclusions.md).

Read-only [publication reconciliation](release-publication.md) compares an approved landing and independently trusted build receipt against tag, Release, asset and GHCR state:

```sh
release-log inspect-publication --config release-config.json --approval approved-release.json --policy approval-policy.json --publication-policy publication-policy.json --receipt build-receipt.json --repository .
```

It requires `GITHUB_TOKEN` and, for configured images, a separate pull-scoped `GHCR_READ_TOKEN` registry bearer. It emits missing-action JSON without executing actions and accepts no write/dry-run flags. Exit 0 means inspection succeeded; `complete: true` additionally requires matching published outputs. Neither is a durable publication authorization or baseline-advancement record. See the guide for receipt trust, credential/token-exchange limits and recovery.

The separate [GitHub executor](release-publication.md#explicit-github-executor) uses the same inspector inputs plus `--asset-directory DIR`. `publish-github` defaults to dry-run, validates exact receipt-matching local bytes, and only `--write` creates the tag/draft Release, uploads missing assets and publishes the verified draft. Missing configured images block writes; it never pushes them. See the guide for size limits, trusted-host/serialization requirements, uncertain-outcome recovery and unverified live behavior. No workflow enables this command automatically.

## Changelog presentation

Changelog verbosity is selected in trusted configuration as `changelog: { "verbosity": "detailed" }`, with `concise` and `one-liner` also supported. Omission keeps detailed output. The setting applies consistently to `render`, `prepare`, proposals and approval verification; changing it requires fresh capture/review. All modes retain breaking warnings and required actions. See the [three output modes](changelog.md#verbosity). The optional `changelog.format` selects `classic` (default) or `compact`; this repository uses concise/compact. The [format contract](changelog.md#format) defines the narrowly permitted format-only proposal transition.

## Node, Python, and Cargo version files

`prepareReleaseFiles()` and `writeReleaseFiles()` are the corresponding library APIs. Present root manifests are detected as one release stream:

- `package.json`: update exactly its root string `version` token. Preserve whitespace, property order, nested dependency versions, scripts, and unrelated values. Duplicate version properties are invalid.
- `package-lock.json` or `npm-shrinkwrap.json`: update the existing root version mirror in format 1, 2, or 3. Formats 2 and 3 also mirror the version at `packages[""].version`. Both mirrors must agree with `package.json` when present. Dependency and workspace member entries stay byte-identical. Keep one authoritative npm lockfile in the repository root.
- `pyproject.toml`: parse TOML and update the exact value ranges for static `[project].version` (PEP 621) and/or `[tool.poetry].version`. Quoted/dotted keys, inline tables, single/double/triple quotes, comments, unrelated tables, and line endings are preserved outside the version literal. If both supported Python fields exist, both must agree and are updated.
- `uv.lock` and `pyproject.toml`: update a single project’s static `[project].version` and the matching virtual or editable root entry in an existing format 1 lockfile (revision 0–5 or absent). Only the root version literal changes in the lockfile. Workspaces and local path dependencies require a separate release strategy. If the lockfile is stale or the root entry is missing, regenerate and commit it before retrying. Python repositories without a lockfile continue to use the static manifest flow.
- `Cargo.toml`: update a standalone `package.version` or a shared `workspace.package.version`. Workspace members must inherit the shared version and be listed by explicit repository-relative directory (up to 25 members). Internal path dependency requirements using the current version, optionally prefixed with `=`, `^`, or `~`, advance with the release. An existing format 3 or 4 `Cargo.lock` keeps its external resolutions and advances its local package versions. A lockfile-free package stays lockfile-free. Globs, exclusions, independent crate versions, unmanaged path dependencies, and Cargo patch or replace overrides require a separate release strategy.
- All present release manifests must agree before any writes, including during bootstrap.

A released version must match the captured tag and all selected manifests. Bootstrap permits a matching existing `0.0.0` placeholder or `0.1.0`, but uses the explicitly configured initial `0.1.0` only for a releasable batch. A no-release plan retains all files without advancing the baseline. Dynamic Python version schemes (`project.dynamic` including `version`, SCM-derived versions without static supported fields, backend execution) are unsupported.

Owned outputs include the present version files, `CHANGELOG.md`, and `.release-log/inputs.json`. The snapshot is canonical, not regenerated from live metadata. Version updates edit metadata without running package managers or build scripts. The repository's pnpm lockfile has no root version mirror.

Output paths and parents must be ordinary files/directories, not symlinks. Before replacing anything, all captured before-values are checked again; each file is rechecked immediately before its same-directory temporary-file rename. This detects ordinary intervening edits but is not an atomic multi-file transaction or protection against a hostile process swapping directories concurrently. Use a trusted, isolated worktree, serialize writers, and recover explicitly after a crash or partial write. No Git mutation/rollback is attempted. Controller-side Git tree/CAS checks are separate.

## Distribution and verification

The [local OCI image](container.md) wraps this packaged artifact with pinned Node/Git for Linux/amd64, with separate real-Docker smoke CI. The Linux/amd64 `v0.2.1` image is published with verified anonymous pull/run access; use the [digest-pinned installation commands](container-release.md#pull-and-run). Private registry access is not validated.

The tarball allowlist contains compiled JavaScript/declarations, license/readme, and trusted runtime manifest, Commitlint configuration, and dependency lock bytes. The latter are copied to `dist/dependency-lock.txt` because package managers omit lockfile-named files from tarballs. Source and compiled replay use the same bytes and normalization identity. Production runtime dependencies are declared; development dependencies, tests, private configuration, and source tooling are not installed as runtime requirements. Keep the tarball and dependency resolution pinned for repeatable deployment; a copied lockfile is not itself enforcement of a consumer package manager's install.

The root npm package remains private at `0.2.1`; building/packing changes neither version nor visibility. The live runner builds an older reviewed source pin, as recorded in the [workflow checkpoint](release-workflow.md#implementation-checkpoint). GHCR distribution and its live evidence are recorded in the [container publication guide](container-release.md#live-v0-2-1-publication). No npm package or GitHub Release assets are distributed. The CLI package test builds and packs, unpacks the real tarball with the runner's `tar`, restores its preserved lock bytes as `pnpm-lock.yaml`, and installs only production dependencies with `--offline --frozen-lockfile --ignore-scripts` in a temporary directory. It rejects unexpected `fetch` and exercises help/version/errors, planning/rendering, and Node/Python/mixed dry-run and write behavior. The offline installation test requires the package content already cached by project installation, but does not require cached registry metadata or re-resolve transitive versions. Package smoke CI runs on Linux; an installed CLI does not require `tar`. This package test does not prove live collection compatibility, App provisioning, or rollout in another repository. Self-use, subsequent sandbox-cycle and matching-tag retry evidence and their remaining limits are recorded in the [workflow guide](release-workflow.md#live-evidence-and-remaining-validation).
