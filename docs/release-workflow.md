# Release operations

`release-propose.yaml` accumulates merged changes. `release-quality.yaml` verifies code and checks freshness on release proposals. `release-promote.yaml` creates the stable tag at the reviewed landing. `release-publish.yaml` publishes the image and the reviewed GitHub Release. A manual run of `changelog-backfill.yaml` opens a separate changelog-only proposal.

## Recovery

To retry an interrupted publication, manually run **Release cycle** from the protected `main` branch and enter the merged release PR number in `retry-pr`. Leave it empty for a read-only preview. The retry verifies that proposal, its landing and its existing matching tag, completes publication, and refreshes the next proposal. If the tag is missing, rerun the original promotion event instead. Writes must be enabled. For the provider repository, this manual retry leaves the optional consumer channel unchanged. A later successful release can advance it; rerunning an older original event may still fail. A matching tag and matching versioned image are reusable after a GitHub Release write fails. Conflicting tag targets, image identities, generated files or release notes require investigation of the named output before retrying.

If a branch exists without its expected open release PR, check the PR history and bot ownership before recovering. The controller preserves unexpected branch contents.

A proposal records its generating provider revision. Verification loads that revision only after checking its ancestry in protected provider history. If the recorded revision or its required build inputs are unavailable, restore the reviewed provider history and runtime, then rerun the original event. Do not replace the recorded revision or silently substitute a newer runtime.

## Provider promotion and rollback

The shipped caller uses `consumer-v1` for both provider workflows. Do not distribute it as an active default until the branch exists at a verified stable revision, is protected against unauthorized updates and deletion, and the cross-repository rehearsal below passes. A consumer can pin both references to the same promoted full SHA and update them in a reviewed PR. The branch must retain provider history so an open proposal can replay its recorded producer after an update or rollback.

The provider channel job runs only after successful publication and exact-landing quality; a failed subsequent refresh does not erase the publication result. It checks the latest successful `full:<landing SHA>` dispatch of `rolling-release-compatibility.yaml` on protected `main` in the disposable repository named by `CONSUMER_REHEARSAL_REPOSITORY`. Protect that repository and its workflow against untrusted changes: a successful full run is an authorization signal. The [rehearsal workflow](../examples/rolling-release-compatibility.yaml) has separate `preview` and `full` modes. Full mode runs controlled provider fixtures and verifies a reviewed evidence file against current GitHub and GHCR state. Before and after observations that GitHub cannot reconstruct are operator attestations and must be reviewed against preserved run logs and screenshots before merging the evidence. Never use preview as a full result. For a private disposable repository, provide the provider a narrowly scoped `CONSUMER_REHEARSAL_READ_TOKEN` with Actions read access to that repository; use `REHEARSAL_GHCR_READ_TOKEN` in the consumer only if its package requires authenticated pulls. Limit the separate promotion App to this repository and configure `CONSUMER_PROMOTION_APP_ID` and `CONSUMER_PROMOTION_PRIVATE_KEY`; enable `CONSUMER_PROMOTION_ENABLED` only after bootstrap and protection. Advancement is fast-forward only. The queue can retain up to 100 pending runs.

If promotion fails, leave the channel at its previous revision, inspect quality, publication and compatibility evidence, and rerun the original event after resolving the failure. Rollback requires an authorized protected-branch administrative procedure to restore a known-good SHA; record the old and new refs, reason, and affected consumers. Consumers needing an immediate isolated rollback can instead pin both workflow references to the known-good full SHA in a reviewed PR. Keep the original producer commits available for open proposals. Rollback targets must include the producer-selection behavior that permits replay of a later protected-main producer; older revisions that require the producer to precede the workflow cannot replay such proposals. A manual release retry does not advance the provider channel.

## Consumer rehearsal and rollout

Before channel promotion, exercise the shipped caller across repositories in a disposable consumer with a known stable boundary. Save the caller SHA and provider SHA, event run links, expected PR membership and next version. Dispatch an empty preview while paused and verify no remote writes. Enable writes, merge successive ordinary PRs, and confirm they create and refresh one proposal. Check that its read-only required check passes when fresh and fails after an alteration.

Merge the reviewed proposal and compare its landing with the stable tag, versioned image identity and GitHub Release notes. Retry by PR number after main advances and confirm digest reuse and subsequent refresh. The controlled fixture covers an interruption after image publication and before GitHub Release creation. Verify a conflicting tag blocks publication. With the caller unchanged, test a compatible channel update, complete an old-producer proposal and create a new-producer proposal; test the full-SHA pin, a failed compatibility gate, and rollback with an open proposal. Record the evidence against the exact landing before enabling the full rehearsal gate. Fixtures cannot replace this external rehearsal.

For each migration, inventory current caller and ref, release boundary, stable tag, open release state, required checks, App identity and secret reference, write state, and every deliberate override. Record the paused preview and expected PR membership. Rehearse one existing installation before the rest. Migrate each through a reviewed consumer PR, preserve unrelated CI and paused state, coordinate required-check names, and retire the old writer before enabling the new one. Keep the prior caller and settings in the rollback instructions. Stop on discrepancies rather than enabling the writer.

