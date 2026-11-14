# Rolling release workflow

Status: **owner-approved scope, 2026-11-14; not deployed**. This decision replaces the broader host/completion/publication architecture proposed in [#52](https://github.com/lhajoosten/release-log/pull/52) and [#53](https://github.com/lhajoosten/release-log/pull/53), both closed as superseded. Those designs were not merged or adopted. The deterministic membership, versioning, context, and changelog rules in the [release policy](release-policy.md) remain in force; this document takes precedence for orchestration and release completion.

## Goal and boundary

A reusable GitHub Actions workflow calls the packaged `release-log` CLI to maintain one release PR. A human reviews and manually merges it. The workflow then creates the version tag automatically. That merge is the only intended manual release action once setup is complete.

Consumers own what happens after the tag: image publication, application packaging, IaC, or deployment. This repository may use the same template to release itself and trigger its own image build. The release roll does not coordinate those jobs or wait for their artifacts to declare a release boundary. Azure Pipelines support is a later caller of the same CLI, not a second release engine to build now.

## Lifecycle

| Event                                                                | Required behavior                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary PR merges into the configured release branch                | Capture its current main source, collect the complete range since the released version tag, and create or refresh the one pending release PR.                |
| Another ordinary PR merges while that release PR is open             | Regenerate the full pending release and append a non-force commit to the same release branch/PR. Identical inputs/output are a no-op.                        |
| Human merges the generated release PR                                | Do not invoke release rolling. Create `vMAJOR.MINOR.PATCH` at that exact release landing, never at a subsequently advanced main tip.                         |
| Ordinary PR merges after the release merge but before its tag exists | Stop with `release-tag-pending`. Do not reuse the old baseline or create another release PR. Recover by rerunning the tag step for the same release landing. |
| Matching version tag already exists                                  | Treat a tag resolving to the exact landing as successful retry; never create a duplicate or move it. A conflicting tag is an error.                          |
| Next ordinary PR merges after tagging completes                      | Start the next release PR from the new version tag.                                                                                                          |

The tag is the completed release boundary. It is not a GitHub Release object, artifact receipt, protected completion journal, or claim that a downstream deployment succeeded. Tag creation itself must not start a new release PR.

## Deterministic proposal contents

- Derive membership from Git reachability between the baseline and captured source, not dates or only the triggering PR. Preserve PR context and source links.
- Calculate the next version using the existing agreed bump policy. Update supported root `package.json` and/or static `pyproject.toml` version fields; preserve the existing adapter restrictions and do not run consumer build backends or lifecycle scripts.
- Create `CHANGELOG.md` initially. In later cycles, preserve released sections and regenerate only the owned pending section. Do not append duplicate entries on each refresh.
- Maintain one active same-repository release branch/PR. Preserve sequential proposal history with non-force ref updates; do not overwrite unexpected human changes or silently reopen deliberately closed PRs.
- Preserve the fixed bootstrap and onboarding SHAs in `release-log.config.json` for this repository's first release. Thereafter use the version tag for the current released manifest version. Do not move onboarding forward or fabricate a previous tag.

## Workflow and bot

Use a GitHub App installed only on participating repositories. Mint short-lived installation tokens at runtime with the contents/PR permissions needed for branch, PR, and tag operations. Contents write is not branch-limited by GitHub; do not describe the token as technically incapable of other repository writes. Keep the App private key in Actions secrets, never generated files or logs.

Identify a generated release PR by the configured bot, same repository and reserved head/base branches, and reconstructed generated proposal—not a title, label, bot author alone, or a broad version-file path filter. A release merge enters only the tag path; ordinary merges enter only the proposal path. Serialize both paths by repository/release branch. Recheck state so delayed jobs cannot overwrite a newer proposal or tag a later main commit.

The bot does not approve or merge its own release PR. Human review/manual merge uses the platform's normal PR process. Proposal generation does not depend on successful application CI, and generated release-only PRs do not need application build/test runs. Testing `release-log` itself remains necessary. This decision does not change existing CI triggers or branch-protection settings; any required-check/trigger adjustment must be reviewed separately rather than silently bypassed.

App-token tag writes can trigger downstream workflows; do not substitute the default `GITHUB_TOKEN` and assume its tag pushes start other workflows. Downstream jobs own their image/package/deployment permissions. No broad PAT, custom identity service, or artifact storage service is required for the release roll.

## Explicit non-goals

The release roll does not require custom approval capture, approval-policy check attestation, artifact receipts, a trusted publication host, GitHub Release/asset reconciliation, image publishing, protected completion records, or a deployment controller. Existing experimental approval/publication APIs may remain available, but are not prerequisites for this flow. Do not expand this work to finish or remove those APIs without a separate request.

## Implementation checkpoint

Existing components already implement Git/PR capture, snapshots, version calculation, Node/Python manifest updates, changelog generation, and first-pending-cycle proposal creation/refresh. The manual rehearsal remains read-only. The package is private at development version `0.0.0`; there is no published CLI/image identity to put in a consumer template yet.

The tag-only library/CLI is implemented separately from the old publication executor; it is not yet connected to an automatic trigger. Remaining work is explicit:

1. Integrate ordinary-merge/release-merge routing and current-version tag selection in a reusable workflow calling the packaged CLI.
2. Replace the proposal controller's blanket merged-history conflict with tag-bound next-cycle selection, including merge/squash history and retained or automatically deleted release branches, without force pushes or lost ordinary changes.
3. Apply `release-tag-pending` before collection/proposal writes. A missing expected tag is not permission to fall back to bootstrap or the previous release tag.
4. Wire App-token inputs and an opt-in repository caller. Provisioning, live proposal/tag writes, publication, and repository settings still need their separate execution approval; implementing source is not authorization to run it.

## Acceptance evidence to collect

Use real temporary Git repositories with only GitHub HTTP replaced to cover: first release creation, two ordinary merges updating one PR, deterministic no-op retries, manual merge and squash landings, exact-landing tag creation after later main movement, matching/conflicting tag retries, missing-tag blocking, and a subsequent release preserving prior changelog sections and including every new ordinary change. A release merge must produce no new release PR and require no custom approval receipt or CI-success evidence.

Then perform a separately authorized live rehearsal here. Fixture tests are not evidence of App installation, event propagation, required-check configuration, live tag creation, image publication, or consumer access. Container APK maintenance remains a separate existing CI blocker, not part of the release-roll architecture.
