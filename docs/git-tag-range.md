# Local Git range inspection

`src/git.ts` exposes `inspectTagRange(repository, fromTag, toTag)` and `inspectPendingRelease(repository, baseline, sourceCommitSha)` for inspecting a local repository without contacting GitHub or invoking AI. Both use captured object IDs and the same hardened Git runner.

## Existing tag-to-tag inspection

- The exact `refs/tags/` names, captured tag-object SHAs, and peeled commit SHAs. Lightweight and annotated tags are supported.
- Whether the previous tag's commit is an ancestor of the target tag's commit.
- Every commit reachable from the target commit but not the previous commit, sorted lexicographically by complete object ID for stable serialization.

Direct commits, side-branch commits, and merge commits remain present. The function does not use merge dates, choose first-parent traversal, infer PR membership, or silently filter history. Same-commit tags produce an empty range. Reversed or divergent tags return their graph facts with `fromIsAncestor: false`; this is not approval to generate a release from those ranges.

The implementation resolves exact tags rather than accepting revision expressions or falling back to branches. It uses captured object IDs for subsequent commands so moving a tag afterward cannot change that inspection's selected endpoint. Tag pairs are read sequentially, not as an atomic ref transaction.

## Pending-release inspection

`inspectPendingRelease` inspects an unreleased source commit without requiring or creating a target tag. Supply one explicit `PendingReleaseBaseline`:

- `{ kind: "tag", name: "v1.2.3" }`: resolve that exact baseline tag once, preserving its tag-object SHA and peeled commit SHA.
- `{ kind: "bootstrap", commitSha: bootstrapCommitSha }`: use an explicitly selected real commit as an exclusive first-release boundary. No tag or published release is invented.

`sourceCommitSha` and the bootstrap ID must be complete lowercase SHA-1 or SHA-256 IDs of actual commit objects. Branch names, `HEAD`, revision expressions, whitespace, abbreviated IDs (including a 40-character prefix of a SHA-256 ID), and tree/blob/annotated-tag object IDs are rejected. A baseline tag may peel to a commit; a supplied commit ID is never silently peeled from another object type.

The returned `PendingReleaseInspection` contains:

- `baseline`: the resolved discriminated baseline, with `kind` and `commitSha`; a tag baseline also retains `name` and `objectSha`.
- `sourceCommitSha`: the verified immutable source commit ID.
- `baselineIsAncestor: true`: a successful inspection requires baseline ancestry.
- `commitShas`: the complete source-minus-baseline set, sorted lexicographically by full ID. The baseline is excluded; merged side-branch and structural merge commits remain, while unmerged or later commits do not enter the set.

Unlike `inspectTagRange`, this policy-aware API rejects reversed/divergent ranges with `baseline-not-ancestor`. Identical endpoints are valid and return an empty set. An omitted or unknown baseline kind produces `invalid-baseline`; there is no implicit whole-history/bootstrap mode.

Refs moving after capture do not change the walk: tag peeling uses the captured tag object, and ancestry/enumeration use only verified commit IDs. Capture is sequential, not an atomic transaction across refs. This is not a later freshness check or proof that the tag still names a completed release.

## Safety and failures

- Commands use argument arrays, never shell interpolation. Ref names and returned full SHA-1/SHA-256 IDs are validated.
- Shallow repositories are rejected rather than reported as complete history.
- Pending inspection verifies the commit histories reachable from both captured endpoints, including common history excluded from the difference. This validation walk disables commit-graph acceleration so cached graph metadata cannot conceal missing commit objects. It does not require file trees/blobs or inspect unrelated branch history; large histories can hit the per-command timeout.
- Missing tags, invalid names, non-commit tags, unavailable repositories, and execution failures retain their existing error codes.
- Pending inspection adds `invalid-baseline`, `invalid-commit-sha`, `commit-not-found`, `object-not-commit`, and `baseline-not-ancestor` codes. Incomplete commit walks fail rather than return partial success; missing-parent diagnostics from ancestry checks are not misreported as ordinary divergence.
- Git replacement refs are disabled, and lazy fetching is disabled. No fetch operation is performed.
- Each Git command has a ten-second timeout and a 16 MiB output limit; oversized histories fail rather than truncate successfully.
- Git must be installed. Local verification used Git 2.43.0. This is a local component, not a packaged CLI.

## Boundaries

The [accepted release policy](release-policy.md) defines release membership and bootstrap semantics. Callers choose the recorded completed-release tag or explicit bootstrap boundary and capture the source SHA; these APIs do not discover the latest published release, validate SemVer/tag naming or version files, associate PRs, filter automation/direct commits, calculate the initial version, render output, or authorize publication. First-release version selection belongs to later planning, not Git inspection.

## Verification

`pnpm test` creates and removes synthetic local Git repositories. Existing tag-to-tag cases remain covered. Pending-release cases additionally cover both baseline forms, exclusive bootstrap, absent/non-commit objects, full SHA enforcement, empty/reversed/divergent ranges, merged/unmerged branches, shallow/missing-parent history, bare/SHA-256 repositories, replacement refs, and repeatability. A coordinated real-Git fixture moves the baseline tag and source branch after tag capture to verify the walk still uses the original IDs. Tests do not require GitHub credentials, network access, or a real user repository.