Discovery on 2026-11-28 found `kube-lab`, `upkeep-bot`, `review-bot`, `lint-gate` and `lucjoosten.nl` using `consumer-release.yml@f74198ff`; `lint-gate` also has release metadata at that pin, and `upkeep-bot` also has `release-propose.yaml@fc38b827`. `release-log-sandbox` uses `rolling-release.yml@74a142cd`. No open `release/next` PRs were observed. Only `upkeep-bot` had a root Dockerfile; its separate container release and inline historical repair, replay, bootstrap and fresh-series settings need compatibility assessment. Revalidate this inventory before any migration; hold consumers whose publication or overrides are unsupported.

Lint Gate also has a Marketplace workflow that checks the existing stable GitHub Release and links to human publication; retain it without introducing another release writer. Rehearse Rolling Release and the separately tracked Lint Gate channel against each other’s last compatible revision.

Upkeep Bot owns its image publication in its separate tag-triggered workflow, including version and latest tags, OCI digest verification, tests and scans; preserve that workflow and App-generated tag event, and disable Rolling Release image publication for that consumer only after reviewing the release proposal. Lint Gate is a GitHub Action published to Marketplace and does not publish an image. Its context policy, changelog formatting, bootstrap and onboarding SHAs, historical producer, credential fallback and required metadata checks require explicit mapping or compatibility support before migration. In particular, its previous `ci(release)` batch and fenced release context are not equivalent to this provider’s current title and required-action policy. Hold migration until those differences are resolved and verified. Do not introduce a duplicate image or release writer.

## Rehearsal evidence file

Install the caller as `.github/workflows/rolling-release.yaml` and this rehearsal template as `.github/workflows/rolling-release-compatibility.yaml` on protected `main` in a disposable repository. In this same disposable repository, first pin the caller to the exact candidate SHA and run the immutable-pin preview before opening the old proposal. Then install the same caller with both refs set to the protected provider staging branch `consumer-rehearsal-v1`; never use the production channel for rehearsal. Configure an App and image permissions as for an ordinary consumer. Run `preview` mode and inspect the called preview log for the expected boundary, PRs, version and changes. Review and merge changes only in the disposable repository; do not automate merges.

Set the staging branch to a previous revision that already contains the shared caller; the first usable predecessor is the protected main merge containing this work, before a later stable release landing. Create and retain an old-producer proposal, then advance only the provider staging branch to the candidate without changing consumer main. Merge the old proposal under the candidate. Create and refresh the next candidate-producer release proposal. In the dedicated disposable rehearsal repository (ID `1475512885`), set `REHEARSAL_FAIL_RELEASE_WRITE=true` **before merging** that release proposal. This downscopes the original publication App token to contents read, while leaving image publication enabled; GitHub Release creation should fail after the image exists. Verify its tag and versioned image, record the digest, and verify the GitHub Release is absent. Advance main with another ordinary PR; the proposal refresh may fail while publication is incomplete. Unset the variable and retry the tagged release PR from protected main. Record the unchanged digest, created Release and subsequent refresh. The switch has no effect outside the dedicated repository or on manual retries.

Merge another ordinary feature or fix, then capture the resulting third release proposal and its head as `newPr` and `newHead`. Capture a passing proposal check, edit its title or body and capture the failing check, then restore the reviewed text. Exercise a conflicting tag, failed promotion and rollback with an open proposal using controlled fixtures where safe live injection is unavailable. Save the corresponding run logs and before/after observations. The `release:<PR number>` caller run name ties a run to the event or retry input, including on GitHub runs where `pull_requests` is empty. The new-proposal run refers to the ordinary PR that triggered it. The full verifier fails closed if the expected run names, event types, leaf job names, provider references, image identity, tag or reviewed release differ.

Commit a reviewed `.rolling-release/rehearsal.json` on the disposable repository's protected main. Replace all values below with actual evidence. The run IDs identify a failed publication, successful retry, old-producer publication under the candidate, candidate proposal refresh, fresh and altered proposal checks, and the immutable-pin preview. `afterPr` is the ordinary PR whose landing advanced main immediately before retry. `newTriggerPr` is the ordinary merged PR that triggered that refresh; `newHead` is the proposal head observed immediately after it. The verifier checks that historical head remains in the PR commit history even if committing the evidence refreshes the proposal. The `observed` fields are operator attestations, not independent historical API proofs; reviewers must inspect the retained logs before approving the evidence change.

```json
{
  "repository": "OWNER/DISPOSABLE",
  "candidate": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "previous": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "releasePr": 11,
  "oldPr": 10,
  "newPr": 12,
  "afterPr": 8,
  "newTriggerPr": 9,
  "newHead": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "landing": "cccccccccccccccccccccccccccccccccccccccc",
  "version": "v1.2.3",
  "imageDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "runs": {
    "publication": 101,
    "retry": 102,
    "oldReplay": 103,
    "newProposal": 104,
    "freshCheck": 105,
    "alteredCheck": 106,
    "pinPreview": 107
  },
  "observed": {
    "interruptedDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "retriedDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "releaseBeforeRetry": "absent",
    "releaseAfterRetry": "present",
    "failedPromotionBefore": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "failedPromotionAfter": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "rollbackTarget": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "oldProposalReplay": "passed",
    "newProducer": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "rollbackWithOpenProposal": "passed"
  }
}
```

Dispatch `full` mode with the same candidate SHA. Preserve the run URL and evidence review; only its successful `full:<SHA>` result can satisfy provider promotion. Missing credentials, inaccessible old PR heads, unmatched run names, unavailable registry data, or an ambiguous manual observation must fail the rehearsal and require investigation. Rollout remains blocked until a real disposable run is observed and reviewed.
