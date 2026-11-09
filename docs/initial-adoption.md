# Initial adoption and the first release

A repository should not need to rewrite years of commits or edit old PR descriptions before adopting `release-log`. Initial adoption separates legacy history from changes made after the tool's rules were introduced. Git still determines membership; missing historical metadata is visible review work, not permission to omit changes or invent explanations.

## Choose the correct starting mode

- **No completed release:** explicitly select a bootstrap baseline and the initial `0.1.0` release. The first commit is a valid exclusive base. Its message is outside the changelog range, but its files remain part of the captured application tree.
- **An already released application:** select its actual completed `vMAJOR.MINOR.PATCH` tag and matching current manifest version. Use released mode; never reset an existing `1.2.3` application to `0.1.0` merely because it adopts this tool. If that release has no trustworthy recorded baseline, agree a migration boundary first instead of fabricating a completed tag.

The initial version is an explicit release decision, not a guess from historical `feat`/`fix` labels. Initial-adoption mode can propose `0.1.0` for maintenance-only/unstructured history or an application entirely contained in its first commit. File preparation still requires a supported, consistent manifest; this is not permission to downgrade an existing version.

## Record onboarding once

Keep a version 2 configuration on the trusted release branch, reviewed independently of generated proposal inputs:

```json
{
  "schemaVersion": 2,
  "repository": "example/project",
  "repositoryId": 17,
  "releaseBranch": "main",
  "releasePolicy": "release-policy-v1",
  "bootstrap": {
    "baselineSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "onboardingSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

The IDs above are illustrative; supply the real repository identity and full immutable commit IDs. `baselineSha` is the exclusive range base. `onboardingSha` is the fixed last commit whose reachable history may use legacy metadata handling. It must descend from the baseline and be an ancestor of every captured source used for that initial cycle.

Do **not** replace `onboardingSha` with the latest main SHA on each refresh. Every later main commit remains after onboarding even while the first release PR is open. Classification uses Git reachability, not author/merge dates. The cutoff is bound into configuration/snapshot/proposal identities; changing it conflicts with existing captured evidence rather than silently refreshing its authority.

For this repository, `release-log.config.json` records baseline `bb0033fb274e69a8aabad6a17d71f18ec9292f60` and onboarding `c28fe6faa4d516847fbc725e9186cc80ac8873af`, the source previously captured by the approved read-only rehearsal. This preserves the original first-commit base and all subsequent membership. It does not rewrite historical PRs. This repository additionally selects `changelog.verbosity: concise`; [verbosity](changelog.md#verbosity) is separate from the fixed history boundaries and never removes breaking warnings or available required actions. Changing that rendering setting requires fresh capture/review, not changing onboarding or replaying old captures against a different configuration.

## Legacy versus new changes

| Evidence                                            | Through the fixed onboarding SHA                                                                              | After onboarding / tagged cycles                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Valid structured PR metadata                        | Preserve normal typed entries and existing context                                                            | Require normal scoped-title/context/authored-message rules |
| Old PR missing current metadata                     | Keep real PR identity, original title and available valid context; retain readiness issues as review warnings | Fail validation; never reinterpret a bad new PR as legacy  |
| Unassociated commit with arbitrary or empty message | Retain SHA/parents/raw message, a historical source entry and warning                                         | Require verified merged-PR evidence                        |
| Unassociated manual merge                           | Keep complete graph evidence and a historical merge warning                                                   | Fail unexplained structural membership                     |
| Explicit breaking header/footer                     | Preserve parsed breaking explanations and available actions; flag missing metadata for review                 | Enforce normal breaking-title/action consistency           |

Historical entries have no fabricated PR number, conventional type, scope, audience, impact or required action. A valid old context block is preserved; an absent/invalid one remains unavailable. The technical changelog labels historical entries, links their actual sources, escapes untrusted text, and displays warning codes and breaking explanations. Raw evidence remains in the snapshot. This is a reviewed initial snapshot, not AI-generated release prose.

Legacy tolerance does not ignore failed API reads, malformed/ambiguous association evidence, incomplete Git history, invalid cutoff ancestry, unsupported manifests, conflicting versions, unsafe output paths or unverified release automation. Known PR landing footprints are still checked. These are actionable integrity/setup failures, not demands to modernize old prose. Existing collection/snapshot bounds still apply, including the current 1000-commit range limit; large initial histories require a reviewed operational approach rather than silently skipped history.

## Collect and preview

With a trusted record in `release-log.config.json`:

```sh
release-log collect --config release-log.config.json --repository . --source FULL_SOURCE_SHA --bootstrap-sha FULL_BASELINE_SHA
release-log plan --config release-log.config.json --snapshot inputs.json --initial-version 0.1.0
release-log render --config release-log.config.json --snapshot inputs.json --initial-version 0.1.0
release-log prepare --config release-log.config.json --snapshot inputs.json --initial-version 0.1.0 --repository . --dry-run
```

Save collection stdout as `inputs.json` in approved storage before running the offline commands. Only collection requires `GITHUB_TOKEN`; supply it through the environment, never configuration or arguments. The supplied baseline must match the fixed record. Initial collection without the version 2 record fails with a setup diagnostic instead of guessing a moving cutoff. Version 1 configuration remains supported for established releases and strict lower-level replay, but does not opt into legacy tolerance.

The manual [self-rehearsal](release-rehearsal.md) reads the checked-in configuration from its captured trusted checkout, verifies repository identity, and requires the bootstrap input to match the recorded baseline. There is no workflow input that silently advances onboarding. It uploads only the existing limited preview/evidence artifacts; historical titles and commit subjects can now appear there, so retain the same access/retention review for private consumers.

## Compatibility and validation

Snapshot/normalization and plan schemas are version **3**, adding typed historical entries, warning-bearing historical contributions and the pinned onboarding identity. Old captures need their original pinned tool or explicit recapture/review, never relabeling or automatic migration. Approval-record schema remains version 1; its configuration/snapshot/proposal digests bind the new policy as before.

Tests cover arbitrary/empty/maintenance history, first-commit-only applications, retained context/breaking explanations, real mixed old/new Git graphs, manual merges, strict new PRs/direct commits, moved/invalid cutoffs, tagged-release version preservation, Node/Python preparation, packed CLI execution and read-only rehearsal. Proposal refresh/merge/squash approval tests retain the same cutoff and reject a changed configuration. Fixtures replace external HTTP only where stated; a successful offline preview is not proof of a live publication.

This mode does not install an App, enable automatic proposal writes, change repository protection, capture authenticated human approval, publish a package/release or complete subsequent-cycle recovery. Those safety/operational gates remain separate. Review warnings before approving an initial release; a plan or digest is not publication authorization.
