# Read-only release approval verification

`verifyReleaseApproval()` (`release-log/approval`, source `src/release-approval.ts`) and `verify-approval` bind an independently recorded reviewed proposal to its actual merged Git tree and immutable landing commit. This is a read-only component of [#22](https://github.com/lhajoosten/release-log/issues/22), not a publisher or an enabled release workflow.

## Trusted inputs

Run trusted pinned tool code with the existing [snapshot configuration](release-snapshot.md), an explicit approval policy, and a separately recorded approval. **Policy and approval must come from owner/host-controlled storage outside the proposal's control.** Never load them from the proposal branch, its PR body, an arbitrary artifact, or a self-reported `valid: true` result. This component does not provision that storage, collect human review, or authenticate an uploaded approval file.

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

The library takes `{ repository, configuration, policy, approval, token }` and an optional HTTP transport. It returns the approval plus release branch, planned version, configuration/policy identities, generated-file digests and a deterministic `verificationId`. Errors use `ReleaseApprovalError` or the existing Git/snapshot/proposal diagnostics. CLI errors omit raw bodies, credentials and unexpected exception details.

## Verified boundaries

- GitHub must confirm the configured repository, same-repository reserved bot branch/base, exact merged PR head/landing and allowed human merger. Recheck PR metadata, baseline tag and release-branch ancestry before returning.
- Resolve immutable source/head/landing objects locally with complete history. Ignore replacement objects, inherited Git routing and checked-out manifest/prose changes. Input blobs must be hash-matching UTF-8, at most 2 MiB; recursive trees are bounded to 50000 entries and Git commands to ten seconds/16 MiB output. HTTP requests retain the proposal client's bounded request/response budgets.
- Replay the snapshot captured in the reviewed head, compare its baseline/source/commit membership with actual Git history and the independent approval, and regenerate Node/Python versions, changelog and snapshot from the immutable source tree. No live mutable PR context replaces captured release inputs.
- Match exact generated commit marker/parents, independently approved proposal ID, PR title/body, owned file contents/modes and every unrelated source-tree entry. A refreshed head may retain its previous proposal head as a second parent, without reusing stale generated output.
- A merge landing must have exactly `[sourceSha, headSha]` parents; a squash exactly `[sourceSha]`. Its tree must equal the reviewed head tree. If ordinary changes land before the release merge, the changed first parent invalidates approval: refresh, review and merge again instead of silently including them or dropping their content.
- Later ordinary release-branch descendants are allowed, but never change the returned `landingSha`, version or files. Publication must target that exact approved landing, not current `main`. A moved baseline or rewound/diverged release branch fails.

On any mismatch, stop and inspect the record, baseline, PR identity and generated diff. Do not repair approval by editing checksums, rewriting Git history or copying current PR values into a new success record. Refresh/review through the trusted host when the proposal is stale.

## Evidence and remaining gates

Tests use real temporary Git object graphs with mocked GitHub HTTP: merge/squash landings, Node/Python/mixed manifests, explicit bootstrap, SHA-1/SHA-256 repositories, refreshed proposals, later main commits, pre-landing concurrent changes, altered landing trees, forged identities, changed baselines, incomplete history, invalid/oversized blob inputs, dirty checkouts and concurrent metadata/ref changes. Packed CLI tests load the compiled export and exercise schema, credential, unsupported-write and sanitized network failures without live requests. This is fixture evidence, not an approved sandbox race run or proof of service/App compatibility.

A digest is **not a signature or standalone publication permission**. Trusted approval capture/storage, review/check enforcement, verified automation-only exclusion (#13/#22), completed-cycle controller reuse (#20/#23), and the approved sandbox merge-to-publication race test remain outstanding. #23 must rerun this gate immediately before any authorized mutation and implement its own retry/partial-publication safeguards; a historical green check cannot authorize a later write. No automatic workflow, live rehearsal/controller run, publication, credentials provisioning or repository-settings change is enabled here.
