# Local Git tag inspection

`src/git.ts` exposes `inspectTagRange(repository, fromTag, toTag)` for inspecting a local repository without contacting GitHub or invoking AI.

## Facts returned

- The exact `refs/tags/` names, captured tag-object SHAs, and peeled commit SHAs. Lightweight and annotated tags are supported.
- Whether the previous tag's commit is an ancestor of the target tag's commit.
- Every commit reachable from the target commit but not the previous commit, sorted lexicographically by complete object ID for stable serialization.

Direct commits, side-branch commits, and merge commits remain present. The function does not use merge dates, choose first-parent traversal, infer PR membership, or silently filter history. Same-commit tags produce an empty range. Reversed or divergent tags return their graph facts with `fromIsAncestor: false`; this is not approval to generate a release from those ranges.

The implementation resolves exact tags rather than accepting revision expressions or falling back to branches. It uses captured object IDs for subsequent commands so moving a tag afterward cannot change that inspection's selected endpoint. Tag pairs are read sequentially, not as an atomic ref transaction.

## Safety and failures

- Commands use argument arrays, never shell interpolation. Ref names and returned full SHA-1/SHA-256 IDs are validated.
- Shallow repositories are rejected rather than reported as complete history.
- Missing tags, invalid names, non-commit tags, unavailable repositories, and execution failures produce explicit error codes.
- Git replacement refs are disabled, and lazy fetching is disabled. No fetch operation is performed.
- Each Git command has a ten-second timeout and a 16 MiB output limit; oversized histories fail rather than truncate successfully.
- Git must be installed. Local verification used Git 2.43.0. This is a local component, not a packaged CLI.

## Boundaries still to decide

Release generation still needs explicit policies for divergent/reversed ranges, PR association, merge strategies, direct commits, and missing PR context. Inspection deliberately exposes the relevant facts without silently settling those policies.

## Verification

`pnpm test` creates and removes synthetic local Git repositories. It covers annotated/lightweight tags, merges and unmerged branches, exact ref resolution, malformed/command-looking names, empty and divergent ranges, shallow and bare repositories, SHA-256 IDs, replacement refs, and repeatability. Tests do not require GitHub credentials or access to a real user repository.
