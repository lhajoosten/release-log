# Release candidates and stable promotion

**Status: proposed, pending owner approval.** This spec addresses the policy gate in [#78](https://github.com/lhajoosten/release-log/issues/78). The [accepted release policy](../release-policy.md) and [rolling workflow](../release-workflow.md) govern current behavior. Every workflow rule below is a proposal.

## One opt-in candidate stream

Use the repository's existing release branch and one generated release PR at a time. Require a verified stable baseline and explicit maintainer activation in trusted workflow state before generating a candidate PR. Record the stable tag identity, peeled baseline commit, release branch, and target version. A repository may opt in and continue using stable rolling releases until activation. Activation fails during initial adoption, while a stable proposal is open, while any release landing awaits its tag, or when the stable planner returns no release.

Use canonical Git tags `vX.Y.Z-rc.N` and manifest versions `X.Y.Z-rc.N`, with a positive decimal integer `N` starting at 1 and no leading zeros. Use the current stable bump rules to calculate `X.Y.Z` at activation. Keep that target fixed. Recalculate the required target from the complete stable range on refresh and before promotion. A different result blocks the active stream. The maintainer must abandon it and explicitly activate a new stream with a freshly calculated target. Reserve issued numbers for their target even after abandonment. A restart at the same target uses the successor of the highest verified tagged number. An unexplained matching tag or an unresolved landing blocks allocation. An unmerged proposal consumes no tag number.

A candidate proposal rolls forward with ordinary merges while open, retaining its version number. After it is tagged, the next proposal may be opened explicitly when at least one new ordinary PR has landed since that candidate. Docs-only ordinary PRs qualify as candidate changes within an already releasable stable range. A tag landing or a retry by itself generates no proposal.

## Membership, manifests, and notes

For every candidate and promotion, compute the complete Git range from the pinned stable baseline to the captured release-branch source. Apply existing PR association and metadata rules. Account for earlier candidate landings as verified automation using the same identity and generated-tree evidence required for stable release exclusions. A candidate tag never advances stable membership. Unrecognized or modified automation evidence fails validation.

The first candidate reports all ordinary PRs in the stable range. A subsequent candidate reports only ordinary PRs newly reachable since the preceding verified candidate landing at that target. Derive that subset from verified Git membership and reject partial PR footprints at either boundary. A same-target restart uses the last tagged candidate as that incremental boundary. A new target starts with cumulative notes. The stable changelog entry covers all ordinary PRs since the stable baseline, regardless of how many candidates or abandoned streams included them.

Candidate PRs write the candidate version to every configured manifest and put one versioned candidate section above the released stable changelog. The next candidate replaces that section after verifying its identity and bytes. Older candidate notes remain available at their immutable tags. Promotion replaces the verified candidate section with the cumulative stable section. Preserve all earlier stable changelog bytes. Validate both the captured manifest values and the expected generated versions. After a candidate lands, the accepted current manifest value comes from the latest verified candidate landing, while the stable bump still starts from the pinned stable version. An ordinary edit to the managed version value or candidate section blocks generation until reconciled. Enabled manifest adapters must round-trip the proposed spelling, including any required ecosystem normalization and paired lockfile updates. Reject unsupported combinations at activation.

Bind mode, branch, stable baseline tag object and commit, source SHA, target version, candidate number and previous candidate identity where applicable, stream identity, and version-policy revision into snapshot and proposal identity. Bind promotion to the reviewed candidate tag object and landing SHA. Capture and verify generated paths and bytes using the existing proposal verification model. Replay under a different mode, stream, policy, or tagged boundary fails.

## Promotion and exact landing

A maintainer explicitly selects the latest successfully tagged candidate in the active stream and requests a stable proposal. Require the release-branch tip to equal that candidate's verified landing. Any intervening ordinary merge, including docs, requires another reviewed candidate. If the target calculation changes, require abandonment and fresh activation instead. A promotion proposal whose source advances becomes stale and must be closed before candidate rolling resumes.

The promotion PR may change only generated version values, their required lockfile counterparts, and the changelog. Preserve the candidate's tree everywhere else. Defer producer self-upgrades and other generated workflow edits until the stream exits. A human reviews and manually merges each candidate or promotion proposal. At tag time verify the same repository, base, generated PR identity, reviewed head and tree, and actual supported merge or squash landing under the existing exact-landing rules. Verify that the landing was based on the captured source with precisely the approved generated changes. A merge made against a newer base fails even if the PR head was reviewed.

Create the candidate tag at the candidate PR landing and the stable tag at the promotion PR landing. These commits differ because the manifest version and changelog differ. A later branch advance does not change the target of a valid tag retry. Only the successful stable tag advances the stable baseline and ends a promoted stream.

In this proposed workflow the core emits candidate Git tags. Candidate tags bypass the stable GitHub Release path and stable artifact jobs. Integrations must gate stable-only jobs on the complete stable tag grammar. Candidate artifacts, GitHub prerelease objects, mutable aliases and deployments are outside this proposal. A promoted stable tag uses the existing stable downstream policy.

## Conflicts, retries, and abandonment

Serialize activation, proposal refresh, abandonment, promotion, and tagging by repository and release branch. Re-read the trusted stream state, proposal head, landed PR and tag refs before writes. A queued operation from an older stream or proposal revision fails as stale. A merged candidate or promotion awaiting its tag blocks further proposals and stream changes. If it landed with stale or invalid evidence, stop the stream without tagging it. Any repair of that landing and verification of its automation footprint require a separately reviewed recovery decision before rolling can resume. Retry tagging with the original PR and verified landing. If a write times out, inspect the ref and verify the original landing before retrying. A matching tag is a successful no-op at the tag boundary. A tag at another commit, missing or moved recorded baseline, unverifiable generated history, or tampered proposal stops for owner investigation. Keep refs immutable. Recovery requires verified evidence before operations resume.

A maintainer can explicitly abandon an active stream after all merged tag operations reconcile. Close its open proposal and retain all candidate tags and stream evidence. Main may still carry the last candidate's manifest and changelog section. The next reviewed release proposal must verify those bytes and replace them with its own version and notes, including when stable rolling resumes directly. Stable planning resumes from the same stable tag, retains all ordinary PRs, and excludes only verified generated landings. Abandonment itself writes no release tag and makes no manifest or changelog change.

## Worked examples

Assume `v1.4.2` at commit `B`. Each capitalized identifier denotes one exact Git commit. All version-file edits below are generated.

| Step                                                    | Captured source and result                                                                    | Ordinary PRs in the stable range | Notes in the proposal |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------- | --------------------- |
| Activate after feature #101 at `A`                      | Target `1.5.0`; review `1.5.0-rc.1`                                                           | #101                             | #101                  |
| Fix #102 lands at `F` before the first candidate merges | Refresh the same proposal and number from `F`; tag its verified landing `C1` as `v1.5.0-rc.1` | #101, #102                       | #101, #102            |
| Fix #103 lands at `G` after `C1`                        | Review `1.5.0-rc.2` from `G`; tag its verified landing `C2` as `v1.5.0-rc.2`                  | #101, #102, #103                 | #103                  |
| Request promotion while the branch tip is `C2`          | Review stable metadata from `C2`; tag the verified promotion landing `S` as `v1.5.0`          | #101, #102, #103                 | #101, #102, #103      |

- If #104 merges after `S` at `H` while the stable tag job is pending, rolling waits. A retry creates `v1.5.0` at `S`, even with main at `H`. An existing tag at `S` is reused. A tag at `H` is a conflict. After reconciliation, the next stable range starts at `S` and includes #104.
- If #104 instead merges between `C2` and the promotion landing, the reviewed promotion becomes stale. Close it before it lands. With a nonbreaking #104, review `1.5.0-rc.3` before a fresh promotion. With a breaking #104, the complete range requires `2.0.0`; abandon and activate `2.0.0-rc.1` with #101–#104 in its notes. If the stale promotion nevertheless lands, both paths wait for the separately reviewed recovery.
- If the maintainer abandons after `C2` and restarts the same target after fix #104, use `1.5.0-rc.3` with #104 in candidate notes. If they resume stable rolling instead, the stable proposal uses `1.5.0` and covers #101–#104. In both paths the stable baseline is still `B`.
- From `v0.4.2`, a breaking PR yields `0.5.0-rc.1` under the existing pre-1.0 bump rules. From either stable baseline, only nonbreaking docs changes yield no release and cannot activate a stream.

## Acceptance for later implementation

- Use the worked cases as expected outcomes in planner, real-Git, proposal/tag controller and packaged CLI fixtures. Cover merge and squash landings, complete PR membership, automation exclusions, later branch advances, stale reviews, different-target restart and direct stable recovery after abandonment.
- Verify malformed candidate versions, unsupported manifests, payload tampering, incompatible replay, unknown tag-write outcomes and conflicting refs without live credentials.
- Verify that stable-only callers retain their existing behavior and that candidate tags trigger no stable publication or latest updates. Cover released changelog byte preservation and candidate/stable metadata differences.

Owner approval is required for the proposed stream model, pinned target, promotion rule, and retention of candidate metadata on the release branch after abandonment. Implementation and release execution are follow-up work.
