# Release input snapshots — versions 3, 4 and 5

`src/release-snapshot.ts` captures the validated inputs for deterministic release planning and replays them offline. The [PR association](github-association.md) component supplies its complete Git/PR evidence; the [CLI](cli.md) exposes collection and offline planning/rendering. It is not version calculation, changelog rendering, release authorization, or publication.

## Library boundary

- `captureReleaseSnapshot(association, configuration, capturedAt?)` validates the collected association evidence and conventional/context policy before returning a usable `ReleaseSnapshot`.
- `serializeReleaseSnapshot(snapshot)` revalidates the snapshot and returns canonical JSON plus one final newline. It does not write a file.
- `replayReleaseSnapshot(serialized, expectedConfiguration)` reads only captured data and trusted tool runtime assets. It returns the validated snapshot with the same normalized inputs and identity, without GitHub, Git, credentials, or a local inspected repository.

The CLI `collect` command performs collection and capture; `plan`, `render` and `prepare` replay captured inputs. The functions above are library APIs, not flag names. A refresh is a new explicit collection followed by capture. Replay never calls collection or fetches a mutable PR description.

Configuration version 1 requires these fields:

| Field           | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `schemaVersion` | Number `1`                                                               |
| `repository`    | Exact `owner/repo` identity used for collection                          |
| `repositoryId`  | Positive numeric GitHub repository ID; every captured PR base must match |
| `releaseBranch` | The configured branch, matching collection                               |
| `releasePolicy` | Literal `release-policy-v1`, referring to the accepted release policy    |

The release/bootstrap boundary is already explicit in the captured range. This configuration only identifies the current extraction/normalization policy; output paths, adapters, automation identity, and publication configuration belong to later callers. No PR can override this policy. No initial/next version is calculated here.

Configuration version 2 adds a required `bootstrap` object with exactly `baselineSha` and `onboardingSha` (full immutable commit IDs). It opts into [initial adoption](initial-adoption.md) and is required for initial CLI collection. This trusted record stays fixed across proposal refreshes; tagged captures use the configured ordinary-PR rules even with the record present. Version 1 retains established-release/strict-library behavior and grants no historical metadata exemption.

