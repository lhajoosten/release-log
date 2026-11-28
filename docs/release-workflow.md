# Release operations

`release-propose.yaml` accumulates merged changes. `release-quality.yaml` verifies code and checks freshness on release proposals. `release-promote.yaml` creates the stable tag at the reviewed landing. `release-publish.yaml` publishes the image and the reviewed GitHub Release. A manual run of `changelog-backfill.yaml` opens a separate changelog-only proposal.

## Recovery

To retry an interrupted publication, manually run **Release cycle** from the protected `main` branch and enter the merged release PR number in `retry-pr`. Leave it empty for a read-only preview. The retry verifies that proposal, its landing and its existing matching tag, completes publication, and refreshes the next proposal. If the tag is missing, rerun the original promotion event instead. Writes must be enabled. For the provider repository, this manual retry leaves the optional consumer channel unchanged. A later successful release can advance it; rerunning an older original event may still fail. A matching tag and matching versioned image are reusable after a GitHub Release write fails. Conflicting tag targets, image identities, generated files or release notes require investigation of the named output before retrying.

If a branch exists without its expected open release PR, check the PR history and bot ownership before recovering. The controller preserves unexpected branch contents.

A proposal records its generating provider revision. Verification loads that revision only after checking its ancestry in protected provider history. If the recorded revision or its required build inputs are unavailable, restore the reviewed provider history and runtime, then rerun the original event. Do not replace the recorded revision or silently substitute a newer runtime.

## Provider promotion and rollback

Choose a reviewed provider revision in the consumer caller. Roll back by restoring the previously reviewed revision through a consumer PR. A provider update should be rehearsed against representative Git history and controlled publication failures before consumers select it.

After provider Quality and publication succeed at the release landing, an enabled provider channel advances `consumer-v1` by fast-forward. Bootstrap and protect that branch before enabling `CONSUMER_PROMOTION_ENABLED`. Limit the promotion App to this repository and configure its ID and key in `CONSUMER_PROMOTION_APP_ID` and `CONSUMER_PROMOTION_PRIVATE_KEY`. Consumers can pin the full SHA instead. The workflow queue can retain up to 100 pending runs. For an interrupted publication with a matching tag, use the manual retry described above.
