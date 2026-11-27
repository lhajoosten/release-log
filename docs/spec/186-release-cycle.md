# Release cycle contract

One stable release covers the merged PRs reachable between an exclusive reviewed boundary and an inclusive source on main. Git ancestry establishes membership. GitHub supplies PR identities, titles, available author credits and an optional required action. Capture these inputs in the release proposal so subsequent title edits cannot change reviewed release notes. [Issue #186](https://github.com/lhajoosten/rolling-release/issues/186)

## Golden acceptance example

Repository `acme/widget` has a reviewed stable baseline `v1.2.3` at commit `B`; its existing changelog bytes are exactly the old section shown below. The release branch is `main`. Two related, individually squashed feature PRs, #41 and #42, land in that order, with complete verified stack and landing evidence; fix #43 lands next. Their captured titles, authors and action are:

| PR  | Captured title                       | Author  | Required action              |
| --- | ------------------------------------ | ------- | ---------------------------- |
| #41 | `feat(export): add CSV export`       | `alice` | absent                       |
| #42 | `feat(export): add column selection` | `bob`   | absent                       |
| #43 | `fix: retain export settings`        | `carol` | `Restart the export worker.` |

The history, rather than the order of GitHub API responses or merge dates, establishes membership. After #41 lands, preview reports #41, `1.3.0`, and the expected generated changes without remote writes; the writer creates one bot-owned `release/next` proposal with the same result. After #42 and #43 land, preview and writer agree on all three PRs, the same `1.3.0` and the complete refreshed file changes. The writer refreshes the same proposal. Each PR appears once as a primary entry; #43 is additionally referenced in Required actions. Repeat with the same captured inputs to assert byte-identical output and no unnecessary write. The feature bump wins over the patch. The changelog is UTF-8 with LF line endings and exactly one final LF; this code block is its complete expected file:

```markdown
# Changelog

## v1.3.0

### ✨ Features

- add CSV export ([#41](https://github.com/acme/widget/pull/41)) by [@alice](https://github.com/alice)
- add column selection ([#42](https://github.com/acme/widget/pull/42)) by [@bob](https://github.com/bob)

### 🐛 Fixes

- retain export settings ([#43](https://github.com/acme/widget/pull/43)) by [@carol](https://github.com/carol)

### 🛠️ Required actions

- Restart the export worker. ([#43](https://github.com/acme/widget/pull/43))

[Full changelog v1.2.3...v1.3.0](https://github.com/acme/widget/compare/v1.2.3...v1.3.0)

## v1.2.3

- Previously released text.
```

The old section and preamble must retain their original bytes during refresh. The footer uses the future tag, which becomes resolvable only after promotion; first releases have no comparison footer. Title description, action and author are literal untrusted text, escaped to prevent Markdown injection. This example fixes the specific punctuation, links, heading levels and spacing above as acceptance bytes; different presentation choices require revising the contract before implementation.

For a no-release range, start at the same baseline with only `docs: explain exports` and `chore: update checks` merged and verified. Both remain eligible for the next batch, but the outcome is no release, no next version and no new generated files or proposal/tag/publication writes. If a prior pending proposal becomes maintenance-only, it cannot authorize promotion; resolve that state explicitly rather than publishing or silently deleting it. When a feature follows, all three PRs appear once, grouped and ordered by PR number. For `fix: retain settings` alone the next version is `1.2.4`; for `feat!: remove old exports` it is `2.0.0`; at `0.4.7` the same breaking title gives `0.5.0`. The first release uses a reviewed boundary and version 0.1.0 and has no invented prior tag. Scope is optional. A title break overrides any nonbumping type.

### Shared workspace version and lock example

For the golden release, suppose the first consumer is a shared-version Cargo workspace with root `Cargo.toml` version `1.2.3`, members `crates/cli` and `crates/core` inheriting `version.workspace = true`, and `crates/cli` depending on the local core by path with `version = '^1.2.3'`. The generated change sets `[workspace.package] version = "1.3.0"`, the local dependency requirement to `'^1.3.0'`, and local `widget-cli` and `widget-core` package versions and local dependency references in `Cargo.lock` to `1.3.0`. Member inheritance and unrelated external package versions, checksums and resolutions remain unchanged, including an external registry package coincidentally named `widget-core` at `1.2.3`. A mismatched version, stale lock, or inability to establish ownership blocks all writes. Verify the prepared tree using a representative `cargo ... --locked` consistency check with controlled dependencies; no network or actual command result is claimed here.

The same product contract supports root and shared workspace versions for npm including lock mirrors, Bun, pnpm workspaces, static Python plus Poetry or uv locks, and single/shared Cargo including Cargo.lock. Relevant first-party references and lock entries must agree with the new version; unrelated resolutions remain unchanged. Each package manager needs a representative frozen/locked installation or equivalent consistency check. This Cargo example does not prove those other package managers or imply Cargo is the only first consumer.

## Writes and recovery

| Observation                                                                     | Expected effect                                                                                                         | Retry                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Missing, incomplete or competing PR ownership                                   | Report the commit and stop before writing refs.                                                                         | Recollect complete evidence.                                                    |
| An ordinary merge advances main                                                 | Refresh the same bot-owned proposal at its observed head, preserving historical changelog bytes.                        | Identical inputs yield the same files.                                          |
| Proposal changed unexpectedly or landing has a different source, tree or parent | Preserve refs and published outputs.                                                                                    | Require a refreshed and reviewed proposal.                                      |
| Release PR lands; main advances again                                           | Verify its recorded head, first parent and complete generated tree. Create the stable tag at the landing.               | An existing matching tag is reusable. A conflicting tag blocks publication.     |
| Versioned image exists; GitHub Release creation failed                          | Verify the retained image by digest and publish the missing reviewed notes.                                             | Existing matching outputs are reusable. A conflicting output blocks writes.     |
| Backfill is dispatched                                                          | Enumerate reachable stable tags and render their complete historical intervals newest first. Propose only CHANGELOG.md. | Identical content yields no change. Ambiguous input blocks the entire proposal. |

The pure planner distinguishes a pending batch from a release with a version and Markdown. Preview and proposal execution share these decisions. The controllers validate GitHub input and recheck mutable refs before writes. Human review applies to the proposed files and captured inputs. The release PR does not recursively trigger a proposal.

## Verification evidence

Legacy tests at revision `ffbff73` supplied the starting fixtures for release roll, GitHub association, release proposals, tagging and GitHub Release recovery. The replacement verification maps to these fixtures.

| Acceptance example                                                                                                                                                                                      | Executable fixture                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Stacked squashes, two ordinary merges before release, preview/write agreement, shared version update, changed titles after review, advanced main, immutable tag conflict, partial publication and retry | `tests/release-cycle.integration.test.ts`                                                                                            |
| No-release range, fixed SemVer mapping, literal notes, credits, golden bytes                                                                                                                            | `tests/core.test.ts`, `tests/fixtures/release-golden.md`                                                                             |
| Ambiguous landings, unsupported stack ancestry and paginated association evidence                                                                                                                       | `tests/github-association.integration.test.ts`                                                                                       |
| Version files and matching workspace or lock entries                                                                                                                                                    | `tests/version-files-new.test.ts`, `tests/cargo-version.test.ts`, `tests/python-workspace.test.ts`, `tests/poetry-workspace.test.ts` |
| Historical tag ordering, missing or inconsistent changelog, first release, blocked association and verified old release automation                                                                      | `tests/historical-changelog.integration.test.ts`, `tests/controller-history.test.ts`, `tests/legacy-release.integration.test.ts`     |
| Exact registry digest and interrupted first publication                                                                                                                                                 | `tests/image-registry.test.ts`                                                                                                       |

Real GitHub settings, package permissions and a live publication require a separate consumer rollout.
