# Read-only release approval verification

`verifyReleaseApproval()` (`release-log/approval`, source `src/release-approval.ts`) and `verify-approval` bind an independently recorded reviewed proposal to its actual merged Git tree and immutable landing commit. This is a read-only component of [#22](https://github.com/lhajoosten/release-log/issues/22), not a publisher or an enabled release workflow.

## Trusted inputs

Run trusted pinned tool code with the existing [snapshot configuration](release-snapshot.md), an explicit approval policy, and a separately recorded approval. **Policy and approval must come from owner/host-controlled storage outside the proposal's control.** Never load them from the proposal branch, its PR body, an arbitrary artifact, or a self-reported `valid: true` result. The capture/finalization helpers below produce records from explicitly supplied trusted host inputs, but do not provision storage, authenticate the caller, collect human review, or authenticate an uploaded file.

The policy contains exactly:

```json
{ "schemaVersion": 1, "botUserId": 42, "approverUserIds": [7] }
```

These numeric IDs are illustrative, not configured repository identities. Approvers must be unique positive human IDs, excluding the bot. The recorded approver must be both allowed by policy and the actual GitHub human merger. This verifies merger identity, not whether a person meaningfully reviewed the diff or whether repository-required checks passed; those controls remain part of the trusted host/review workflow.

The approval record contains exactly these fields (replace the illustrative full object IDs/digests):

```json
{
  "schemaVersion": 1,
  "repositoryId": 17,
  "pullNumber": 1,
  "approverUserId": 7,
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "landingSha": "cccccccccccccccccccccccccccccccccccccccc",
  "mergeKind": "merge",
  "baseline": {
    "kind": "tag",
    "name": "v1.2.3",
    "objectSha": "dddddddddddddddddddddddddddddddddddddddd",
    "commitSha": "dddddddddddddddddddddddddddddddddddddddd"
  },
  "snapshotId": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "proposalId": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}
```

For bootstrap, the baseline is `{ "kind": "bootstrap", "commitSha": "FULL_COMMIT_SHA" }`, using an explicitly owner-selected full object ID. No baseline is inferred. Record the exact reviewed head, source, snapshot and proposal identity independently before accepting the merge; do not fill them retrospectively from whichever branch head exists later. The trusted host must bind those values to the actual landing and merger.

`mergeKind` accepts only `merge` or `squash`. **Record the authorized merge action through a trusted host/attestation; do not infer it from Git parent shape or the commit message.** A one-commit rebase can resemble a squash, and generic GitHub PR data does not prove the method used. Missing, unknown and `rebase` values are rejected, but a dishonest trusted record is outside this verifier's authority. Squash landings must retain the unscoped, nonbreaking `chore: prepare vX.Y.Z` subject.

Both files use bounded (1 MiB), duplicate-key-rejecting JSON and strict versioned schemas. Unknown fields, self-approval, malformed IDs and unsupported methods fail rather than migrate or guess.

## CLI and library

```sh
release-log verify-approval --config release-config.json --approval approved-release.json --policy approval-policy.json --repository .
```

Supply a repository/PR-read token through `GITHUB_TOKEN`, never in arguments or files. This command makes explicit bounded GitHub.com reads and reads complete local Git history. Fetch required objects/tags in a separately trusted step; verification performs no fetch, checkout, consumer script/backend execution, index/worktree edits, GitHub write, tag or release creation. It does not accept `--write` or `--dry-run`: every invocation is read-only.

The library takes `{ repository, configuration, policy, approval, token }` and an optional HTTP transport. It returns the approval plus release branch, planned version, configuration/policy identities, generated-file digests, sorted `automationCommitShas` and a deterministic `verificationId` that binds those values. Errors use `ReleaseApprovalError` or the existing Git/snapshot/proposal diagnostics. CLI errors omit raw bodies, credentials and unexpected exception details.

## Capture before merge, finalize after the trusted merge action

`captureReleaseReview()` and `finalizeReleaseApproval()` are also exported from `release-log/approval`. Both commands below are read-only. They emit JSON to stdout; the trusted host must persist it outside proposal-controlled storage. Neither command creates a PR, performs a merge, or publishes anything.

### 1. Capture the intended reviewed head

The host authenticates the human actor and records the exact head the person intends to review. Supply a target file containing exactly:

```json
{
  "schemaVersion": 1,
  "pullNumber": 1,
  "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "approverUserId": 7
}
```

```sh
release-log capture-review --config release-config.json --policy approval-policy.json --target review-target.json --repository .
```

The library accepts `{ repository, configuration, policy, target, token }` and an optional HTTP transport. It requires the exact intended open bot PR/head, validates local captured Git membership, and reuses the controller's exact generated-tree/metadata verification with writes explicitly disabled. Main must still equal the snapshot source. It rechecks source, proposal ref, baseline tag and PR metadata before returning. It refuses to capture a merged PR retrospectively or silently follow a refreshed head.

The resulting schema-1 review record contains the target fields plus `repositoryId`, `sourceSha`, `baseline`, `snapshotId`, `proposalId`, `configurationId`, and `policyId`. Store those bytes independently before the merge. Refreshing the proposal requires a new explicit head and review; do not update an existing stored review in place to manufacture approval. A successful capture verifies the proposal data, not that the named person actually reviewed it, required checks passed, or branch protection was enforced.

### 2. Bind the stored review to a trusted merge outcome

After an authorized merge, the host supplies a separately trusted action/response attestation containing exactly:

```json
{
  "schemaVersion": 1,
  "repositoryId": 17,
  "pullNumber": 1,
  "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "approverUserId": 7,
  "landingSha": "cccccccccccccccccccccccccccccccccccccccc",
  "mergeKind": "merge"
}
```

```sh
release-log finalize-approval --config release-config.json --policy approval-policy.json --review stored-review.json --attestation trusted-merge.json --repository .
```

The library accepts `{ repository, configuration, policy, review, attestation, token }` and an optional HTTP transport. The repository/PR/head/actor must match the stored review. The explicit merge method is never guessed from Git parents or generic PR metadata. Finalization reruns the existing landing verifier, including actual human merger, exact parents/tree/files, source freshness and final rechecks, and requires the configuration/policy identities to match the capture. It emits the existing schema-1 approval record, consumable by `verify-approval`. It does not turn a changed policy, refreshed head or stale landing into a new approval.

These new input files use the same strict, bounded, duplicate-key-rejecting JSON handling. Unknown fields, missing/inferred/rebase merge methods and mismatched identities fail. Later main descendants never change the returned landing. Publication must still rerun verification at mutation time; finalized JSON is not a durable authorization token or proof that a remote write happened.

**Host boundary remains outstanding:** calling these helpers with self-asserted actor IDs or attacker-controlled target/review/attestation files does not authenticate anything. An integration must authenticate its human review/merge action, bind the exact head, enforce review/check policy and protect immutable storage before enabling publication. No such host workflow or storage is enabled by these helpers.

## Audit an automation-only exclusion footprint

```sh
release-log audit-exclusion --config release-config.json --approval approved-release.json --policy approval-policy.json --repository . --source FULL_SOURCE_SHA --baseline-tag v1.2.3
```

For an explicit bootstrap range, replace `--baseline-tag` with `--bootstrap-sha FULL_BASELINE_SHA`. The read-only `auditReleaseExclusion()` API accepts the same repository/configuration/policy/approval/token inputs as verification plus an actual `PendingReleaseInspection` as `range`. Supply the independently trusted approval for this release, not an arbitrary bot/title/marker claim.

The audit verifies the exact landing and every generated proposal commit in its ancestry. For refreshed proposals, each older head must replay under the pinned configuration/tool, reproduce its own source-tree outputs, have the expected marker/parents, and use a source ancestral to the approved final source. An ordinary commit, edited generated output, unrelated file, inconsistent source history or unsupported old capture blocks exclusion even if the newest proposal tree looks correct. Capture/finalization/approval verification also enforce this prior-head validation; a valid final tree alone is insufficient.

A merge footprint consists of those verified generated heads plus the release landing. A squash footprint contains only the landing: unmerged side-branch heads are not part of main membership. Every other range commit remains retained, including legitimate ordinary changes to version/changelog paths. If the range already starts at or after the release landing, no exclusion is needed. A boundary splitting a footprint is rejected rather than silently excluding half of it. A source before the approved landing is rejected.

The schema-1 audit result contains repository/branch, the original verified range, approval-verification ID, PR/landing identity, sorted `excludedCommitShas` and `retainedCommitShas`, and an `auditId`. Their disjoint union equals the captured range. The original range is not rewritten, and this result does not itself modify a snapshot or plan. Verification evidence includes `automationCommitShas` and `pull` with the exact generated title/body and numeric bot ID. The strict verification parser recomputes the digest, including this metadata. Older cached verification IDs must be recomputed, not copied into new records. Approval and snapshot input schemas remain unchanged.

Limits: at most 1000 audited range commits, 100 generated commits in the source-to-head graph, 16 MiB of prior snapshot text, and five minutes for prior-head verification, in addition to existing Git/blob/API limits. Missing old tool/configuration compatibility or exceeding a limit requires explicit reviewed recovery; the audit does not truncate or skip history.

[Collection/snapshot integration](automation-exclusions.md) requires independently trusted approval authorities plus exact verification pins in current configuration. Collection reruns approval verification; schema-4 capture/replay retains and checks the complete raw graph/proof against those pins before omitting automation from product entries. Without this authority, reserved bots still fail closed. Audit JSON alone is not an unchecked bypass. This feature neither advances a completed-release baseline nor enables a controller, release loop, or publication.

## Verified boundaries

- GitHub must confirm the configured repository, same-repository reserved bot branch/base, exact merged PR head/landing and allowed human merger. Recheck PR metadata, baseline tag and release-branch ancestry before returning.
- Resolve immutable source/head/landing objects locally with complete history. Ignore replacement objects, inherited Git routing and checked-out manifest/prose changes. Input blobs must be hash-matching UTF-8, at most 2 MiB; recursive trees are bounded to 50000 entries and Git commands to ten seconds/16 MiB output. HTTP requests retain the proposal client's bounded request/response budgets.
- Replay the snapshot captured in the reviewed head, compare its baseline/source/commit membership with actual Git history and the independent approval, and regenerate Node/Python versions, changelog and snapshot from the immutable source tree. No live mutable PR context replaces captured release inputs.
- Match exact generated commit marker/parents, independently approved proposal ID, PR title/body, owned file contents/modes and every unrelated source-tree entry. A refreshed head may retain its previous proposal head as a second parent, without reusing stale generated output.
- A merge landing must have exactly `[sourceSha, headSha]` parents; a squash exactly `[sourceSha]`. Its tree must equal the reviewed head tree. If ordinary changes land before the release merge, the changed first parent invalidates approval: refresh, review and merge again instead of silently including them or dropping their content.
- Later ordinary release-branch descendants are allowed, but never change the returned `landingSha`, version or files. Publication must target that exact approved landing, not current `main`. A moved baseline or rewound/diverged release branch fails.

On any mismatch, stop and inspect the record, baseline, PR identity and generated diff. Do not repair approval by editing checksums, rewriting Git history or copying current PR values into a new success record. Refresh/review through the trusted host when the proposal is stale.

## Evidence and remaining gates

Tests use real temporary Git object graphs with mocked GitHub HTTP: merge/squash landings, Node/Python/mixed manifests, explicit bootstrap, SHA-1/SHA-256 repositories, refreshed proposals, later main commits, pre-landing concurrent changes, altered landing trees, forged identities, changed baselines, incomplete history, invalid/oversized blob inputs, dirty checkouts and concurrent metadata/ref changes. Capture/finalization tests also exercise review-before-merge, refreshed heads, source/head/baseline/body/merge races, explicit attestations, policy changes, dirty worktrees and idempotent merge/squash paths with both object formats. Packed CLI tests load the compiled exports and exercise schema, credential, unsupported-write and sanitized network failures without live requests. This is fixture evidence, not an approved sandbox race run or proof of service/App compatibility.

A digest is **not a signature or standalone publication permission**. Authenticated host review/merge capture and protected storage, review/check enforcement, completed-cycle controller reuse (#20/#23), and the approved sandbox merge-to-publication race test remain outstanding. #23 must rerun this gate immediately before any authorized mutation and implement its own retry/partial-publication safeguards; a historical green check cannot authorize a later write. No automatic workflow, live rehearsal/controller run, publication, credentials provisioning or repository-settings change is enabled here.
