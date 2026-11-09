# Release input snapshots — versions 3 and 4

`src/release-snapshot.ts` captures the validated inputs for deterministic release planning and replays them offline. This is the draft implementation for [#16](https://github.com/lhajoosten/release-log/issues/16), stacked on the [PR association](github-association.md) component. It is not version calculation, changelog rendering, release authorization, or publication.

## Library boundary

- `captureReleaseSnapshot(association, configuration)` validates the collected association evidence and conventional/context policy before returning a usable `ReleaseSnapshot`.
- `serializeReleaseSnapshot(snapshot)` revalidates the snapshot and returns canonical JSON plus one final newline. It does not write a file.
- `replayReleaseSnapshot(serialized, expectedConfiguration)` reads only captured data and trusted tool runtime assets. It returns the validated snapshot with the same normalized inputs and identity, without GitHub, Git, credentials, or a local inspected repository.

These are library APIs, not currently available CLI flags. A refresh is a new explicit collection followed by capture. Replay never calls collection or fetches a mutable PR description.

Configuration version 1 requires these fields:

| Field           | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `schemaVersion` | Number `1`                                                               |
| `repository`    | Exact `owner/repo` identity used for collection                          |
| `repositoryId`  | Positive numeric GitHub repository ID; every captured PR base must match |
| `releaseBranch` | The configured branch, matching collection                               |
| `releasePolicy` | Literal `release-policy-v1`, referring to the accepted release policy    |

The release/bootstrap boundary is already explicit in the captured range. This configuration only identifies the current extraction/normalization policy; output paths, adapters, automation identity, and publication configuration belong to later callers. No PR can override this policy. No initial/next version is calculated here.

Configuration version 2 adds a required `bootstrap` object with exactly `baselineSha` and `onboardingSha` (full immutable commit IDs). It opts into [initial adoption](initial-adoption.md) and is required for initial CLI collection. This trusted record stays fixed across proposal refreshes; tagged captures remain strict even with the record present. Version 1 retains established-release/strict-library behavior and grants no historical metadata exemption.

Both configuration versions additionally accept an optional `changelog` object with exactly one field, `verbosity`. Its value must be `detailed`, `concise` or `one-liner`. Omission retains the existing detailed rendering without inserting a new default field into captured configuration. The [verbosity contract](changelog.md#verbosity) affects presentation only, but is bound into configuration/snapshot/proposal identity. Unknown fields and malformed options still fail. Input schema versions remain unchanged; opting in requires a compatible pinned tool and fresh capture/review.

Optional `automationExclusions` pins enable [verified automation capture](automation-exclusions.md). These configurations produce schema-4 snapshots/plans with raw `verifiedAutomation` evidence and normalized `excludedPullRequests`. Records must match the independently trusted pins, raw PR identity/metadata and complete footprint. The complete original graph remains captured. Configurations without pins retain the existing schema-3 format and normalizer; no automatic migration is performed.

## Snapshot envelope and identities

The default schema-3 envelope permits exactly:

- `schemaVersion`: number `3`.
- `tool`: the tool version and `normalizerId`.
- `configuration` and `configurationId`: the validated configuration and SHA-256 of its canonical JSON.
- `input`: selected raw association evidence, including baseline/tag/source IDs, PR identity/title/body, original commit evidence, landed messages/parents, and an explicit `bootstrapCommits` array containing only real SHA/parent/message evidence. Authentication and arbitrary extra response fields are not admitted.
- `normalized`: deterministic PR metadata/context, raw context blocks, explicit breaking explanations, per-source conventional commit metadata, and recomputed validation results/warnings, with captured repository/range identity. Separate `bootstrapCommits` contain SHA, constructed commit URL and parsed conventional metadata only—never a fabricated PR number, audience or impact/action context. `historicalEntries` separately retain legacy PR/commit identity, original title/subject, nullable valid context, explicit breaking explanations and review issues—without a fabricated validation-success flag or conventional type.
- `snapshotId`: SHA-256 of the canonical envelope payload excluding `snapshotId` itself.

`normalizerId` binds normalization format revision 3, the resolved conventional rules/parser patterns loaded by the validator, declared runtime dependency versions, and the complete checked-in pnpm lockfile digest. The lockfile includes development tooling, so even a lockfile-only tooling update conservatively invalidates compatibility. The tool version must also match. The current `0.0.0` tool version is a development placeholder, not evidence of a published artifact.

Schema 4 uses the same envelope fields, sets `schemaVersion: 4`, and binds a separate exclusion-normalizer identity to the existing normalizer. Its input additionally requires `verifiedAutomation`, and normalization additionally requires `excludedPullRequests`. Their exact authority/graph/replay contract is documented in [automation exclusions](automation-exclusions.md); proof fields cannot be added to a schema-3 snapshot as an implicit exemption.

The runtime package needs its trusted `package.json`, dependency lock bytes, and existing Commitlint configuration/dependencies. The [CLI build](cli.md) preserves the lock bytes as `dist/dependency-lock.txt` because package managers omit lockfile-named files, retaining the same digest as the source checkout's `pnpm-lock.yaml`. Inspected consumer repository configuration is never loaded as validator code.

Checksums detect inconsistent/accidentally edited data. They are **not signatures or proof of approval**: someone who rewrites all inputs can recompute them. Snapshot/diff authenticity and freshness still need the trusted orchestration checks in #20/#22. A valid snapshot does not authenticate a bot or authorize a release.

## Validation before capture and replay

Capture revalidates required fields rather than accepting a stored `valid` flag:

1. Require explicit, matching repository/branch/configuration identity; supported baseline kinds; full consistent SHA-1/SHA-256 IDs; stable `vMAJOR.MINOR.PATCH` baseline tag names; and an exclusive baseline/source set. Bootstrap does not invent a tag or a version.
2. Require unique PR numbers/IDs, complete original commit counts and head evidence, constructed source URLs, and a disjoint union of PR footprints and eligible bootstrap commits covering exactly the captured range. Bootstrap commits must be unique and absent from tagged cycles; initial-adoption historical graph evidence may include pre-onboarding manual merges. Require the pinned onboarding SHA to belong to the graph, descend from the configured baseline, and keep all unassociated evidence before that cutoff. Verify merge/linear footprint structure and that the captured graph is acyclic, reaches the baseline, and contains no disconnected source changes.
3. Validate scoped PR titles, exactly one v1 context block, unscoped authored commits, breaking-title conflicts, and required actions through the same readiness/parsing functions as the gate. After onboarding and in tagged cycles, missing/invalid context fails. Before onboarding, retain the actual legacy PR and validation issues as historical warnings; preserve valid existing context and do not invent missing fields. Internal audience is retained, not filtered or treated as a version override.
4. Initial adoption retains arbitrary/empty historical commit messages without requiring modern lint, while using the existing pinned parser to preserve explicit breaking notes. Strict version-1 lower-level captures keep their previous conventional-message requirements. No PR context or unknown type is synthesized.
5. Keep structural merge messages as raw graph evidence, not conventional product entries. Validate original and landed authored messages separately; their raw representations can legitimately differ, for example through API newline representation or rebase. Retain each representation with its source identity.
6. Recompute normalized values and warnings on replay, compare them and all identities with the stored envelope, and reject mismatches. The caller supplies the expected configuration, not just whatever configuration the snapshot claims.

Graph checks make captured evidence internally consistent; offline replay does not independently prove GitHub association responses, re-read Git objects, verify file diffs, or establish that tags have not moved since collection. Those remain collection/freshness boundaries. PR prose may contain sensitive source information; preserve its raw audit context only in approved storage. Field allowlists prevent accidental API token fields from entering the format, not secrets already written into human-authored prose.

A reserved same-repository bot release branch remains unsupported without the later verified automation identity/diff integration. It cannot be smuggled into a usable snapshot by bypassing the collector. There is no unchecked exclusion list.

## Deterministic encoding and resource bounds

Object keys use code-point ordering, not locale ordering. PRs use numeric PR order, range/landed commits use full-SHA ordering, and original PR commit order and parent order remain as captured. Both original and landed authored metadata retain their source kind and raw messages. Explicit breaking explanations are deduplicated and ordered. No current timestamp or network response is added during replay.

The serializer admits only finite-number/string/boolean/null/plain-object/array JSON data. Cycles, class instances, functions, `undefined`, missing/unknown fields, and unsupported schema/policy versions fail rather than being silently discarded. Native JSON parsing is followed by full shape/identity validation; equivalent JSON whitespace/key ordering is not treated as an approval boundary.

Bounds are:

- 16 MiB UTF-8 per serialized snapshot, including the final newline.
- 32 nesting levels and 100000 traversed JSON values.
- 1000 range commits and PRs; 250 original commits per PR; 1000 landed commits per PR; 5000 total original/landed evidence records; 32 parents per commit.
- 1 MiB per body/commit message, with the existing context parser also enforcing its 1 MiB description boundary; 1 KiB titles/head refs/URLs; bounded identity strings.

Version 3 adds pinned initial-adoption policy and warning-bearing historical entries; version 1/2 snapshots are rejected, not relabeled or automatically migrated. Use the original pinned tool to replay old captures, or explicitly recapture/review them with this tool. Version 3 plans expose the onboarding identity and historical contributions alongside normal entries. Configuration supports strict version 1 or onboarding version 2; approval-record schema remains version 1. No automatic migration or live refresh is performed. A format/policy/tool mismatch requires the matching pinned tool or explicitly refreshed, reviewed capture, not a forced replay.

`ReleaseSnapshotError` distinguishes `schema-invalid`, `resource-limit`, `metadata-invalid`, `integrity-mismatch`, `configuration-mismatch`, and `normalizer-mismatch`. Metadata errors retain actionable rule/field/commit issues without returning a partial snapshot. Errors do not print whole PR bodies or authentication values.

## Verification and readiness

Tests compare normalized output with the hand-written golden `tests/fixtures/release-inputs-v3.json`, verify canonical round trips, mutate source metadata after capture, forge normalized success/checksums, and exercise malformed/unknown schemas, configuration/tool differences, raw breaking/internal context, graph inconsistency, and resource limits. A replay subprocess replaces `fetch` with a throwing function. A synthetic Git plus mocked HTTP collection also feeds capture/replay without additional reads.

Exclusion integration tests use actual temporary merge/squash Git histories with HTTP replaced, preserve ordinary before/after changes, verify schema-4 offline/CLI replay and reject changed pins/proofs, raw metadata, partial boundaries and concurrent edits. Existing schema-3 goldens/replay remain unchanged. These tests do not prove authenticated host storage, live App/race behavior, completed-cycle controller reuse or publication; those gates remain separate.
