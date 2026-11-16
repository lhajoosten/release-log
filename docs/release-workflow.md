# Rolling release workflow

Status: **owner-approved scope, 2026-11-14; successive self-use releases through v0.2.1 and GHCR pull/retry verified, 2026-11-16; controlled safety validation outstanding**. This decision replaces the broader host/completion/publication architecture proposed in [#52](https://github.com/lhajoosten/release-log/pull/52) and [#53](https://github.com/lhajoosten/release-log/pull/53), both closed as superseded. Those designs were not merged or adopted. The deterministic membership, versioning, context, and changelog rules in the [release policy](release-policy.md) remain in force; this document takes precedence for orchestration and release completion.

## Goal and boundary

A reusable GitHub Actions workflow calls the packaged `release-log` CLI to maintain one release PR. A human reviews and manually merges it. The workflow then creates the version tag automatically. That merge is the only intended manual release action once setup is complete.

Consumers own what happens after the tag: image publication, application packaging, IaC, or deployment. This repository uses the workflow to release itself and a separate [stable-tag container workflow](container-release.md) to publish its Linux/amd64 image to GHCR. The release roll does not coordinate those jobs or wait for their artifacts to declare a release boundary. Azure Pipelines support is a later caller of the same CLI, not a second release engine to build now.

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

The bot does not approve or merge its own release PR. Human review/manual merge uses the platform's normal PR process. Ordinary consumer proposal generation does not depend on successful application CI, and generated release-only PRs do not need application build/test runs. Testing `release-log` itself remains necessary. This decision does not change existing CI triggers or branch-protection settings; any required-check/trigger adjustment must be reviewed separately rather than silently bypassed.

App-token tag writes can trigger downstream workflows; do not substitute the default `GITHUB_TOKEN` and assume its tag pushes start other workflows. Downstream jobs own their image/package/deployment permissions. No broad PAT, custom identity service, or artifact storage service is required for the release roll.

## Explicit non-goals

The release roll does not require custom approval capture, approval-policy check attestation, artifact receipts, a trusted publication host, GitHub Release/asset reconciliation, image publishing, protected completion records, or a deployment controller. Existing experimental approval/publication APIs may remain available, but are not prerequisites for this flow. Do not expand this work to finish or remove those APIs without a separate request.

## Implementation checkpoint

Git/PR capture, snapshots, version calculation, Node/Python manifest updates, changelog generation, the recurring proposal controller, tag-bound cycle selector, tag-only command, and integrated `roll` CLI are implemented. The standalone manual rehearsal remains read-only. The root npm package remains private at `0.2.1`. The GHCR `v0.2.1` image has verified anonymous version/digest pulls, CLI execution and a retained-digest publication retry. No npm package or GitHub Release assets are distributed. AI-written release notes are unimplemented; no provider/model is configured.

`.github/workflows/rolling-release.yml` is reusable (`workflow_call`). This repository enables it through `.github/workflows/rolling-release-caller.yml` on merged PRs targeting `main`, with `write: true`. Both the reusable workflow and `tool-sha` pin `8828be515345d761a7375b5c00b1beff0cfabaeb`. That tool revision declares development version `0.0.0`; the runner builds that reviewed source rather than using the newer GHCR image. The runner tool version and the consumer version being released are independent. Review captured tool/configuration identities before deliberately upgrading the pin; the optional self-upgrade controller below remains inactive under this old pin.

## Reusable workflow and callers

`examples/rolling-release.yml` remains an inactive consumer template with `write: false`; it is distinct from this repository's live caller. For a new consumer, obtain setup/execution authorization, replace both `REVIEWED_FULL_COMMIT_SHA` placeholders with the same reviewed immutable tool/workflow revision containing `roll`, supply the consumer's agreed configuration and App setup, then copy the caller into `.github/workflows/`. This repository retains its fixed bootstrap and onboarding SHAs exactly; other consumers must supply their own agreed boundaries and repository identity.

The reusable workflow requires a full tool SHA, trusted configuration JSON, release branch, expected numeric bot user ID, App ID and private-key secret. It checks out `lhajoosten/release-log` at that SHA, installs frozen tool dependencies without lifecycle scripts, builds/packs locally, and installs the tarball with only offline frozen production dependencies. This is a source-pinned packaged distribution, independent of registry publication of the private package. Review the tool revision, workflow and dependency lock together; use the same immutable SHA for the workflow and tool in the caller.

The workflow runs on GitHub-hosted `ubuntu-24.04` and needs network access to GitHub, pinned Node.js/pnpm downloads and the package registry for the initial frozen tool dependency installation. Other runners and platforms are not validated by this workflow. It does not pull the published container or a private artifact; private registry pull access remains unproven. The reusable workflow declares no `workflow_call` outputs: inspect the CLI result and failure diagnostics in the run logs rather than relying on job outputs. The CLI selects the baseline and source from trusted configuration and current Git/GitHub state, rather than accepting arbitrary caller-supplied source or baseline inputs.

Consumer history is checked out separately at the current configured release branch with complete tags, without persisted credentials. Consumer code, configuration files, dependencies and PR-head scripts are never executed. Configuration comes from the trusted caller input. The CLI reads Git objects and re-reads current GitHub state; if the source advances beyond the fetched objects, rerun with fresh history. Both routes share the repository/release-branch concurrency group with cancellation disabled. GitHub concurrency is not a durable event queue: pending ordinary jobs may be replaced safely because collection uses the complete current range, but a canceled tag event must be recovered by rerunning its original merge run (or explicit `tag-release` at its exact landing). The pending guard prevents duplicate proposals while it is missing.

After queueing and installation, pinned `actions/create-github-app-token` mints a short-lived token for the current repository (owner/repositories omitted intentionally, using the action's current-repository default), requesting contents/PR writes. It revokes the token at job completion. Only the routing step receives it through `RELEASE_LOG_APP_TOKEN`; no fallback to the default Actions token is allowed. The App key is passed only to the token action. The CLI cannot infer token provenance from an opaque token, so callers of the standalone command must supply an installation token explicitly.

GitHub documents [reusable input/secret forwarding](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) and [App-token event propagation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). Source/fixture checks alone cannot prove installation permissions, private consumer access, event delivery or downstream tag workflow behavior. The live evidence below establishes the exercised App-backed proposal/tag paths; the separate GHCR workflow has its own [publication/access/retry evidence](container-release.md#live-v0-2-1-publication), while broader consumer access still needs validation. No application CI or custom approval record gates ordinary consumer rolling, and existing CI triggers, hooks and protections are unchanged.

Recovery remains explicit: `release-tag-pending` identifies the merged PR and exact landing. Rerun that tag event or use `tag-release` with the same trusted config/bot and App token; never tag current HEAD, move a conflicting tag or advance the bootstrap boundary. A canceled/stale ordinary event can be rerun to collect current source. Partial branch/PR writes require inspecting state before retrying, as described in the proposal guide.

## Operator recovery and tool updates

| Symptom                                                                                       | Next bounded action                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read, rate-limit or source/metadata freshness failure before writes                           | Inspect the failed boundary and current source, then explicitly rerun the original ordinary-merge run after the cause is resolved. It captures current source and the full release range again.                                |
| `release-tag-pending` or canceled release-merge job                                           | Inspect the merged release PR and tag ref. Rerun its original merge event so tagging verifies the same exact landing. A separately approved `tag-release --write` must use that reported PR/landing and trusted configuration. |
| Matching existing tag                                                                         | Retain it; successful reconciliation returns `unchanged`. Never move it to current main.                                                                                                                                       |
| Conflicting tag, generated-file/body edits, closed/deleted/orphan proposal or uncertain write | Stop and inspect refs, proposal identity, outputs and logs. The controller deliberately refuses automatic repair; agree recovery before deleting, reopening or changing anything.                                              |
| Container release failure after tagging                                                       | Follow [container recovery](container-release.md#failure-and-retry-recovery). A failed downstream image does not undo the Git release boundary.                                                                                |

Retain the run URL/attempt, triggering PR, captured source and baseline, proposal/landing identities and any generated evidence before retrying. Never insert credentials or raw private PR descriptions into public troubleshooting records.

For an approved tool upgrade, review the new immutable source, dependency lock and workflow together, then update the caller's workflow reference and `tool-sha` to the same full SHA in one reviewed PR. Check supported configuration fields and replay compatibility first: a changed tool version/normalizer can reject old captures. An active proposal or merged predecessor must remain verifiable; do not rewrite its snapshot IDs to force compatibility. Keep bootstrap/onboarding identities fixed. A rollback is another reviewed caller-pin change after checking compatibility with current proposal/tag state; it never rolls back release tags, images or generated history.

## Self-upgrades and GitHub Releases

The newer controller supports two explicit trusted configuration fields:

| Field                 | Behavior                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selfUpgrade: true`   | Only for this release-log repository and its numeric ID: include the two caller pins in the generated release PR and propose the captured reviewed source SHA. |
| `githubRelease: true` | After exact-landing tagging, publish the verified version's changelog section as a stable GitHub Release and request latest.                                   |

Omit a field to retain the previous behavior. Generic consumers can enable GitHub Releases; they cannot use their own source SHA as a release-log tool pin. Neither field changes version classification, release membership or AI requirements. Runner and consumer versions remain independent.

The captured caller must still pin the executing producer, so stale queued runs cannot skip its retention. Self-upgrade candidates must contain the active producer, be the current main tip and a human-merged PR landing, and pass the latest main-push `.github/workflows/quality.yml` run for that SHA. Pending/missing/failed Quality evidence stops before proposal writes. Rerun the original merge workflow after Quality succeeds. The managed workflow edit changes only the two matching full SHA scalars in `jobs.release`; it preserves all other caller bytes and participates in generated identity, tree/diff, approval and exclusion verification. Edited outputs and concurrent changes stop reconciliation.

### Reviewed bootstrap

The active `8828be515345d761a7375b5c00b1beff0cfabaeb` caller cannot enable these fields itself. Keep it unchanged while reviewing this implementation. After the implementation is merged and passes CI:

1. Choose its reviewed immutable implementation revision. In a separate reviewed caller-pin PR, set both existing pins to that same full SHA.
2. Add `"selfUpgrade":true` and, to publish GitHub Releases, `"githubRelease":true` to the trusted configuration JSON. Retain the current repository ID and bootstrap/onboarding SHAs.
3. Supply this trusted workflow input for the unrecorded legacy producer:

   ```yaml
   verification-runtimes: >-
     [{"sha":"8828be515345d761a7375b5c00b1beff0cfabaeb","legacy":true}]
   ```

4. Approve Actions read and Workflows write on the repository's App installation. The new workflow requests these only for self-upgrades, along with its existing Contents/PR write permissions. Keep the installation repository-limited.
5. Review a dry-run reconstruction of the existing proposal/history before live refresh. Once the bootstrap landing passes Quality, its merge event can refresh the same open release PR; rerun that event if it initially waited on unfinished CI. Review its new version, enriched capture, changelog, producer identity and both pins before normal human merge.

This implementation leaves the active caller pins and configuration unchanged. It creates no historical releases. The owner reported manually publishing `v0.2.1` as latest; an existing stable release is preserved by the new handler.

### Producer reconstruction

`verification-runtimes` contains only trusted full SHA/legacy pairs. The workflow fetches these exact release-log revisions, installs each frozen lock without lifecycle scripts, and builds before App token minting. In self-use it also retains predecessor runtimes from the caller pins embedded in reviewed tool checkouts. Explicit legacy pins terminate that bounded ancestry walk. Consumer checkouts and captured runtime strings never choose executable code. Retain these authorities across caller upgrades; an unknown producer or more than twenty retained producers stops for review.

For an explicitly trusted local installation, add `--producer-runtimes FILE` to proposal/tag/cycle/approval commands. The registry is executable configuration supplied independently from snapshots:

```json
{
  "activeSha": "REVIEWED_ACTIVE_FULL_SHA",
  "producers": [
    {
      "sha": "8828be515345d761a7375b5c00b1beff0cfabaeb",
      "directory": "/absolute/trusted/built/producer",
      "legacy": true
    }
  ]
}
```

The directory must contain the reviewed producer's `dist/src` modules, its own manifest/lock assets and its installed dependencies. The workflow installer anchors these directories to exact checkouts; local administrators must establish the same provenance before supplying a registry. Programmatic callers can use `loadProducerRuntimes` and `withProducerRuntimes` from `release-log/runtimes`. Ordinary offline snapshot replay remains strict; this mechanism reconstructs prior proposals without changing their snapshots, IDs, tool versions or normalized content.

An offline rehearsal on 2026-11-16 used the actual open PR #83 at `2e4513606c3eadc1f2f8514f6423732d28e4627e` and built its exact `8828be…` producer. Current replay rejected its `0.0.0` schema-3 runtime. Explicit producer reconstruction reproduced its original snapshot ID `2512665575106f1ab52e61d8ab21f7105ae746183b0c4256e443c4193e8fbd9d`, generated tree, commit ancestry/identity, full PR body and proposed `0.3.0` version without edits. This was read-only with synthetic HTTP over local Git objects; it did not refresh the live PR.

### Release publication and recovery

With `githubRelease: true`, the tag handler creates a published, non-prerelease GitHub Release after verifying the exact tag target. Notes come only from that tagged proposal's verified generated changelog section. The [GitHub API's `make_latest` field](https://docs.github.com/en/rest/releases/releases#create-a-release) selects latest; a delayed older release requests `false` when a newer stable release is already latest. Existing published stable releases are reused without changing human notes, titles, assets or latest selection. Drafts, prereleases and mismatched identities stop for review.

A release API failure leaves the correct version tag intact. Rerun the original merge event, or an authorized `tag-release --write` for the exact PR/landing, to create only the missing release. An uncertain successful POST is reconciled by reading the existing release on retry; it is never blindly repeated in the same execution. `github-release-pending` prevents an ordinary merge from starting a new cycle while that release is missing. Dry-runs report the pending release and make no writes.

GitHub Releases and self-upgrades have fixture coverage, including merge/squash landings, retries, older-event latest protection, conflicts, failures, producer transitions and approval/exclusion accounting. Live activation, automatic release publication, added App permissions and external latest-writer races have not been exercised. The [architecture decision](adr/0003-release-pr-self-upgrades.md) records the trust and recovery boundaries.

## Live evidence and remaining validation

The first live tag-only cycle completed on 2026-11-15:

- The controller created and refreshed the same [release PR #62](https://github.com/lhajoosten/release-log/pull/62), including the [refresh run after #65](https://github.com/lhajoosten/release-log/actions/runs/43713365848). Its final changes were limited to `.release-log/inputs.json`, `CHANGELOG.md`, and `package.json`.
- A human merged #62 at `53eaaf949d242b848108fed106a6809cadf74416`. The successful [tag run](https://github.com/lhajoosten/release-log/actions/runs/43713854142) created [v0.1.0](https://github.com/lhajoosten/release-log/tree/v0.1.0) at that exact landing.
- Landing [Quality/container checks](https://github.com/lhajoosten/release-log/actions/runs/43713853951), [container security](https://github.com/lhajoosten/release-log/actions/runs/43713853938), and [documentation](https://github.com/lhajoosten/release-log/actions/runs/43713853939) succeeded. These runs establish checks/builds, not published installable artifacts or downstream deployment.

A private validation sandbox exercised two successive releases with the same pinned tool/workflow revision. Sandbox links below require repository access; these are synthetic fixture changes, distinct from production self-use.

| Exercised behavior                                 | Observed evidence                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create and refresh one proposal                    | [Creation run](https://github.com/lhajoosten/release-log-sandbox/actions/runs/43746947032) opened sandbox #4; [refresh run](https://github.com/lhajoosten/release-log-sandbox/actions/runs/43747690450) refreshed that same PR after ordinary docs #5. Its commit retained the previous proposal head as a parent.   |
| First exact-landing tag                            | [Tag run](https://github.com/lhajoosten/release-log-sandbox/actions/runs/43748004228) created sandbox v0.1.0 at #4 merge `56ef1120e8c0e5aa7c3035e8e68877ca25e76316`. No recursive proposal appeared.                                                                                                                 |
| Subsequent tag-bound proposal                      | After ordinary feature #6, [run 43748615373, attempt 2](https://github.com/lhajoosten/release-log-sandbox/actions/runs/43748615373/attempts/2) created sandbox #7 for v0.2.0 from the v0.1.0 tag, not bootstrap. Its snapshot included only new ordinary #6, with no bootstrap/historical contributions.             |
| Preserve released content and deterministic output | Exact pinned-code replay reproduced #7's canonical snapshot, three generated files and full proposal body. The rendered v0.1.0 section was preserved byte for byte below the new pending block; old entries were absent from new membership.                                                                         |
| Subsequent exact-landing tag                       | [Tag run, attempt 1](https://github.com/lhajoosten/release-log-sandbox/actions/runs/43749211459/attempts/1) created v0.2.0 at #7 merge `78281740041bc9aaf58af4702139032ae2bd3dcf`. Tagged files exactly matched the reviewed proposal. v0.1.0 remained unchanged and no recursive proposal appeared.                 |
| Matching-tag retry is a no-op                      | One explicitly authorized [retry, attempt 2](https://github.com/lhajoosten/release-log-sandbox/actions/runs/43749211459/attempts/2), job `132920868519`, succeeded with `write/tag/unchanged`. Both tag refs and all three tagged generated files were unchanged; no proposal appeared. App token cleanup succeeded. |

The subsequent ordinary-event run initially failed closed with `PR #6 metadata changed during collection; retry explicitly rather than mixing snapshots.` One authorized retry succeeded from fresh capture. The changed field/cause was not established; this incidental failure/recovery is separate from the matching-tag no-op above and does not establish intentional race/fault coverage.

[Lifecycle acceptance #25](https://github.com/lhajoosten/release-log/issues/25) was closed by the owner on 2026-11-16. Subsequent tag-baseline selection, released-section preservation, exact-landing tags and matching-tag retry are evidenced in the sandbox. This repository has completed the subsequent `v0.2.0` and `v0.2.1` cycles recorded below. Its docs-only #66 merge already yielded a successful [post-tag no-release run](https://github.com/lhajoosten/release-log/actions/runs/43742864400) from the v0.1.0 baseline; a nonbumping merge need not create a proposal.

Controlled stale-input and generated-content/body tamper rejection, identical proposal retry, closely spaced ordinary-event convergence, closed/deleted/orphan proposal states, and missing/conflicting-tag recovery remain outstanding live as applicable. Existing temporary-Git fixtures with GitHub HTTP replaced cover these guards but do not establish every live race, required-check setting, private consumer access or downstream behavior. Plan risky cases in a controlled sandbox and obtain specific authorization before live mutations, retries, merges or tag/fault exercises. Never move immutable tags or tamper with production history for a test.

### Subsequent self-use and downstream publication

| Release  | Source boundary and observed result                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.2.0` | [Proposal run 43759113111, attempt 2](https://github.com/lhajoosten/release-log/actions/runs/43759113111/attempts/2) and subsequent refreshes maintained [PR #69](https://github.com/lhajoosten/release-log/pull/69). Its final snapshot starts at `v0.1.0` and contains only ordinary PRs #66, #67, #68, #70 and #71. The [tag run](https://github.com/lhajoosten/release-log/actions/runs/43761533860) tagged exact landing `f4738a3634edf97e2f5992f1091bb3a6a69e45f0`. |
| `v0.2.1` | [Proposal run 43928430510](https://github.com/lhajoosten/release-log/actions/runs/43928430510) created [PR #73](https://github.com/lhajoosten/release-log/pull/73) from the `v0.2.0` boundary with only ordinary PR #72. The [tag run](https://github.com/lhajoosten/release-log/actions/runs/43929431267) tagged exact landing `3c6a50e5192cf9fe110c9bcd2ffe2ed5854cf0be`.                                                                                               |

Inspection of the tagged snapshots confirms those boundaries and memberships; the `v0.1.0` rendered section remains byte for byte in both later changelogs. The `v0.2.0` App-created tag triggered container publication, which failed during installation before build/push. It remains unchanged. The subsequent `v0.2.1` image was published, anonymously pulled/run and retained on one authorized retry with the same digest and `reused: true`; see the [full publication evidence](container-release.md#live-v0-2-1-publication).

Published distribution and intentional partial-publication recovery belong to [publication #23](https://github.com/lhajoosten/release-log/issues/23), closed by the owner on 2026-11-16. The live matching-image retry does not prove intentional uncertain-write recovery or production conflict handling. Validation in a second approved repository remains separate under [adoption #26](https://github.com/lhajoosten/release-log/issues/26). After worker review, the owner requested closure of #14, #20, #21, #22, #23 and #24 on 2026-11-16. Their closure records distinguish delivered behavior from remaining unperformed live exercises and access audits; closure does not claim those checks passed. #26 remains open and deferred. No GitHub Release/assets or npm publication is implied by GHCR distribution.
