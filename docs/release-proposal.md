# Rolling release proposal controller

`reconcileReleaseProposal()` (package subpath `release-log/proposals`, source `src/release-proposal.ts`) and the explicit `propose` CLI command implement pending release cycles for [#20](https://github.com/lhajoosten/release-log/issues/20). They create or refresh one reserved branch and PR using validated snapshots and the existing version/changelog/Node/Python preparation logic. This repository enables automatic proposal/tag writes through its source-pinned caller. Self-use and private sandbox evidence are recorded in the [workflow guide](release-workflow.md#live-evidence-and-remaining-validation); downstream artifact publication remains separate.

The owner-approved [rolling-release workflow](release-workflow.md) narrows the intended orchestration to ordinary merge → rolling PR, manual release-PR merge → automatic version tag. The tag-only command is documented in the [CLI guide](cli.md#tag-a-manually-merged-release-pr). The controller accepts a verified, tagged merged predecessor for subsequent cycles. The reusable workflow calls `roll` for event routing and the pre-collection guard; this repository enables its caller, while new consumers still need their own reviewed configuration and App setup.

## Inputs and explicit writes

Use the existing [snapshot configuration](release-snapshot.md), captured snapshot and [version configuration](release-plan.md). Automation configuration has exactly these fields:

```json
{ "schemaVersion": 1, "botUserId": 42 }
```

`42` is an illustrative ID, not a configured repository identity. An owner must supply the actual expected numeric bot account and a separately approved, repository-limited App installation token through `GITHUB_TOKEN`. Read-only reconciliation needs contents/PR reads; writes need contents/PR writes, not packages or OIDC. Contents write is not branch-limited by the GitHub permission model. This implementation does not install an App, add secrets, change branch protection or prove App/fork/check-trigger behavior.

```sh
release-log propose --config release-config.json --snapshot inputs.json --automation release-automation.json --current-version 1.2.3 --dry-run
```

For bootstrap use `--initial-version 0.1.0` instead of `--current-version`. The default is dry-run: it performs explicit GitHub reads, but creates no Git objects, branches or PRs and writes no local files. Only separately approved `--write` performs remote mutations. Do not use it as an untrusted-PR or privileged `pull_request_target` source-execution path. Run trusted pinned code/configuration against snapshots produced by trusted collection; an arbitrary uploaded snapshot is not authorization.

The library takes `{ snapshot, configuration, version, automation, token, write? }`. It returns only outcome, source/baseline/snapshot/proposal identities, branch, PR number and head SHA. Outcomes are `no-release`, `unchanged`, `would-create`, `would-refresh`, `created`, or `refreshed`. CLI output includes the explicit dry-run/write mode. Returned data excludes tokens and raw PR bodies; the proposal branch itself deliberately contains the captured snapshot and needs approved access/storage.

## Branch, files and metadata

The reserved branch is `release-log/<releaseBranch>` (normally `release-log/main`) in the same repository. A new PR is non-draft with maintainer modification disabled, targeting the configured release branch. Refreshes do not change an existing PR's draft state. Titles are `chore(release): prepare vX.Y.Z`; commits are unscoped `chore: prepare vX.Y.Z`. Generated title/context/commit metadata passes the ordinary readiness validator; there is no bot exemption.

The exact source tree is the captured immutable source commit. Regenerate the full baseline-to-source batch, not just the latest event. The proposal updates supported version files, the pending changelog and the canonical snapshot. It preserves unrelated source paths and existing file modes.

A refresh commit has the captured source as its first parent and the previous proposal head as its second parent. Its tree is still the source tree plus the complete regenerated outputs, not a merge of old generated text. This preserves prior proposal history while allowing GitHub ref updates with `force: false`. Competing commits based on the same old proposal head cannot both fast-forward that ref. No force push, branch deletion or history rewrite is used.

Commit footers and the PR body carry the same versioned machine identity: repository, branch, bot ID, captured baseline/source, snapshot/configuration identities, version configuration, previous head and file digests. The footer is wrapped to satisfy contribution line limits. The PR also contains exactly one ordinary internal v1 release-context block with an explicit review action. A title or label alone is never ownership.

The PR body previews the pending changelog for the full captured batch. Each refresh regenerates the same sections and source links as the pending section in `CHANGELOG.md`. Released history stays in the file. If the preview would make the body exceed 60 KiB, the description points reviewers to `CHANGELOG.md` in **Files changed**. The proposal identity records the body format so existing proposals can still be verified with their original description.

## Verification and conflict policy

Before any branch mutation:

- Revalidate snapshot/configuration and numeric automation configuration. Check remote repository ID/name, captured source against current release-branch ref, and unchanged baseline tag object when tagged.
- Require complete bounded tree/history API responses. Read only fixed manifest/changelog/snapshot/unsupported-lock paths; reject symlinks/submodules there. Check base64, UTF-8, byte counts and Git blob object hashes before interpreting contents.
- Refuse competing, closed-unmerged, unexpectedly deleted or orphaned proposal state. For an active PR, require same-repository/base/head refs and the configured numeric bot author. A merged predecessor must have a verified landing and matching version tag; a retained branch must still point to its verified head.
- Replay its captured snapshot using the current compatible tool, reconstruct its source files and generated output, and compare exact commit identity/parents, PR title/body, owned contents/modes and unrelated tree entries. Ordinary human edits are conflicts, not permission to overwrite them.
- A refreshed source must be a descendant of the previous proposal source. Rewinds/divergence fail rather than discard previously captured changes. Subsequent cycles use the verified merged release's version tag and retain its proposal head as a parent even when the old branch was deleted.

GitHub's Git commit API can omit the terminal LF retained in raw Git commit messages. The API adapter restores exactly one missing terminal LF before proposal identity parsing and comparison; already terminated messages stay unchanged. It does not trim whitespace, rewrite internal lines or accept extra terminal blank lines. Commit content, exact ordered parents, PR title/body and generated-file verification remain enforced. The shared HTTP fixture models this API representation so retries, refreshes, release tagging and approval replay exercise it.

Refresh saves reassert the configured base branch even when its name is unchanged. GitHub can otherwise retain the PR's older comparison base and show already-merged source changes. Reasserting the base refreshes that comparison without changing generated content or commit ancestry. The generated tree itself always differs from its captured source only at `.release-log/inputs.json`, `CHANGELOG.md`, the [supported version files](cli.md#node-python-and-cargo-version-files), and the caller workflow when self-upgrade is enabled.

An explicit [changelog format](changelog.md#format) selection permits a format-only transition for an existing proposal. Its captured configuration must match every other effective setting, including verbosity; the prior snapshot, generated files, body, ordered parents and identity are verified under the original format. New capture/reconstruction then uses the selected format. Direct snapshot replay stays exact, and this does not permit context-policy or onboarding changes.

Before/after writes, re-read source/baseline and expected head/PR metadata. Verify the newly created commit/tree/files before advancing a ref. Repeated identical snapshot/version input is a no-op without extra writes. An empty/nonreleasable initial batch creates nothing; a no-release refresh while a PR exists is a conflict, not an automatic close.

This is not a multi-resource transaction. A timeout can have an unknown result. An interrupted create can leave an orphan branch; an interrupted refresh can leave branch and PR metadata out of sync. Normal retries reuse a fully consistent active PR, but partial/unknown states stop for explicit owner recovery rather than creating duplicates, silently adopting a branch or overwriting human work. Inspect current refs, PR identity and generated diff before deciding recovery; do not delete/reopen/force-update them blindly.

Serialize controller jobs by repository/release branch. Ref fast-forward checks reject competing branch updates, and repeated reads detect tested source/metadata races, but GitHub ref and PR-body writes are not one atomic CAS transaction. A source change between a final read and mutation can leave a stale partial proposal; post-write checks fail it, and tag reconciliation rejects a stale release landing. Do not claim every distributed race or concurrent human metadata edit is solved by these guards.

## Bounds and remaining gates

Per reconciliation: five minutes overall, 200 HTTP requests, ten PR-history pages, 50000 recursive tree entries, 4 MiB per response and ten seconds per individual request. Controller input/output files are at most 2 MiB each so base64 JSON remains within the HTTP response budget. These controller limits are intentionally narrower than the general 16 MiB snapshot/file APIs; large batches fail rather than truncate. Request JSON is at most 16 MiB. No automatic write retry or redirect following occurs.

Digests, consistent trees and numeric PR authorship are not signatures or proof of human review. The platform's normal human review/manual merge is the release decision; custom approval records and the publication executor are not prerequisites. `tag-release` verifies the generated proposal against its actual merge/squash landing and can create only its immutable version tag. Existing approval/publication APIs remain separate.

The collector already supports verified automation exclusions through independently pinned authorities and schema-4 snapshots; see [that component's contract](automation-exclusions.md). The `roll` command applies `release-tag-pending` before collection and routes release merges only to tagging, so normal next cycles use tag boundaries without separate approval authorities. The read-only rehearsal remains read-only. Live App-backed proposal creation, refresh, subsequent tagged-cycle selection and exact-landing tagging have separate [observed evidence](release-workflow.md#live-evidence-and-remaining-validation); downstream publication and controlled fault coverage remain separate gates.

Tests use real temporary Git object graphs, branch refs and file trees, replacing only GitHub HTTP. They exercise Node, Python, mixed-manifest and Cargo creation, complete refresh in the same PR, no-op retries, no-release, moved/rewound sources and baselines, human metadata/content/unrelated changes, wrong identity, deleted/closed/orphan state, non-fast-forward competition, partial failures, pagination, malformed/truncated/oversized blobs and symlinks. Packed CLI tests check the exported compiled API and explicit proposal credential/network failures without making live requests. These are fixture results; the separately linked live evidence covers the exercised GitHub paths, and does not establish every failure/recovery mode or artifact publication.