Both configuration versions accept optional `contextPolicy` with exactly `required` or `optional`. Omission preserves the previous strict behavior and configuration identity. The [context-policy contract](release-context.md#consumer-context-policy) defines absent versus malformed context, breaking warnings and trusted gate configuration. Explicit selection binds an additional normalizer revision (composed with exclusion normalization when present), and participates in configuration/snapshot/proposal identity. Omitting the field does not add a context-policy identity component; no automatic migration or reinterpretation occurs. A changed policy requires fresh capture and review.

Both configuration versions additionally accept an optional `changelog` object requiring `verbosity` and optionally accepting `format` (`classic` or `compact`). The format is captured in configuration/snapshot/proposal identity; omission retains classic rendering. The `verbosity` value must be `detailed`, `concise` or `one-liner`. Omission retains the existing detailed rendering without inserting a new default field into captured configuration. The [verbosity contract](changelog.md#verbosity) affects presentation only, but is bound into configuration/snapshot/proposal identity. Unknown fields and malformed options still fail. Input schema versions remain unchanged; opting in requires a compatible pinned tool and fresh capture/review.

For an already merged commit, reviewed caller configuration can supply `commitMessageRepairs`. Each entry pins the PR number and full commit SHA. Supply either a non-breaking `docs: ...` or `ci: ...` subject for a missing conventional type or `wrapBody: true` when the only error is body line length. Wrapping breaks long lines at spaces. Capture retains the original Git message, records a repair warning, and validates the result, including breaking notes. Keep approved entries available to verify earlier proposals that used them. PR readiness continues to validate original messages before merge.

Optional `automationExclusions` pins enable [verified automation capture](automation-exclusions.md). Legacy captures use schema-4 snapshots/plans; new online captures use schema 5 with the same raw `verifiedAutomation` evidence and normalized `excludedPullRequests`. Records must match the independently trusted pins, raw PR identity/metadata and complete footprint. The complete original graph remains captured. Configurations without pins use the schema-3 format and base normalizer; no automatic migration is performed.

## Snapshot envelope and identities

The default schema-3 envelope permits exactly:

- `schemaVersion`: number `3`.
- `tool`: the tool version and `normalizerId`.
- `configuration` and `configurationId`: the validated configuration and SHA-256 of its canonical JSON.
- `input`: selected raw association evidence, including baseline/tag/source IDs, PR identity/title/body, original commit evidence, landed messages/parents, and an explicit `bootstrapCommits` array containing only real SHA/parent/message evidence. Authentication and arbitrary extra response fields are not admitted.
- `normalized`: deterministic PR metadata/context, raw context blocks (both context and block are null only for an accepted missing block under optional policy), explicit breaking explanations, per-source conventional commit metadata, and recomputed validation results/warnings, with captured repository/range identity. Separate `bootstrapCommits` contain SHA, constructed commit URL and parsed conventional metadata only—never a fabricated PR number, audience or impact/action context. `historicalEntries` separately retain legacy PR/commit identity, original title/subject, nullable valid context, explicit breaking explanations and review issues—without a fabricated validation-success flag or conventional type.
- `snapshotId`: SHA-256 of the canonical envelope payload excluding `snapshotId` itself.

`normalizerId` binds normalization revision 4 (ordinary commit scopes are accepted), the resolved conventional rules/parser patterns loaded by the validator, declared runtime dependency versions, and the complete checked-in pnpm lockfile digest. The lockfile includes development tooling, so even a lockfile-only tooling update conservatively invalidates compatibility. The tool version must also match. The tool version comes from its trusted packaged manifest. Snapshots captured under revision 3 require their compatible pinned producer for replay. To adopt revision 4, capture and review new inputs.

Schema 4 uses the same envelope fields, sets `schemaVersion: 4`, and binds a separate exclusion-normalizer identity to the existing normalizer. Its input additionally requires `verifiedAutomation`, and normalization additionally requires `excludedPullRequests`. Their exact authority/graph/replay contract is documented in [automation exclusions](automation-exclusions.md); proof fields cannot be added to a schema-3 snapshot as an implicit exemption.

The runtime package needs its trusted `package.json`, dependency lock bytes, and existing Commitlint configuration/dependencies. The [CLI build](cli.md) preserves the lock bytes as `dist/dependency-lock.txt` because package managers omit lockfile-named files, retaining the same digest as the source checkout's `pnpm-lock.yaml`. Inspected consumer repository configuration is never loaded as validator code.

Checksums detect inconsistent/accidentally edited data. They are **not signatures or proof of approval**: someone who rewrites all inputs can recompute them. Snapshot/diff authenticity and freshness still need the trusted orchestration checks in #20/#22. A valid snapshot does not authenticate a bot or authorize a release.

## Capture metadata (schema 5)

New `collect` and `roll` captures use schema 5. It adds the required envelope field `capturedAt`, an exact UTC ISO timestamp with milliseconds (`2026-11-16T20:34:56.789Z`), recorded after collection. This means **inputs captured at**, not release, merge or publication time. Replay and rendering validate and reuse that value without consulting the current clock. It participates in `snapshotId`, so separately captured inputs have distinct identities when capture time changes. Proposal reconciliation retains the first capture when an otherwise byte-equivalent schema-5 collection is retried, preserving no-write retries. A change to evidence or configuration uses the newly captured time.

PR evidence may additionally include `authorLogin` (bounded to 256 UTF-8 bytes), sourced from GitHub's PR `user.login`; null or absence means unavailable. A deleted/unavailable user retains null `authorId`, `authorLogin` and an `Unavailable` type. Available users retain their existing numeric ID and type; bots remain ordinary captured contributors unless independently excluded by existing automation authority. No commit-author, co-author or display-name inference is performed. Classification and normalized contributions are unchanged.

Schema 5 composes with existing exclusion pins: `verifiedAutomation` and `excludedPullRequests` remain required exactly when configured. Plans expose schema 5 and retain exclusions in the same way as schema 4. Configuration schemas and normalizer identities remain unchanged; the envelope version identifies the capture-metadata extension.

Schemas 3 and 4 remain supported with their exact legacy shape, identities and rendered bytes under their matching runtime/configuration. Missing capture time or authors are never synthesized on replay. The lower-level library keeps its two-argument legacy capture contract; pass an explicit canonical timestamp as the third argument for new enriched captures. This keeps the capture/normalization library deterministic: only the online caller reads the clock. Older tools reject schema 5; use a compatible pinned tool or the original tool for its original snapshots. No relabeling or automatic migration is performed.

## Validation before capture and replay

Capture revalidates required fields rather than accepting a stored `valid` flag:

1. Require explicit, matching repository/branch/configuration identity; supported baseline kinds; full consistent SHA-1/SHA-256 IDs; stable `vMAJOR.MINOR.PATCH` baseline tag names; and an exclusive baseline/source set. Bootstrap does not invent a tag or a version.
2. Require unique PR numbers/IDs, complete original commit counts and head evidence, constructed source URLs, and a disjoint union of PR footprints and eligible bootstrap commits covering exactly the captured range. Bootstrap commits must be unique and absent from tagged cycles; initial-adoption historical graph evidence may include pre-onboarding manual merges. Require the pinned onboarding SHA to belong to the graph, descend from the configured baseline, and keep all unassociated evidence before that cutoff. Verify merge/linear footprint structure and that the captured graph is acyclic, reaches the baseline, and contains no disconnected source changes.
3. Validate scoped PR titles, the configured ordinary-PR context policy, scoped or unscoped conventional commit messages, breaking-title conflicts, and required actions through the same readiness/parsing functions as the gate. After onboarding and in tagged cycles, missing context fails under the default/required policy; optional policy retains a null context/raw block and explicit warnings. A supplied malformed block always fails. Breaking PRs without context retain breaking classification and a missing-migration warning; supplied breaking context still needs an action. Before onboarding, retain the actual legacy PR and validation issues as historical warnings; preserve valid existing context and do not invent missing fields. Internal audience is retained, not filtered or treated as a version override.
4. Initial adoption retains arbitrary/empty historical commit messages without requiring modern lint, while using the existing pinned parser to preserve explicit breaking notes. Strict version-1 lower-level captures keep their previous conventional-message requirements. No PR context or unknown type is synthesized.
5. Keep structural merge messages as raw graph evidence, not conventional product entries. Validate original and landed authored messages separately; their raw representations can legitimately differ, for example through API newline representation or rebase. Retain each representation with its source identity.
6. Recompute normalized values and warnings on replay, compare them and all identities with the stored envelope, and reject mismatches. The caller supplies the expected configuration, not just whatever configuration the snapshot claims.

Graph checks make captured evidence internally consistent; offline replay does not independently prove GitHub association responses, re-read Git objects, verify file diffs, or establish that tags have not moved since collection. Those remain [collection](github-association.md) and [proposal/tag freshness](release-workflow.md) boundaries. PR prose may contain sensitive source information; preserve its raw audit context only in approved storage. Field allowlists prevent accidental API token fields from entering the format, not secrets already written into human-authored prose.

A reserved same-repository bot release branch requires the [verified automation identity/diff integration](automation-exclusions.md) when its footprint is inside the collected range. Normal rolling cycles instead begin at the verified release tag, outside the prior release footprint. It cannot be smuggled into a usable snapshot by bypassing the collector. There is no unchecked exclusion list.

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
