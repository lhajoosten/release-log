# Rolling release proposal controller — initial pending cycle

`reconcileReleaseProposal()` (package subpath `release-log/proposals`, source `src/release-proposal.ts`) and the explicit `propose` CLI command implement the first pending release cycle for [#20](https://github.com/lhajoosten/release-log/issues/20). They create or refresh one reserved branch and draft PR using validated snapshots and the existing version/changelog/Node/Python preparation logic. No workflow automatically invokes writes; no live pilot, credentials provisioning, release, or publication has been performed.

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

The reserved branch is `release-log/<releaseBranch>` (normally `release-log/main`) in the same repository. A new PR is a draft with maintainer modification disabled, targeting the configured release branch. Titles are `chore(release): prepare vX.Y.Z`; commits are unscoped `chore: prepare vX.Y.Z`. Generated title/context/commit metadata passes the ordinary readiness validator; there is no bot exemption.

The exact source tree is the captured immutable source commit. Regenerate the full baseline-to-source batch, not just the latest event. Reuse the Node/Python adapters, pending changelog updater and canonical snapshot serializer. Only present root manifests, `CHANGELOG.md` and `.release-log/inputs.json` are owned outputs. Preserve every unrelated source path and the existing file modes.

A refresh commit has the captured source as its first parent and the previous proposal head as its second parent. Its tree is still the source tree plus the complete regenerated outputs, not a merge of old generated text. This preserves prior proposal history while allowing GitHub ref updates with `force: false`. Competing commits based on the same old proposal head cannot both fast-forward that ref. No force push, branch deletion or history rewrite is used.

Commit footers and the PR body carry the same versioned machine identity: repository, branch, bot ID, captured baseline/source, snapshot/configuration identities, version configuration, previous head and file digests. The footer is wrapped to satisfy contribution line limits. The PR also contains exactly one ordinary internal v1 release-context block with an explicit review action. A title or label alone is never ownership.

## Verification and conflict policy

Before any branch mutation:

- Revalidate snapshot/configuration and numeric automation configuration. Check remote repository ID/name, captured source against current release-branch ref, and unchanged baseline tag object when tagged.
- Require complete bounded tree/history API responses. Read only fixed manifest/changelog/snapshot/unsupported-lock paths; reject symlinks/submodules there. Check base64, UTF-8, byte counts and Git blob object hashes before interpreting contents.
- Refuse competing, closed, merged, deleted or orphaned proposal state. For an active PR, require same-repository/base/head refs and the configured numeric bot author.
- Replay its captured snapshot using the current compatible tool, reconstruct its source files and generated output, and compare exact commit identity/parents, PR title/body, owned contents/modes and unrelated tree entries. Ordinary human edits are conflicts, not permission to overwrite them.
- A refreshed source must be a descendant of the previous proposal source. Rewinds/divergence fail rather than discard previously captured changes. New baseline cycles require a separate verified completion/recovery path.

Before/after writes, re-read source/baseline and expected head/PR metadata. Verify the newly created commit/tree/files before advancing a ref. Repeated identical snapshot/version input is a no-op without extra writes. An empty/nonreleasable initial batch creates nothing; a no-release refresh while a PR exists is a conflict, not an automatic close.

This is not a multi-resource transaction. A timeout can have an unknown result. An interrupted create can leave an orphan branch; an interrupted refresh can leave branch and PR metadata out of sync. Normal retries reuse a fully consistent active PR, but partial/unknown states stop for explicit owner recovery rather than creating duplicates, silently adopting a branch or overwriting human work. Inspect current refs, PR identity and generated diff before deciding recovery; do not delete/reopen/force-update them blindly.

Serialize controller jobs by repository/release branch. Ref fast-forward checks reject competing branch updates, and repeated reads detect tested source/metadata races, but GitHub ref and PR-body writes are not one atomic CAS transaction. A source change between a final read and mutation can leave a stale partial proposal; post-write checks fail it, and #22 must independently reject stale approval at the actual merge/publication boundary. Do not claim every distributed race or concurrent human metadata edit is solved by these guards.

## Bounds and remaining gates

Per reconciliation: five minutes overall, 200 HTTP requests, ten PR-history pages, 50000 recursive tree entries, 4 MiB per response and ten seconds per individual request. Controller input/output files are at most 2 MiB each so base64 JSON remains within the HTTP response budget. These controller limits are intentionally narrower than the general 16 MiB snapshot/file APIs; large batches fail rather than truncate. Request JSON is at most 16 MiB. No automatic write retry or redirect following occurs.

Digests, consistent trees and numeric PR authorship are **not signatures, human approval or a trusted completed-release record**. They detect the tested inconsistent/edited states, not an attacker rewriting every input and checksum. The [read-only approval verifier](release-approval.md) now checks an independently recorded reviewed head against the actual merge/squash landing. Trusted approval capture/storage and the remaining #22 integration/live-race gates are still required; #23 owns approved publication and completed-cycle recovery. New cycles after a merged proposal currently stop instead of guessing that publication completed.

Verified automation-only exclusion is still outstanding in #13/#22. The collector continues failing closed on reserved bot release branches. No subsequent automated release cycle can safely be enabled by this PR alone, and the read-only rehearsal workflow remains read-only. #20 stays open pending the approved controlled API/App/concurrency/conflict runs and integration with the remaining safety gates.

Tests use real temporary Git object graphs, branch refs and file trees, replacing only GitHub HTTP. They exercise Node/Python/mixed creation, complete refresh in the same PR, no-op retries, no-release, moved/rewound sources and baselines, human metadata/content/unrelated changes, wrong identity, deleted/closed/orphan state, non-fast-forward competition, partial failures, pagination, malformed/truncated/oversized blobs and symlinks. Packed CLI tests check the exported compiled API and explicit proposal credential/network failures without making live requests. These are fixtures, not a live GitHub service compatibility or publication proof.
