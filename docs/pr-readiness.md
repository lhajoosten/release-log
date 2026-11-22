# PR metadata readiness

The read-only `PR metadata` workflow implements the ordinary-PR gate from [#14](https://github.com/lhajoosten/rolling-release/issues/14), using the [accepted release policy](release-policy.md). It is separate from source-quality CI. The deployed workflow has successful ordinary-PR and generated-release-PR runs, as recorded below. Exhaustive edit/fork/failure-event and required-check exercises still need separately authorized controlled validation. Required-check settings are not configured by source changes.

## Rules

Under the default/required context policy, every ordinary PR, including draft, fork, and bot PRs, must provide:

- A single-line scoped conventional title, such as `feat(exports): add selected rows`.
- Exactly one valid [version 1 release-context block](release-context.md), including for `audience: internal`.
- Valid conventional authored commits with or without a scope. Actual multi-parent merges are structural and are not parsed as conventional messages; a single-parent message merely looking like a merge is still validated.
- A title marked `!` when any PR commit declares breaking through `!`, `BREAKING CHANGE`, or `BREAKING-CHANGE`.
- Nonempty `required_action` for a breaking PR. The underlying context parser still accepts explicit null; the gate adds this policy rule above it.

Consumers may select the [optional context policy](release-context.md#consumer-context-policy) through the trusted release settings: `validatePullRequestMetadata(title, body, commits, contextPolicy)` or `checkGitHubPullRequest({ ..., contextPolicy })`. Omission selects `required`; unknown policy values fail before GitHub reads. The reusable workflow selects policy from its trusted release configuration. The repository-local command accepts `RELEASE_LOG_CONTEXT_POLICY=required|optional`, defaulting to `required`. This repository explicitly selects `required` in both its rolling-release configuration and its local metadata workflow.

With `optional`, absent context becomes a warning and a null context result, including for breaking PRs (which also warn about missing migration instructions). A supplied block remains fully validated, including required actions for breaking changes. Title/commit checks, pagination, permissions and mutation checks stay enforced. The command still exits successfully with warning diagnostics for accepted missing context.

Failures identify the title/context field or commit SHA and the relevant rule. Warning-level conventional rules stay warnings. Internal audience does not skip checks or suppress a version bump; this gate does not calculate versions.

Release-looking titles, branch names, labels, bot authors, and body markers grant no exemption. Generated release PRs supply the same valid title and context. Release approval verifies the exact generated squash subject under the [approval policy](release-approval.md). Passing metadata checks **does not authenticate a release proposal or authorize publication**. The [controller/tag path](release-workflow.md) verifies automation identity, snapshot and generated diff independently.

## Current data and bounded failures

`pnpm check:pr-metadata` runs `scripts/check-pr-metadata.ts`. It requires the GitHub-provided `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME=pull_request_target`, `GITHUB_REPOSITORY`, `GITHUB_API_URL=https://api.github.com`, and a read-only `GITHUB_TOKEN`. GitHub Enterprise Server is not supported by this initial command. Do not put a token on the command line or in a fixture.

The command verifies the event's repository/PR/head identity, then uses only GET requests to fixed GitHub.com API paths:

1. Fetch the current open PR title/body, head/base identity, update timestamp, and commit count. Do not validate a stale body copied from the event.
2. Require the current head to match the event head; old-head events fail rather than approve another revision.
3. Fetch every PR commit with explicit pagination and validate its message and parent evidence. Reject duplicate, missing, inconsistent, or wrong-head evidence.
4. Run the same library validators used in local fixtures, then re-read the PR and require the captured fields to be unchanged. Concurrent title/body edits, new commits, closure, or identity changes fail with a retry instruction.

Each request has a ten-second timeout, rejects redirects, and bounds decoded response data to 4 MiB. Event files are also limited to 4 MiB; descriptions retain the parser's 1 MiB UTF-8 bound. PRs above 250 commits fail explicitly because GitHub's PR commits endpoint is capped; split the PR instead of silently accepting a truncated list. There are no automatic retries masking inconsistent state or rate limits. Authentication, permission, rate-limit, transport, and malformed-response failures exit nonzero without returning partial success.

Diagnostics are single-line JSON, not raw PR text or workflow commands. Tokens, response bodies, and arbitrary network exception messages are not logged. The check reads PR commit messages as data; it neither clones nor executes the fork's source, hooks, configuration, or scripts.

A final read detects mutations during validation, not edits after it finishes. The workflow reruns on `opened`, `synchronize`, `reopened`, `edited`, and `ready_for_review`, cancelling older runs per PR. This is a readiness check, not an immutable metadata attestation: later planning captures/validates current inputs and publication must independently verify freshness. Successful ordinary/generated-PR checks have been observed; comprehensive edit-trigger, stale-head and fork behavior remain controlled-run gaps.

## Consumer setup and migration

The normal setup installs **Check PR readiness** alongside **Rolling Release**. The required check is **`release-log / metadata`**, supplied by GitHub Actions. Keep this job identity unique in the repository. [Set up Rolling Release](consumer-setup.md)

1. If you're adding readiness to an existing installation, copy the template to `.github/workflows/release-metadata-caller.yml`. Use the same reviewed `consumer-v1` reference or promoted full SHA as the release caller. Set `release-branch` and the literal `branches` filter, escaping GitHub glob characters where necessary. Both workflows read policy from the same `.release-log/settings.json` on the release branch. Older immutable callers can keep their original inline policy during migration. [Readiness template](https://github.com/lhajoosten/rolling-release/blob/main/examples/release-metadata-caller.yml)
2. Land the caller and observe a successful check on an ordinary PR, then confirm that the release App's generated proposal receives the same check. The workflow runs for fork contributions and executes only the resolved Release Log revision and its locked dependencies. It uses read-only repository and PR permissions and needs no App credentials.
3. In GitHub branch protection or an active ruleset for the configured release branch, require `release-log / metadata` and choose **GitHub Actions** as its source. With classic branch protection, enable **Do not allow bypassing the above settings**. With a ruleset, inspect its bypass list. Preserve existing merge requirements. This caller covers ordinary PR merges. GitHub merge queues require a separate check on `merge_group`.
4. Use a controlled PR to confirm GitHub blocks an invalid title or context. Fix the metadata without pushing, wait for the new result, and confirm GitHub allows the merge once other requirements pass. Make a subsequent invalid edit and confirm the merge is blocked again. Check the same gate on a generated release proposal before relying on the policy in production.

GitHub cancels superseded runs per PR. Checks read current metadata at the event head and fail if that head is stale or the metadata changes during validation. Rerun against the current PR if GitHub cancels a run or the API changes mid-check. Snapshot capture independently validates live metadata after merge, including edits that race with check results. The check does not authenticate generated release proposals.

The metadata check provides the default scoped Conventional Commit title verdict for Lint Gate adoption. It also validates authored commits, release context and breaking changes. Lint Gate conversation publishing depends on the reviewed upstream publisher contract. Keep its future publisher credentials separate from the release writer and the native check. [Lint Gate title enforcement](https://github.com/lhajoosten/lint-gate/issues/37) · [Lint Gate conversation publishing](https://github.com/lhajoosten/lint-gate/issues/38)

### Read-only onboarding verification

Run the CLI with the repository identity and branch. Older immutable callers with inline policy can still use `--config release-log.config.json`. Provide `GITHUB_TOKEN` via the environment. An authorized administrator can use a fine-grained token with repository Contents, Actions, and Administration read permissions. GitHub only exposes ruleset bypass actors to callers with authority to manage that ruleset. Inherited rules may require an organization administrator to inspect them.

```sh
release-log verify-onboarding --target OWNER/REPO --repository-id ID --release-branch main
```

The command checks the installed callers on the release branch, the metadata workflow's Actions state, and the branch's effective status-check rules. `verified` means the expected GitHub Actions check is required by at least one enforcing rule without configured bypasses. `incomplete` identifies a setup change, and `insufficient-evidence` identifies evidence GitHub did not supply, such as unreadable protection or bypass settings. Both latter outcomes exit with status 1. The report identifies the exact branch and check and makes no changes to GitHub settings. Use the controlled PR exercise above to confirm event delivery and actual merge behavior for your repository. [GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) · [GitHub ruleset API](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)

## Repository-local workflow

`.github/workflows/pr-metadata.yml` uses `pull_request_target` solely to execute the validator from the target repository's **base SHA**. It explicitly grants only `contents: read` and `pull-requests: read`. It never checks out a PR head or merge ref, interpolates PR text into shell source, consumes PR artifacts/caches, or supplies App/publication credentials. External Actions are SHA-pinned, checkout credentials are not persisted, caches are disabled, and the trusted lockfile is installed with lifecycle scripts disabled. The token is supplied only to the metadata-check step.

Keep these restrictions when editing the workflow. The existing unprivileged `pull_request` Quality workflow continues testing source changes separately. Never move its PR-source execution into the target-context job.

Because the validator is loaded from the base SHA, a PR introducing this workflow cannot prove its own target-context execution. The implementation is deployed. Successful [ordinary PR #72 metadata](https://github.com/lhajoosten/rolling-release/actions/runs/43926736110) and [generated release PR #73 metadata](https://github.com/lhajoosten/rolling-release/actions/runs/43928611710) runs were observed on 2026-11-16. Those green runs do not establish all event/failure behavior or required-check settings. Use a separately approved sandbox PR to verify remaining scenarios:

- A valid ordinary/fork PR passes and missing context fails with actionable output.
- Title/body edits, pushes, reopening, and readiness transitions validate current metadata and invalidate failures appropriately.
- Internal audience is accepted; breaking conflicts and missing required actions fail.
- Bot/release-looking identity cannot bypass the ordinary checks; App-created check triggering is exercised only after an App is separately provisioned.
- The intended check appears and behaves correctly before separately authorizing it as required.

On 2026-11-16, read-only inspection of this repository's `main` branch protection found `verify` as the sole required status check; `metadata` was not required. Strict status checks and administrator enforcement were enabled, and the branch rules endpoint returned no additional rules. This observation does not establish behavior for every event or future settings changes.

No App setup, repository protection changes, remote PR mutations, or live publication are performed by the local implementation or its unit tests.

## Verification

`pnpm verify` runs the real metadata/context validators, mocked HTTP response fixtures for collection/freshness/failures, workflow-structure assertions, and offline command failure cases. These tests do not call GitHub or require real credentials. They do not prove actual GitHub event delivery, required-check behavior, App authentication, or publication readiness.
