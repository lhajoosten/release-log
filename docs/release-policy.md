# ADR: release policy and automation architecture

Status: **accepted — owner approved on 2026-11-08**. Implements the policy-design portion of [#12](https://github.com/lhajoosten/release-log/issues/12), under feature [#7](https://github.com/lhajoosten/release-log/issues/7). Owner `lhajoosten` approved the draft in the implementation conversation. This approves the policy and dependent source implementation, not credential provisioning, live integration runs, repository settings, or publication.

**Scope amendment — owner approved on 2026-11-14:** the [rolling-release workflow decision](release-workflow.md) supersedes the broader orchestration/publication requirements from the original design. Maintain one deterministic release PR; a human manually merges; automatically tag that exact landing. Version tags establish release boundaries, and repository-owned downstream jobs handle artifacts/deployment. Custom approval receipts, a publication host, and protected completion records are not required. PRs #52 and #53 were closed as superseded, not adopted. Existing component APIs are preserved.

The existing conventional-message and version 1 context formats remain agreed component contracts. The release-policy decisions below are now accepted for implementation, including the metadata gate in [#14](https://github.com/lhajoosten/release-log/issues/14). Approval is not evidence that those capabilities are implemented or verified.

## Existing behavior and gap

- `inspectTagRange` captures exact tag objects and commit IDs and returns reachability facts, including divergent ranges. It does not select a release baseline or associate PRs.
- `validateConventionalMessage` accepts scoped and unscoped metadata and preserves explicit breaking evidence. Contribution checks separately require unscoped commits and scoped PR titles.
- `parseReleaseContext` requires exactly one valid version 1 block, preserves raw context, and reports actionable failures. `internal` is valid, not an exemption.
- Quality CI validates titles and non-merge commits. It does not validate PR bodies, manage release PRs, or publish anything.

See [Git inspection](git-tag-range.md), [conventional metadata](conventional-metadata.md), and [release context](release-context.md). This ADR defines policy above those APIs; it does not change their behavior. The separate [PR metadata gate](pr-readiness.md) implements readiness validation above them.

## Decision: a small controller over the deterministic CLI

Use one release-log planning library/CLI as the authority for membership, captured metadata, version, and changelog. A thin reusable workflow maintains one proposal PR and tags its exact landing after manual merge. Artifact publication and deployment are separate consumer-owned workflows. Workflow YAML invokes the same tested commands rather than implementing another engine.

### Original reuse assessment

The comparison below records the 2026-11-08 assessment, including artifact-recovery work that is no longer required by the 2026-11-14 scope amendment. It is historical rationale, not a mandate to implement a publication system.

release-please already maintains rolling release PRs, updates language-specific version files, and creates tags/GitHub Releases. Its manifest supports bootstrap SHAs, pre-1.0 bump options, and configurable PR titles. Its strategy, changelog, updater, and plugin interfaces provide genuine extension points; a custom implementation is not the only possible solution.

| Requirement                                                    | release-please reuse                                                                                            | Small release-log controller                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Rolling PR, version-file updates, tag/Release lifecycle        | Existing implementation and maintenance advantage                                                               | Must implement and test these boundaries ourselves      |
| Scoped titles and selected bump policy                         | Configurable; not a reason to reject reuse                                                                      | Reuse existing contribution parsers and explicit policy |
| Exactly one entry per merged PR with mandatory v1 context      | Documented default parses conventional commits; requires an adapter/custom strategy for our PR/context contract | Plan directly from the captured PR set                  |
| Immutable Git membership and offline replay of captured inputs | Requires integration beyond the documented default workflow                                                     | Core planning input, shared by all callers              |
| Recomputed artifact identity and merge-time freshness          | Requires an additional verification layer                                                                       | Required controller/publication boundary                |
| CLI/OCI uploads and partial-failure reconciliation             | Package publication is explicitly outside release-please's scope                                                | Separate publication implementation still required      |

**Accepted decision:** select the small controller. A release-please adapter remains technically possible, but would still need custom membership/context capture, offline replay, freshness verification, and artifact recovery. Maintaining both its commit-driven planning and our snapshot-driven planning risks two authorities for one release. Do not claim release-please cannot support extensions or that this comparison is an integration proof.

The tradeoff is losing mature orchestration and version-file adapters. Keep the replacement bounded: one GitHub repository, one release branch and version, no plugin framework, no monorepo or prerelease support, and no AI. Revisit reuse if those boundaries or the snapshot requirement change. Do not add release-please as an unused dependency.

Sources reviewed on 2026-11-08: release-please [README](https://github.com/googleapis/release-please/blob/ea20bc261acd75149f0be90890bb9c90e681eea7/README.md), [customization](https://github.com/googleapis/release-please/blob/ea20bc261acd75149f0be90890bb9c90e681eea7/docs/customizing.md), and [manifest behavior](https://github.com/googleapis/release-please/blob/ea20bc261acd75149f0be90890bb9c90e681eea7/docs/manifest-releaser.md). No release-please execution or compatibility spike has been performed.

## Release contract

### Baseline, bootstrap, and ancestry

- A normal baseline is the exact `vMAJOR.MINOR.PATCH` tag of the last successfully completed release, with its tag object and peeled commit recorded. Do not select a tag by date or silently guess from unrelated repository tags. Initial adoption of an existing release requires the owner to identify that baseline explicitly; subsequent release-PR merges automatically create their version tag as its successor. Downstream artifact publication is not a prerequisite for this baseline.
- Accept only stable, three-component, nonnegative SemVer versions without leading zeroes, prerelease identifiers, or build metadata in this initial contract. Reject malformed versions, conflicting release records, missing/moved baseline tags, and a version file that disagrees with the released version.
- Capture baseline and target source IDs once. The baseline must be an ancestor of the source. Reject divergent/reversed ranges, shallow or incomplete history, and non-commit targets. No fetch or ref refresh is an implicit part of offline planning.
- With no released baseline, require an explicitly configured bootstrap commit SHA and initial version. The baseline is exclusive; it is not a fabricated tag or published release. Use `0.1.0` as the initial version, not an inferred consequence of the current `package.json` placeholder `0.0.0`.
- For existing repositories, the owner selects the bootstrap SHA after reviewing what history is intentionally excluded. The first commit is a valid exclusive base: its own message is excluded, and all subsequent reachable history remains accounted for. Do not invent context, edit published history, or silently skip old entries; the pinned onboarding boundary below determines legacy metadata handling.
- Initial-adoption amendment approved by the owner on 2026-11-08: record the exclusive baseline and a fixed onboarding SHA in trusted version 2 configuration. Through that SHA, retain unstructured PRs/commits and manual merges as historical source evidence with review warnings. Keep valid old context and explicit breaking explanations, but never fabricate a PR, conventional type, scope, audience, impact or migration action. Do not require historical PR edits merely to adopt the tool.
- The onboarding SHA must descend from the baseline and be ancestral to each captured source. Keep it fixed while the first proposal refreshes; changes after it require normal PR metadata/evidence. Configuration/proposal identity must reject an attempted cutoff change, not silently exempt new work. Tagged cycles always use normal rules.
- Explicit initial-adoption planning proposes `0.1.0` from the captured application tree without requiring historical feature/fix labels or an additional bump. An application contained entirely in its first commit can have an initial proposal despite an empty exclusive changelog range. Preserve review/breaking warnings. This is not automatic publication or permission to overwrite an existing released manifest version.

### Membership and PR association

Define the candidate commit set as every commit reachable from the captured source but not the captured baseline. Use the complete graph, not merge dates or only first-parent commits.

1. Associate landed changes with merged PRs in the same repository targeting the configured release branch. A PR must have verifiable landing evidence at or before the source; an open PR or a PR merged later cannot qualify just because an API reports an association with a shared commit.
2. Support ordinary merge, squash, and rebase histories only when the collected evidence accounts for their landed commits unambiguously. For a merge, verify the merge commit and introduced commits; for squash, verify the landed squash commit; for rebase, verify the actual rewritten landed sequence, not equality with pre-rebase SHAs. Missing GitHub mapping evidence fails with a diagnostic, not a heuristic based on titles or dates.
3. Deduplicate by repository and PR number. Retain all covered commit IDs, landing evidence, raw title/context, and relevant conventional messages. Multiple commits from a PR yield one entry. A PR landing across the baseline boundary is an invalid partial membership case, not permission to include only part of it.
4. Multi-parent merge commits are structural evidence, not conventional product entries. Account for them through their verified PR/merge relationship; do not simply delete all merges from membership inspection. After onboarding and in tagged cycles, an unexplained merge or a merge carrying unassociated changes fails. A pre-onboarding unassociated merge is retained as complete historical graph evidence with a review warning.
5. In tagged release cycles, every remaining non-structural commit must have exactly one qualifying association. In initial-adoption mode, otherwise unowned pre-onboarding commits with zero qualifying PR associations are retained separately as historical Git evidence; recheck their absence of association before returning. This includes unstructured/manual-merge history without inventing a PR. Missing API mapping cannot prove a commit was historically direct, so label it unassociated rather than claiming a nonexistent PR. All range commits must still be accounted for exactly once. Ambiguity, incomplete pagination, permission failures, unsupported post-onboarding structural history and unavailable evidence block both modes.
6. Exclude only verified automation-only release changes under the identity/diff rules below. Ordinary changes before or after a release merge remain eligible, including ordinary changes touching version/changelog paths.

API collection must be explicit and bounded, with complete pagination or failure, actionable rate-limit/timeout errors, and no partial-success snapshot. The exact snapshot schema and retry limits belong to #13/#16, not to a second planning implementation here.

### Conventional metadata and breaking conflicts

- For post-onboarding changes and tagged cycles, validate each ordinary PR title as a **scoped title**, not merely as a message accepted by the general metadata parser. Validate authored commit messages with the separate **unscoped commit** convention. Generated structural merge messages are not authored conventional entries.
- Use the PR title's type and scope for its single release entry. Commit types do not create extra entries or override the PR's type. For example, a nonbreaking `feat` commit inside a `fix(api)` PR does not independently demand a minor release; the author/reviewer must make the title describe the delivered change.
- For strict new/tagged entries, preserve explicit `!`, `BREAKING CHANGE`, and `BREAKING-CHANGE` evidence from conventional metadata in the captured PR commit evidence and landed non-merge messages. If any commit declares breaking but the PR title lacks `!`, fail with instructions to mark the title and review the required action. Never downgrade it to the title's nonbreaking classification. A title may declare breaking even if no commit does.
- A strict new/tagged breaking PR needs nonempty `required_action` text. `null` remains valid in the v1 parser and for nonbreaking PRs; this is a readiness/planning rule above the parser, not a schema change. A nonbreaking PR may also have required actions.
- Require exactly one valid v1 context block for every post-onboarding PR and every PR in a tagged cycle, including bot dependency updates. Initial-adoption legacy PRs may instead retain missing/invalid metadata as warnings; valid existing context remains preserved. Do not add a context version/bump override. Audience controls optional user-facing notes only, never release membership or bump size.
- Initial-adoption historical entries retain original titles/messages, real source links, warning codes and explicit breaking notes even when modern lint fails. Unknown types remain unclassified. A missing breaking migration action is visible review work, not fabricated guidance. The ordinary PR gate's unscoped-commit and breaking-title/action rules remain unchanged for new work and tagged cycles.
- Arbitrary PR-body prose is not a conventional footer. Human review establishes whether the title, summary, impact, and action accurately describe the change; parsing cannot prove that.

### Version calculation

For an established release, take the highest required bump across distinct validated PRs, then increment once:

| Evidence                                                                   | Current version at least 1.0.0 | Current version below 1.0.0 |
| -------------------------------------------------------------------------- | ------------------------------ | --------------------------- |
| Explicit breaking declaration on any conventional type                     | Major                          | Minor                       |
| Nonbreaking `feat`                                                         | Minor                          | Minor                       |
| Nonbreaking `fix`, `perf`, or `revert`                                     | Patch                          | Patch                       |
| Nonbreaking `build`, `chore`, `ci`, `docs`, `refactor`, `style`, or `test` | None                           | None                        |

A pre-1.0 minor bump resets patch to zero and does not implicitly graduate to 1.0.0. Graduation requires a separately reviewed policy change, not a hidden version override. `revert` is conservatively patch-releasing; do not infer cancellation of an earlier feature or remove either PR's evidence.

Internal `feat`/`fix` changes still bump under this table. Breaking `docs`/`chore` changes still break. In an established release cycle, a docs/internal-only batch with no releasable types produces an explicit no-release result. Its entries are retained in the captured plan and included in the next releasable batch because no baseline advances on a no-release result. An already-open proposal is regenerated from the entire range, not just the latest event.

### Technical changelog and version files

- Include every ordinary PR in a releasable batch once, including non-bumping and internal entries. Always retain summary, available required action, breaking warning/evidence and source PR link. Keep complete impact/context evidence in the snapshot; do not invent user benefits. Owner-approved verbosity amendment on 2026-11-09: trusted configuration may select `detailed` (the compatibility default, including routine impact/diagnostics), `concise` (omit routine detail, preserve nested safety instructions) or `one-liner` (one line per entry with safety instructions inline). These modes change presentation only, not membership, audience or bump policy; the selected mode is pinned into capture/proposal identity.
- Retain initial-adoption historical entries once under a clearly labeled historical section, ordered by PR number followed by full commit SHA. Keep original titles, source links, available required actions and breaking explanations in every mode. Detailed mode also shows available valid context and per-entry warning codes; reduced modes consolidate historical metadata review into the release-level notice while complete evidence remains captured. Do not infer types or fill missing impact/migration fields with invented prose. Normal validated entries keep their existing type/scope grouping.
- Group by conventional type in this fixed order: `feat`, `fix`, `perf`, `revert`, `refactor`, `docs`, `build`, `ci`, `test`, `style`, `chore`. Within a group order by scope using code-point comparison, then ascending numeric PR number. Do not use locale, current date, API return order, or merge timestamps as implicit ordering inputs.
- Treat context as untrusted text. Rendering must escape active HTML and Markdown structure, construct repository/PR links from validated identity, and never execute text. Define exact escaping and owned-section markers with golden tests in #18.
- Replace only the owned pending section; preserve released sections and unrelated human content. Invalid boundaries or human edits to expected generated content are conflicts, not permission to overwrite.
- Support root `package.json` and static `pyproject.toml` version adapters (Python support explicitly requested by the owner on 2026-11-08). Update only the root JSON version or static `[project].version` / `[tool.poetry].version` TOML value ranges. Present manifests and Python mirrors must agree; reject dynamic/backend-derived versions without executing consumer code. Update any explicitly required lockfile version mirror, or fail until its adapter exists. This repository's pnpm lockfile has no root version mirror. Do not run consumer lifecycle scripts, Python build backends, or installs to update a version. Other formats require a separately specified adapter, not a guessed text replacement.
- Proposal-owned outputs are the configured changelog section, version fields, and captured release-plan file. Exact paths and serialization are fixed before #18/#19/#20 callers depend on them. No arbitrary write paths, symlink escapes, or plugin execution from inspected repositories.

### Configuration and replay boundary

The configuration contract must carry the following data. These are requirements for the later schema, **not currently supported CLI flags or a loadable example file**:

| Configuration data                              | Constraint                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Contract/schema version and repository identity | Explicit supported version and exact repository ID; reject unknown schemas                         |
| Release branch and baseline                     | One branch; recorded completed release or explicit bootstrap SHA/initial version                   |
| Version policy                                  | The reviewed table above, identified by revision; no PR-provided overrides                         |
| Output locations and version adapter            | Explicit repository-relative paths/fields with a bounded allowlist                                 |
| Automation identity                             | Expected GitHub App/bot IDs, same-repository head branch, base branch, and proposal marker version |
| Artifact destinations/access                    | Explicitly approved destinations and private-access requirements; disabled until configured        |

Capture the resolved configuration and its identity with baseline/source IDs, normalized and raw metadata, validation results, and tool/schema version. Offline replay uses only that snapshot and pinned policy; it does not re-fetch mutable PR bodies. Live refresh is an explicit collection operation creating a new proposal identity and requiring review again. Unknown schemas, missing evidence, or changed configuration fail rather than guessing compatibility.

### Release-PR identity, exclusion, and conflicts

- Use one stable same-repository branch, `release-log/main` for `main`, and a versioned machine-readable proposal marker tied to repository/base, baseline/source IDs, and snapshot/output digests. A title or label alone is not identity or authorization.
- Verify the configured App/bot numeric identity, head repository/branch, base branch, captured proposal, and recomputed exact generated diff together. Body markers and digests are untrusted claims until checked against trusted source/configuration. No blanket bot exemption.
- Generate the title `chore(release): prepare vX.Y.Z` and commits `chore: prepare vX.Y.Z`. A squash merge must use the unscoped commit subject, not copy the scoped PR title unchanged.
- Generated PRs supply the ordinary v1 block: `audience: internal`, a factual summary/impact of the proposal, and `required_action` directing review of version, changelog, and snapshot before merging. They must pass title/context checks; the marker is additional verification, not a bypass for missing context.
- Exclude a release PR from subsequent product membership only after verifying its identity and that its landed changes exactly match its approved generated outputs. A human PR named `chore(release)` is ordinary. Unexpected source changes in a purported release PR fail; they are never silently discarded as automation.
- Serialize by repository/release branch and compare expected remote branch/source state before updating. Older jobs must not overwrite newer proposals. Repeated events converge on the same PR, not append entries or create parallel proposals.
- Human edits, unrelated branch files, unexpected identity, or a manually closed/deleted proposal halt automatic updates and require explicit recovery. Do not force-rewrite a human branch or automatically reopen/recreate a deliberately closed proposal.
- A no-release plan creates no PR. If an existing proposal no longer matches current policy/state, report a conflict for review instead of silently closing it.

### Manual merge, automatic tag, and subsequent cycle

A proposal describes the full baseline-to-source range at source `S`. Any new main commit before its merge makes it stale, even if the text still looks plausible. Refresh from the new source and review the new proposal.

Tag the actual release landing `M`, not a later main HEAD:

- For a merge commit, require parents `S` and the generated proposal head, with the exact generated proposal tree.
- For a squash commit, require parent `S` and that same tree. Rebase merging of release PRs is deferred; ordinary PR rebase support does not imply release-PR rebase support.
- Reconstruct the generated proposal and verify its bot/repository/branch identity, captured inputs, output tree, and unchanged baseline. This requires no custom approval capture, receipt, or successful application-CI evidence; the human decides to release through normal PR review/manual merge.
- Later main changes after valid `M` remain for the next cycle. Tag exactly `M`; do not require current main to equal `M` or retarget the tag to catch up.
- A release-PR merge enters only the tag path, never proposal generation. Matching existing tags are no-ops; conflicting tags fail and are never moved.
- An ordinary merge while the merged release's version tag is absent stops with `release-tag-pending`. After tagging, the next ordinary merge starts a new cycle from that tag. Do not fall back to the old tag or bootstrap.

The tag establishes the release boundary. GitHub Release objects, image/asset publication, IaC, and deployment are downstream repository responsibilities, not completion gates for this workflow. App provisioning, live writes, CI-trigger changes, and branch-protection settings still require separate authorization.

### Events, credentials, and artifact access

| Boundary                    | Event/runtime                                                                                                         | Minimum intended access                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Ordinary metadata readiness | Dedicated metadata-only `pull_request_target` workflow on opened, synchronize, reopened, edited, and ready-for-review | Explicit `contents: read` and `pull-requests: read`; no secrets, write token, or App token        |
| Source quality checks       | Existing unprivileged `pull_request` workflow                                                                         | Read-only; no release credentials                                                                 |
| Collection/replay           | Explicit collection from trusted automation; offline replay separately                                                | Collection needs repository/PR reads; replay needs no credentials/network                         |
| Proposal mutation           | Trusted release-branch push; controller verifies captured source and current state                                    | Repository-limited, short-lived App installation token with contents/PR write; no packages write  |
| Release tagging             | Generated release PR manually merged; verify and tag its exact landing                                                | Repository-limited App installation token with contents write; no artifact/deployment permissions |

GitHub contents write also permits tag/Release mutations; the proposal token cannot be made PR-branch-only through that permission. Separate trusted entry points and code paths enforce the no-publication-on-ordinary-merge rule; do not describe it as permission-level isolation. Artifact upload credentials stay out of proposal jobs.

`pull_request_target` is safe here only as a metadata-data boundary: run trusted base-revision validator/workflow code, never check out or execute the PR head/merge, load its configuration, run its install scripts, or consume its caches/artifacts as code. Fetch current title/body/head identity as data, validate size/schema, pass through JSON/files or argument arrays, and fail outdated results rather than report stale metadata as current. Keep source-testing jobs separate. If those restrictions cannot be maintained, do not use this event.

The App token design allows tag writes to trigger repository-owned downstream workflows without relying on `GITHUB_TOKEN` event propagation. The release roll does not wait for application CI; this decision does not disable existing checks or alter required-check settings. GitHub's [triggering documentation](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow) currently documents approval-required runs for some token-created PR events and no automatic runs for others, including edits; validate actual behavior in an approved sandbox. Do not assume App installation or required checks already exist.

Pin external Actions and distributed CLI/images immutably. Disable checkout credential persistence; never log tokens or include them in snapshots, images, or generated files. Private repository/package visibility stays unchanged. Image consumers need explicitly tested GHCR pull authorization; neither an anonymous pull nor an available paid environment is assumed. Provisioning and publication remain separate from this decision.

## Worked acceptance examples

These are accepted expectations, not executed release-engine tests. Unless stated otherwise: the released baseline is `v1.2.3` at `B`; source is `S`; ordinary PRs target main, have valid scoped titles and v1 context with no required action; all landed changes have unique verified associations. `B` is an ancestor of `S`. Each included PR contributes its summary, impact, action, and PR link to the technical changelog.

| Case                        | Captured history/metadata                                                                      | Membership and version                                | Changelog / failure expectation                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Normal feature              | `B -> a -> S`; both commits belong to merged PR #101, `feat(exports): add selected rows`       | #101 once; `1.3.0`                                    | One `feat` entry under `exports`, not two commit entries                        |
| Patch                       | One merged #102, `fix(api): retain keys`                                                       | #102; `1.2.4`                                         | One `fix` entry                                                                 |
| Mixed batch                 | #101 feature, #102 fix, #103 `docs(api): explain keys`                                         | All three; `1.3.0`                                    | All three entries, including docs                                               |
| Breaking title              | #104 `feat(api)!: remove legacy keys`, action `Use the key option.`                            | #104; `2.0.0`                                         | Warning and action retained                                                     |
| Breaking commit conflict    | #105 title `fix(api): require keys`; associated commit `fix!: require keys`                    | No usable plan                                        | Require title `!` and action review; never release a patch                      |
| Breaking footer             | #105 title marked `!`; commit declares `BREAKING CHANGE: supply a key`; action present         | #105; `2.0.0`                                         | Preserve footer evidence as well as title                                       |
| Breaking without action     | #104 breaking title, `required_action: null`                                                   | No usable plan                                        | Context parser accepts null; readiness/planning rule rejects it                 |
| Pre-1.0                     | Baseline `0.4.7`; breaking #104                                                                | #104; `0.5.0`                                         | Breaking warning remains; no automatic `1.0.0`                                  |
| Pre-1.0 feature/fix         | Baseline `0.4.7`; #101 alone / #102 alone                                                      | `0.5.0` / `0.4.8`                                     | Same entries as at stable versions                                              |
| Internal feature            | #106 `feat(engine): cache plans`, audience internal                                            | #106; `1.3.0`                                         | Technical entry retained; optional user notes omit it                           |
| Docs/chore only             | #103 docs plus #107 `chore(tooling): update checks`, both internal                             | Both captured; no-release                             | No PR/tag; both included alongside a later releasable change                    |
| Breaking docs               | #108 `docs(api)!: remove legacy contract`, action present                                      | #108; `2.0.0`                                         | Type/audience cannot suppress a declared break                                  |
| Revert                      | #109 `revert(api): restore legacy keys`                                                        | #109; `1.2.4`                                         | Explicit revert entry; no inferred cancellation                                 |
| First release               | No release tag; explicit bootstrap `B`, initial `0.1.0`; #101 lands after `B`                  | #101; `0.1.0`                                         | No invented previous tag; not `0.2.0`                                           |
| First breaking release      | Same bootstrap; breaking #104 with action                                                      | #104; `0.1.0`                                         | Keep warning/action despite using the fixed initial version                     |
| Bootstrap unavailable       | No completed baseline and no explicit bootstrap, or missing historical context after bootstrap | No usable plan                                        | Ask owner to configure boundary or repair real context; do not fabricate it     |
| Merge history               | `B -> a -> b` on PR #110; merge `M` joins main, `M` reachable from `S`                         | #110 once; title governs bump                         | `M` is structural; `a`, `b`, and `M` accounted for, not parsed as three entries |
| Squash history              | PR #111's original `a`, `b` replaced by landed `q`, reachable from `S`                         | #111 once; title governs bump                         | Keep original/landing evidence; do not require `a`/`b` to be reachable          |
| Rebase history              | PR #112 rebased as `a'`, `b'` on main with verified mapping                                    | #112 once; title governs bump                         | Missing rewritten-commit mapping blocks, not guessed by date                    |
| Open or later-merged PR     | An out-of-range PR is associated with a shared commit                                          | PR excluded unless its landing is proved within range | Any remaining unexplained in-range commit blocks; no silent omission            |
| Direct/ambiguous commit     | In-range `x` has zero or multiple qualifying PR associations                                   | No usable plan                                        | Name commit/association problem; do not create a synthetic entry                |
| Empty/divergent range       | `B == S` / `B` not ancestor of `S`                                                             | No-release / no usable plan                           | Empty is valid; divergence is an error                                          |
| Verified release automation | Prior release PR matches identity and exact generated diff                                     | Exclude automation-only changes                       | No recursive release; ordinary changes after it remain                          |
| Spoofed/mixed automation    | Release-looking title/marker, wrong identity or unexpected source edit                         | No automation exemption                               | Ordinary metadata rules apply to human PRs; tampered automation fails           |
| Stale before merge          | Proposal captured `S`, ordinary change `T` lands before release merge `M`                      | Publication rejected                                  | First parent is not `S`; refresh and review                                     |
| New change after merge      | Approved fresh `M`, then ordinary change `T`                                                   | Publish only `M`; `T` belongs to next cycle           | Never tag later HEAD or drop `T`                                                |
| Release tag pending         | Release PR merged at `M`, version tag absent, ordinary change `T` lands                        | No new proposal until tag recovery                    | Report `release-tag-pending`; never reuse the old tag                           |
| Tag retry                   | Version tag already resolves to `M`; downstream image absent                                   | Tagging is complete; downstream work is separate      | Matching tag reused; tag at another commit fails, never moves                   |

## Original approval and implementation handoff

Owner approval covers:

1. Small controller rather than a release-please adapter, with the maintenance tradeoff above.
2. Explicit bootstrap SHA and initial `0.1.0`, strict association/history failures, and no automatic historical-context bypass.
3. PR-title classification, breaking-conflict/action rules, the bump table (including pre-1.0 and internal/no-release behavior), and initial Node version adapter.
4. Generated PR identity/context, conflict recovery, supported release-merge strategies, freshness rules, and the trusted metadata-only event/App credential model.

Reviewer/owner: `lhajoosten`. Decision: approve the draft without amendments on 2026-11-08. No tracker item is closed by this record; each implementation still needs its own acceptance evidence.

The original 2026-11-08 implementation handoff covered #14 metadata fixtures, #13/#15/#16/#17/#18 deterministic components, and #20/#22/#23 controller/freshness/publication work. That publication-oriented orchestration handoff is superseded by the 2026-11-14 [rolling-release workflow](release-workflow.md): implement the rolling PR, manual-merge tag path, tag-pending guard, and tag-bound next cycle. Artifact publication and custom approval/completion records are not release-roll acceptance gates. Historical component validation does not establish that the revised reusable workflow is deployed or live-tested.
