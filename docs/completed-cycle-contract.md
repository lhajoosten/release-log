# Proposal: completed-cycle authority and stable proposal lineage

Status: **proposed for owner agreement; not accepted policy and not implemented**. This note addresses the unsupported next-cycle transition in [#20](https://github.com/lhajoosten/release-log/issues/20) and [#23](https://github.com/lhajoosten/release-log/issues/23). It does not authorize a controller run, GitHub mutation, publication, tag operation, settings change, or workflow enablement.

## Design proposal

A release cycle has two separate outcomes:

1. **Approved landing:** the reviewed proposal is merged at the exact `landingSha`, as verified by [approval verification](release-approval.md).
2. **Completed publication:** every configured tag, Release, asset, and image is freshly observed in the state required by the trusted publication policy and build receipt, as checked by [publication inspection](release-publication.md).

A merged PR or its landing is not by itself a completed release. A tag at the landing is not sufficient either. If any configured publication item is missing, inconsistent, draft, or otherwise unverified, the cycle remains incomplete and the next cycle must not start.

### Candidate completion authority

The proposal is for a trusted host—not the proposal controller, PR body, branch, artifact upload, or a caller-provided `complete: true` value—to create a durable completion record after fresh checks. The host would:

1. Authenticate its caller and load pinned tool code, approval policy, publication policy, receipt, and prior completion record from independently protected storage.
2. Freshly verify the exact approval and landing, then inspect the remote publication state for that approval, policy, and receipt.
3. Create a completion record only when inspection reports `complete: true` and no actions remain. The record write must be protected and conditional on the expected prior completion identity, so concurrent or stale workers cannot advance the baseline.
4. Reconcile again from live state after uncertain writes. A cached inspection result, historical green check, tag, or publisher `performed` list is not sufficient authority.

A candidate record would bind the repository and release branch; prior completion/baseline identity; version and tag object plus peeled landing; approval verification and proposal/PR/head/source/landing/merge identity; publication-policy and receipt identities; and the observed Release/assets/image identities and digests. The exact schema, authenticated envelope, storage/retention guarantees, and which observed fields are mandatory need owner agreement. A digest or schema-valid JSON is not authentication. The authority comes from the trusted host action and independently protected, predecessor-bound record.

The next baseline would be the completed record's exact version tag and peeled landing, never the newest tag by date or a mutable branch tip. The tag must resolve to that same approved landing. Completion records advance monotonically from the expected previous record; a moved tag, missing record, mismatched predecessor, or incomplete publication stops for explicit recovery. Do not advance the baseline to make a partial release disappear.

### Reusing `release-log/main` without rewriting history

The proposed branch remains the single stable proposal ref `release-log/main`. A new cycle starts only when the trusted completion record identifies the previous cycle and its exact proposal head, and the existing remote ref still equals that recorded head. The previous merged PR is historical evidence, not an open proposal to refresh or an object to adopt based on its title, branch, or closed state. The next cycle creates a distinct PR after validating the old cycle and branch lineage. Missing, moved, deleted, competing, or ambiguous refs/PRs require explicit owner recovery; do not recreate or adopt an orphan automatically.

For a new captured source `S2` and previous proposal head `H1`, build the new proposal tree from `S2`, not by merging old generated output. To keep the stable branch update fast-forward-only, use this parent rule:

- If `H1` is already an ancestor of `S2` (the normal merge-landing case), a proposal commit with parent `[S2]` is already a descendant of the old branch head.
- If `H1` is not an ancestor of `S2` (the squash-landing case), a proposal commit needs parents `[S2, H1]`. This preserves the old stable branch tip in the new commit's ancestry while keeping `S2` as the first parent and the basis of the generated tree.

Before updating the existing ref, re-read it and require the expected old head; update with `force: false`, then re-read and verify the new head. Serialize writers by repository/release branch. These checks are not an atomic compare-and-swap: a race or unknown outcome requires fresh reconciliation. Never force-push, delete-and-recreate the branch, or rewrite the prior proposal commit. If the remote ref advanced, stop and inspect it. The real temporary-Git test in [`completed-cycle-lineage.test.ts`](../tests/completed-cycle-lineage.test.ts) checks ancestry and ordinary non-forced push behavior; it does not test GitHub ref APIs or run the proposal/approval controllers.

The squash case has an important follow-up: when the new proposal is later merged, its inherited `H1` ancestry can enter the release landing's graph even though `H1` is not in the new source range. A future approval/exclusion implementation must validate this prior-cycle lineage against the predecessor's trusted completion record and classify it as already-authorized automation history, not as new product membership. It must still account for every current-range ordinary commit exactly once and reject unknown or edited lineage. Existing same-cycle prior-head replay is not proof that cross-cycle lineage is supported.

### Ordinary changes around the boundary

- An ordinary change that lands before the release proposal is merged changes the required source. The reviewed proposal becomes stale; refresh and review it again. Do not merge it onto a newer first parent and silently fold the change into the approved release.
- Ordinary changes after the exact landing remain outside that release and belong to the next baseline-to-source range, but only after the prior publication is complete. They are not discarded because they occur near a release or touch a version/changelog path. Existing version-adapter and generated-output checks may still reject an inconsistent value or human edit; resolve that as an explicit conflict rather than overwriting it.
- Changes arriving while publication is incomplete do not authorize a competing proposal. Finish/reconcile the existing publication or use explicit owner recovery first.

## Current support and evidence boundary

The following status is intentionally distinct from this proposal. Per the current task context, #45's verified collection exclusions/schema 4, #50's publication executor, and #51's opt-in approval policy 2 are delivered. Those capabilities do not supply the missing next-cycle completion authority or prove cross-cycle stable-branch reuse.

- `reconcileReleaseProposal()` currently rejects closed or merged proposal PRs and requires explicit completed-cycle verification before reuse. A branch without a verified open PR is not automatically adopted.
- `verifyReleaseApproval()` verifies the exact approved merge/squash landing and checks that the current release branch descends from it; it does not mint a completed-cycle record.
- `inspectReleasePublication()` returns a read-only observation. `complete: true` describes the currently observed state relative to its trusted policy and receipt; it is not a durable success flag or baseline-advance permission. The executor also does not provide an authenticated host record.
- The Git tests below prove only Git object ancestry and non-forced ref-update behavior in disposable local repositories. They do not test GitHub's PR/ref APIs, approval/exclusion support for cross-cycle history, publication completeness, a completion authority, or controller behavior.

## Decisions requiring owner agreement

1. **Authority and storage:** which authenticated host principal may create completion records, where records are protected/retained, and how a conditional append binds each record to its predecessor.
2. **Completion evidence:** the exact remote state and durable identities required in a completion record, and whether a fresh read after the final publication write is sufficient or an additional independent observation is required.
3. **Squash lineage:** approve the conditional `[S2]` / `[S2, H1]` parent rule and require prior-cycle verification/exclusion to consume the trusted predecessor record, including limits and recovery when older records or tool compatibility are unavailable.
4. **PR lifecycle:** confirm that each cycle creates a new PR while reusing the stable branch, and that merged/closed PRs are considered only when matched to the authenticated completion record—not silently reopened or adopted.
5. **Recovery and races:** define owner recovery for uncertain publication outcomes, inconsistent/missing tags or records, human branch movement, and concurrent completion attempts without deleting artifacts or rewriting refs.

Until these decisions are accepted and implemented with focused GitHub/publication boundary tests, next-cycle support remains unavailable. No live controller, API mutation, publication, setting, or tag operation was performed for this proposal.
