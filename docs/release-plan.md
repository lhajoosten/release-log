# Release version planning

`createReleasePlan(serializedSnapshot, expectedConfiguration, versionConfiguration)` in `src/release-plan.ts` replays and revalidates a [snapshot](release-snapshot.md), then applies [release-policy-v1](release-policy.md). It does not read Git, access the network, write files, or publish a release.

Version configuration is exactly one of:

```json
{ "kind": "released", "currentVersion": "1.2.3" }
```

```json
{ "kind": "bootstrap", "initialVersion": "0.1.0" }
```

Released mode requires the captured baseline tag to be exactly `v` plus the current version. Bootstrap mode requires a captured bootstrap baseline and the approved initial version `0.1.0`; it never infers a version from a package file. Unknown fields, mismatched modes, prerelease/build versions, leading zeroes, and malformed versions fail. Stable version strings are bounded to 128 characters and arithmetic uses integers without floating-point precision loss.

## Decision and evidence

The schema version 1 result contains the policy revision, snapshot/baseline/source identities, resolved version configuration, current and next versions, release flag, chosen bump, and ordered per-PR contributions with number, URL, type, scope, breaking status, and required bump.

- Breaking changes require major at 1.x or later, minor below 1.0.0.
- Nonbreaking `feat` requires minor; `fix`, `perf`, and `revert` require patch.
- Other accepted conventional types require no bump unless breaking.
- A batch increments once by its highest requirement. PR titles classify entries; authored commit types do not create extra entries or override the PR type. Commit breaking evidence is retained and must agree with title/readiness rules.
- Audience does not change the version decision. Internal features and fixes still release.
- Bootstrap uses exactly `0.1.0` when any entry is releasable, without applying an additional bump. Breaking warnings remain in the snapshot.
- Empty and nonreleasable batches return `release: false`, `nextVersion: null`, and `bump: "none"`. Every contribution remains present. No baseline is advanced; future collection must still include these entries.

The planner does not select a baseline, verify a package version file, authenticate automation, or prove approval/freshness. Those are caller/controller boundaries, not implications of a valid version result. There are no monorepo streams, overrides, automatic graduation to 1.0.0, or AI decisions.

Tests derive expected results from the accepted policy table, including mixed batches, all nonreleasing types, breaking metadata, internal changes, bootstrap, pre-1.0 behavior, large integers, deterministic replay, invalid inputs, and baseline mismatches.
