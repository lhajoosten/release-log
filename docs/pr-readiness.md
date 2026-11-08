# PR metadata readiness

The read-only `PR metadata` workflow implements the ordinary-PR gate from [#14](https://github.com/lhajoosten/release-log/issues/14), using the [accepted release policy](release-policy.md). It is separate from source-quality CI. The workflow and fixtures are implemented; actual event/check behavior still requires an explicitly approved controlled GitHub run after rollout. Required-check settings are not configured by source changes.

## Rules

Every ordinary PR, including draft, fork, and bot PRs, must provide:

- A single-line scoped conventional title, such as `feat(exports): add selected rows`.
- Exactly one valid [version 1 release-context block](release-context.md), including for `audience: internal`.
- Valid unscoped conventional authored commits. Actual multi-parent merges are structural and are not parsed as conventional messages; a single-parent message merely looking like a merge is still validated.
- A title marked `!` when any PR commit declares breaking through `!`, `BREAKING CHANGE`, or `BREAKING-CHANGE`.
- Nonempty `required_action` for a breaking PR. The underlying context parser still accepts explicit null; the gate adds this policy rule above it.

Failures identify the title/context field or commit SHA and the relevant rule. Warning-level conventional rules stay warnings. Internal audience does not skip checks or suppress a version bump; this gate does not calculate versions.

Release-looking titles, branch names, labels, bot authors, and body markers grant no exemption. Generated release PRs must supply the same valid title/context and unscoped commits. Passing metadata checks **does not authenticate a release proposal or authorize publication**. The controller/freshness work in #20/#22 must verify automation identity, snapshot, and generated diff before any automation exclusion or release authorization.

## Current data and bounded failures

`pnpm check:pr-metadata` runs `scripts/check-pr-metadata.ts`. It requires the GitHub-provided `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME=pull_request_target`, `GITHUB_REPOSITORY`, `GITHUB_API_URL=https://api.github.com`, and a read-only `GITHUB_TOKEN`. GitHub Enterprise Server is not supported by this initial command. Do not put a token on the command line or in a fixture.

The command verifies the event's repository/PR/head identity, then uses only GET requests to fixed GitHub.com API paths:

1. Fetch the current open PR title/body, head/base identity, update timestamp, and commit count. Do not validate a stale body copied from the event.
2. Require the current head to match the event head; old-head events fail rather than approve another revision.
3. Fetch every PR commit with explicit pagination and validate its message and parent evidence. Reject duplicate, missing, inconsistent, or wrong-head evidence.
4. Run the same library validators used in local fixtures, then re-read the PR and require the captured fields to be unchanged. Concurrent title/body edits, new commits, closure, or identity changes fail with a retry instruction.

Each request has a ten-second timeout, rejects redirects, and bounds decoded response data to 4 MiB. Event files are also limited to 4 MiB; descriptions retain the parser's 1 MiB UTF-8 bound. PRs above 250 commits fail explicitly because GitHub's PR commits endpoint is capped; split the PR instead of silently accepting a truncated list. There are no automatic retries masking inconsistent state or rate limits. Authentication, permission, rate-limit, transport, and malformed-response failures exit nonzero without returning partial success.

Diagnostics are single-line JSON, not raw PR text or workflow commands. Tokens, response bodies, and arbitrary network exception messages are not logged. The check reads PR commit messages as data; it neither clones nor executes the fork's source, hooks, configuration, or scripts.

A final read detects mutations during validation, not edits after it finishes. The workflow reruns on `opened`, `synchronize`, `reopened`, `edited`, and `ready_for_review`, cancelling older runs per PR. This is a readiness check, not an immutable metadata attestation: later planning captures/validates current inputs and publication must independently verify freshness. Live check association and edit-trigger behavior remain unverified until the controlled run.

## Trusted workflow boundary and rollout

`.github/workflows/pr-metadata.yml` uses `pull_request_target` solely to execute the validator from the target repository's **base SHA**. It explicitly grants only `contents: read` and `pull-requests: read`. It never checks out a PR head or merge ref, interpolates PR text into shell source, consumes PR artifacts/caches, or supplies App/publication credentials. External Actions are SHA-pinned, checkout credentials are not persisted, caches are disabled, and the trusted lockfile is installed with lifecycle scripts disabled. The token is supplied only to the metadata-check step.

Keep these restrictions when editing the workflow. The existing unprivileged `pull_request` Quality workflow continues testing source changes separately. Never move its PR-source execution into the target-context job.

Because the validator is loaded from the base SHA, a PR introducing this workflow cannot prove its own target-context execution. Roll out the trusted implementation first, then use a separately approved sandbox PR to verify:

- A valid ordinary/fork PR passes and missing context fails with actionable output.
- Title/body edits, pushes, reopening, and readiness transitions validate current metadata and invalidate failures appropriately.
- Internal audience is accepted; breaking conflicts and missing required actions fail.
- Bot/release-looking identity cannot bypass the ordinary checks; App-created check triggering is exercised only after an App is separately provisioned.
- The intended check appears and behaves correctly before separately authorizing it as required.

No App setup, repository protection changes, remote PR mutations, or live publication are performed by the local implementation or its unit tests.

## Verification

`pnpm verify` runs the real metadata/context validators, mocked HTTP response fixtures for collection/freshness/failures, workflow-structure assertions, and offline command failure cases. These tests do not call GitHub or require real credentials. They do not prove actual GitHub event delivery, required-check behavior, App authentication, or publication readiness.
