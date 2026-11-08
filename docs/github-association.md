# GitHub PR association

`collectMergedPullRequests(request, read?)` in `src/github-association.ts` associates a captured local Git range with merged GitHub PRs. This is the collection component for [#13](https://github.com/lhajoosten/release-log/issues/13), following the [accepted release policy](release-policy.md). It does not calculate versions, validate/normalize release context, render a changelog, or mutate GitHub.

## Inputs and network boundary

Supply the GitHub `repository` (`owner/repo`), `releaseBranch`, `localRepository` directory, the `range` returned by [pending-release inspection](git-tag-range.md), and a runtime read-only `token`. Initial adoption also supplies the `onboardingSha` pinned in trusted version 2 configuration; collection verifies baseline-to-onboarding-to-source ancestry before reads. Calling this collection function explicitly enables GitHub.com API reads; offline replay belongs to #16. The optional `GitHubRead` callback replaces only HTTP for fixture tests.

Before sending credentials, collection re-inspects the immutable baseline/source IDs locally and requires the supplied commit set to match exactly. This does not re-resolve a tag or refresh a source ref. A bootstrap projection verifies graph membership without reinterpreting the captured tag evidence. The original range remains in the result.

Use a repository-limited token with PR read access. Only GET requests to constructed `https://api.github.com/repos/...` paths are used; server-provided PR URLs, commit URLs, and pagination URLs are never executed or followed. Redirects are rejected. There is no GitHub Enterprise Server adapter, model call, package installation, Git fetch, or consumer-source execution in collection.

## Association evidence

1. For every captured commit, collect all pages from GitHub's commit-to-PR association endpoint. GitHub documents this as identifying the merged PR that introduced a default-branch commit; other histories may also return open/associated PRs. An association by itself is not release eligibility.
2. Keep only merged PRs in the configured repository targeting the release branch, whose `merge_commit_sha` is in the captured local range. Open/closed-unmerged PRs, other targets, and later/out-of-range landings do not qualify. Merge dates are retained for audit but never used for membership.
3. Fetch each qualifying PR's current details and complete original commit list once. Capture selected raw metadata, source identity, head/landing IDs, and commit messages/parents; do not retain authentication or unrelated response fields.
4. Verify each PR's actual introduced footprint using the local commit graph and GitHub mapping, as described below. Deduplicate by PR number and require exactly one PR owner or eligible bootstrap commit entry for every captured commit.
5. Re-read selected PR metadata before returning. Changed metadata or identity fails with an explicit refresh/retry instruction instead of mixing capture states.

The local graph is read through `inspectCommit`, using actual commit objects and the existing hardened Git runner. It retains messages and parent IDs without running hooks, log-format configuration, signature verifiers, or message contents. Generated multi-parent merge messages remain structural evidence; they are not parsed as conventional product entries here.

### Merge commits

A two-parent landing must have the captured PR head as its second parent. Compute its full introduced set relative to its first parent, including the merge commit. The remaining introduced IDs must exactly match the original PR commit IDs. All introduced commits must belong to the release range; a PR crossing the exclusive baseline is an error.

Each non-structural introduced commit needs unique GitHub association evidence. Structural merges can be accounted for through their verified PR/merge footprint even when the commit-to-PR endpoint has no separate entry for that merge. Unexpected commits, conflicting ownership, and unsupported merge structures fail rather than disappear.

### Squash and rebase histories

A single-parent landing is recorded as `landingKind: "linear"`; the API does not report a reliable merge-method field, so collection does not invent one.

Starting at the reported landing ID, walk backward through actual single-parent commits while complete GitHub association responses map each predecessor to the same PR. Query the predecessor at the boundary too, including when it is at/before the baseline. This detects a mapped rewritten sequence split by the baseline.

- A single landed commit with a distinct preceding association supports a squash or single-commit linear landing. Original PR SHAs need not be reachable in the release range.
- A longer mapped sequence must account for the complete original PR commit count. Keep the rewritten landed IDs separately from original IDs; never pretend pre-rebase IDs are the landed commits.
- Incomplete known footprints/counts, non-linear structures, ambiguity, or a footprint crossing the baseline fail. Missing in-range mapping fails in tagged cycles; the explicit bootstrap exception below can retain an otherwise unowned single-parent commit without claiming PR ownership. There is no merge-date, commit-subject, or patch-text matching fallback.

These guarantees depend on complete, consistent GitHub association evidence. They do not independently reconstruct GitHub's historical rebase operation from patches. A live API pilot remains separately approved work; the implemented histories are verified with synthetic local graphs and mocked HTTP.

## Explicit bootstrap commit evidence

For explicit initial adoption with a pinned onboarding SHA, a pre-onboarding range commit outside all verified PR footprints may be retained in `bootstrapCommits` if complete association reads return zero qualifying PRs. This includes manual merges as historical graph evidence; newly introduced unassociated commits after onboarding still fail. The strict lower-level version-1 bootstrap path retains only its earlier single-parent/conventional-message behavior. Re-read that association before returning; newly qualifying metadata requires a fresh collection. Keep exact local SHA, parents and message, sorted by full SHA. This is not proof that a historical commit was directly pushed: the API may lack old mapping. Do not invent a PR association or use message/patch heuristics.

Tagged cycles remain PR-only. The exception does not absorb malformed/ambiguous responses, incomplete known PR footprints, unexplained post-onboarding merges, partial baselines or unverified release automation. During snapshot capture, legacy PR readiness errors become explicit historical review warnings; new PRs still pass the normal validator. Old unstructured messages are retained, not silently assigned a type. See [initial adoption](initial-adoption.md) for the fixed configuration and warning contract.

## Output and failures

`PullRequestAssociation` contains repository/branch identity, the original range, and `pullRequests` sorted by numeric PR number. Each entry retains:

- PR number/ID, constructed source URL, raw title/body, update/merge timestamps, and numeric author/repository identities.
- Captured original head and landing IDs, original commit count, and the verified `merge` or `linear` footprint kind.
- `originalCommits` in the captured API order and `landedCommits` sorted by full SHA, with raw messages and parent IDs.

The result also has a `bootstrapCommits` array (empty outside bootstrap); library-supplied associations may omit it to mean empty, but serialized version 3 snapshots require it explicitly. Its entries have only SHA, parents and message—not PR/context fields.

The result is raw association evidence, not a schema-versioned release plan or a factual validation of PR prose. #16 must validate required conventional/context data before producing a usable snapshot. Repeated captured inputs and remote responses produce stable output; live PR metadata remains mutable until captured.

Failures throw `PullRequestAssociationError` with an actionable message and code:

- `invalid-input`, `invalid-response`, or `github-read-failed`: repair input/access or retry the failed read explicitly.
- `collection-limit`: complete collection could not be established within the documented bounds; no partial output is usable.
- `unassociated-commit`, `ambiguous-association`, `partial-membership`, or `incomplete-evidence`: repair the actual history/mapping or choose a reviewed complete boundary; do not silently exclude commits.
- `metadata-changed`: explicitly collect again rather than reuse mixed metadata.
- `automation-unverified`: release automation requires later identity/diff verification, not a bot/title exemption.

Existing local `GitInspectionError` codes still describe local repository/history failures. Remote bodies, tokens, and arbitrary transport exception messages are not included in errors.

## Limits and retry policy

- At most 1000 commits in the captured release range.
- At most ten association pages per commit, 100 entries per page; repeated entries and inconsistent pagination fail.
- At most 250 original commits per PR, reflecting the PR commits endpoint cap. All expected pages must be present, without duplicates or contradictory next-page indicators.
- At most 2000 HTTP requests and a five-minute collection budget; each request also has a ten-second timeout and a 4 MiB decoded response limit. The initial local range verification retains the Git runner's separate limits.
- Authentication, permission/rate-limit failures, transient HTTP failures, timeouts, interrupted responses, and malformed JSON fail visibly. There are no automatic retries; the caller can explicitly retry the complete read-only collection. This avoids quietly combining mutable responses across hidden retries.

No truncated result or partially associated plan is returned. Large histories require an explicitly reviewed operational approach, not an automatic skipped baseline or invented PR entries.

## Release automation boundary

Human release-looking PRs are ordinary changes; titles, labels, body text, and bot names grant no exclusion. A bot using the same-repository reserved `release-log/<releaseBranch>` head fails with `automation-unverified` because this component cannot yet verify the generated snapshot/diff identity required by #16/#20/#22. It is neither silently omitted nor automatically accepted as release automation.

Verified automation-only exclusion is therefore **not implemented here**. Do not use this collector for controller-generated release cycles until that integration exists. This explicit failure is preferable to introducing an unchecked exclusion list or claiming that a bot ID proves the diff is automation-only.

## Verification

`pnpm verify` covers actual synthetic Git merge/squash/rebase graphs, deduplication, partial baselines, out-of-range/unmerged associations, raw evidence preservation, SHA-256, deleted fork metadata, pagination, transport/authentication failures, malformed/oversized responses, mutable metadata, and deterministic results. Only HTTP is replaced in these fixtures. Existing PR-readiness tests exercise the shared reader as well.

No live GitHub collection pilot, private-source sharing, credential provisioning, publication, or tracker mutation is part of these tests. Upstream semantics were reviewed against GitHub's [commit association endpoint](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit) and [merged PR landing-ID/commit-list behavior](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request).
