# Rolling release workflow

Status: **owner-approved scope, 2026-11-14; successive self-use releases through v0.2.1 and GHCR pull/retry verified, 2026-11-16; controlled safety validation outstanding**. This decision replaces the broader host/completion/publication architecture proposed in [#52](https://github.com/lhajoosten/rolling-release/pull/52) and [#53](https://github.com/lhajoosten/rolling-release/pull/53), both closed as superseded. Those designs were not merged or adopted. The deterministic membership, versioning, context, and changelog rules in the [release policy](release-policy.md) remain in force; this document takes precedence for orchestration and release completion.

## Goal and boundary

A reusable GitHub Actions workflow calls the packaged `release-log` CLI to maintain one release PR. A human reviews and manually merges it. The workflow then creates the version tag automatically. That merge is the only intended manual release action once setup is complete.

Consumers own what happens after the tag: image publication, application packaging, IaC, or deployment. Release Log’s own [self-release workflow](container-release.md) verifies the human-merged proposal as an internal candidate and gates the stable tag, GitHub Release and GHCR publication together. Azure Pipelines support is a later caller of the same CLI, not a second release engine to build now.

## Lifecycle

| Event                                                                | Required behavior                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary PR merges into the configured release branch                | Capture its current main source, collect the complete range since the released version tag, and create or refresh the one pending release PR.                |
| Another ordinary PR merges while that release PR is open             | Regenerate the full pending release and append a non-force commit to the same release branch/PR. Identical inputs/output are a no-op.                        |
| Human merges the generated release PR                                | Do not invoke release rolling. Create `vMAJOR.MINOR.PATCH` at that exact release landing, never at a subsequently advanced main tip.                         |
| Ordinary PR merges after the release merge but before its tag exists | Stop with `release-tag-pending`. Do not reuse the old baseline or create another release PR. Recover by rerunning the tag step for the same release landing. |
| Matching version tag already exists                                  | Treat a tag resolving to the exact landing as successful retry; never create a duplicate or move it. A conflicting tag is an error.                          |
| Next ordinary PR merges after tagging completes                      | Start the next release PR from the new version tag.                                                                                                          |

For the reusable workflow, the tag is the completed release boundary. It is not a GitHub Release object, artifact receipt, protected completion journal, or claim that a downstream deployment succeeded. Tag creation itself must not start a new release PR.

## Deterministic proposal contents

- Derive membership from Git reachability between the baseline and captured source, not dates or only the triggering PR. Preserve PR context and source links.
- Calculate the next version using the existing agreed bump policy. Update the supported [Node, Python, and Cargo version files](cli.md#node-python-and-cargo-version-files) without executing consumer tooling.
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

Git/PR capture, snapshots, version calculation, Node, Python, and Cargo version updates, changelog generation, the recurring proposal controller, tag-bound cycle selector, tag-only command, and integrated `roll` CLI are implemented. The standalone manual rehearsal remains read-only. The root npm package remains private at `0.2.1`. The GHCR `v0.2.1` image has verified anonymous version/digest pulls, CLI execution and a retained-digest publication retry. No npm package or GitHub Release assets are distributed. AI-written release notes are unimplemented; no provider/model is configured.

`.github/workflows/rolling-release.yml` is reusable (`workflow_call`). Release Log initially enabled it through `.github/workflows/rolling-release-caller.yml` on merged PRs targeting `main`, with `write: true`. At that checkpoint both the reusable workflow and `tool-sha` pinned `e3f2d317370447f6608be17941ade53b099d8fd2`, the merged implementation and fixture-fix revision. Its [main-push Quality run](https://github.com/lhajoosten/rolling-release/actions/runs/43965439163), container-security run and documentation run passed before selection. The caller enables `selfUpgrade` and `githubRelease` and explicitly retains `8828be515345d761a7375b5c00b1beff0cfabaeb` for unrecorded legacy snapshots. The selected runner declares `0.2.1`; its version is independent of the consumer release version. Review the configuration, added App permissions and first bootstrap run as described below.

## Reusable workflow and callers

### Minimal consumer workflow

Use [the consumer caller template](https://github.com/lhajoosten/rolling-release/blob/main/examples/rolling-release.yml) with `consumer-release.yml@consumer-v1` once the provider has activated the protected branch. The release job passes the release branch, App ID, bot user ID, write toggle, and App key. Keep the caller's manual dispatch and merged-PR event filters and read permissions. The same resolved provider commit supplies configuration, preview, writer, and replay policy. Runs log the commit and release policy. Consumers opting into immutability can use the full SHA of a promoted revision. Changes to the default configuration identity belong on a new major reference unless existing captures continue to resolve identically.

Rolling Release binds repository name, numeric ID, and release branch to GitHub. It defaults to policy v2, required PR release context, GitHub Release publication, and a concise compact changelog. Store reviewed overrides in `.release-log/settings.json` on the default branch. The workflow reads it as Git data. It rejects unknown keys and provider-only modes. The file can contain any of these fields.

| Field                                    | Use                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap`                              | Fixed `baselineSha` (exclusive) and `onboardingSha` (inclusive) from reviewed initialization or the previous caller.                     |
| `releasePolicy`, `releaseBumps`          | Supported release policy and optional per-type bump overrides.                                                                           |
| `contextPolicy`                          | `required` or `optional`. Use `null` to preserve a migrated configuration that omitted the field and used the implicit required policy.  |
| `githubRelease`                          | Set `false` to omit GitHub Release publication from the effective configuration.                                                         |
| `changelog`                              | Override `verbosity` or `format` independently. Use `format: null` or `changelog: null` only to preserve a previously omitted field.     |
| `adoptedRelease`, `commitMessageRepairs` | Carry forward an existing reviewed adoption record or exact commit repair.                                                               |
| `priorConfigurations`                    | Up to eight complete, reviewed prior configurations for exact replay of an already tagged release after a policy or presentation change. |

Start with `RELEASE_LOG_WRITE_ENABLED=false`. A manual dispatch from the default branch previews the captured commit with the read-only Actions token. If no verified predecessor or fixed bootstrap exists, review the exact range in the initialization report and record its two SHAs under `bootstrap`. Rerun the preview before enabling writes. An established repository with verified Rolling Release proposals continues from its exact completed tag. For other release history, use the reviewed adoption or recovery procedure. A tag name or current HEAD by itself does not establish a starting point. A paused merge run uses a read-only App token. An eligible write run installs the needed reviewed producers before issuing a write token.

### One-time migration and recovery

1. Pause writes. Move reviewed bootstrap and override values from inline JSON to the settings file. Preserve the effective configuration byte for byte after parsing, including previously omitted fields. Keep the old caller SHA available during the first rehearsal.
2. Install the minimal caller as `.github/workflows/rolling-release-caller.yml` and remove the previous release caller in the same reviewed change. Use the [pre-merge metadata template](pr-readiness.md#consumer-setup-and-migration) on the same branch. Run the manual preview and verify an ordinary merge dry run. Rehearse a pending pre-upgrade proposal with the original policy and producer. If a historical producer is missing, ask Rolling Release to restore it upstream.
3. Enable writes after the dry runs agree. Preserve one release proposal and its human review. After it lands, confirm the tag points to that exact merge and the configured GitHub Release exists. Compatible provider updates then arrive through the same caller reference.

Finish a pending release under its captured settings before changing policy. To change settings between cycles, copy the effective configuration of the last tagged release into `priorConfigurations`. The writer accepts that record only for replay at the original exact tag and landing. A queued run detects changed settings before issuing a write token. For a pending release with changed settings, restore its reviewed settings and retry its original run. Do not move tags or replace evidence to recover.

Retry transient source installation or API failures from the same event. Bounded retries apply to temporary GET errors and reviewed producer fetches. For interrupted writes, inspect the proposal, tag and GitHub Release before a retry. The writer re-reads GitHub state and reconciles matching partial state. For a missing tag, rerun the original release merge or use the documented exact-landing recovery.

For a previous reusable workflow caller, generate the proposed settings from the reviewed YAML and compare them before adding the file. This helper verifies that the new settings resolve to the same configuration.

```sh
node scripts/migrate-consumer-release.ts /path/to/previous-caller.yml OWNER/REPO
```

### Provider promotion and rollback

The provider configures the initial `consumer-v1` branch and repository-scoped promotion App once. Configure rules so only the promotion App can advance `consumer-v1` and use separate rules without App bypass to disallow force pushes and deletion. Protect `rolling-release-producer/**` tags from updates and deletion and restrict tag creation to the promotion App. Use the `CONSUMER_PROMOTION_APP_ID` variable and `CONSUMER_PROMOTION_PRIVATE_KEY` secret in the provider repository. The promotion App needs Contents and Workflows write on this repository only because the protected ref advances through reviewed workflow file changes. Keep that credential separate from consumer release and PR-feedback credentials.

Before enabling promotion, exercise a candidate full SHA in a disposable repository using the minimal workflows. Verify initialization, a pending proposal made by the previous writer, an ordinary merge, replay, exact tag and GitHub Release, and a paused attempt. Also exercise the required metadata check on title-only edits, a fork PR, and the generated release proposal. Record the runs and the tested revision in [#180](https://github.com/lhajoosten/rolling-release/issues/180). Start the protected branch at that tested revision, then set `CONSUMER_PROMOTION_ENABLED=true` and rerun its main-push Quality run to record the first producer. Use the stable ref for consumers after that promotion succeeds.

A successful main-push Quality run automatically promotes the current tested main commit. The promotion records an immutable producer tag before advancing `consumer-v1` by fast-forward. A failed, stale, or unrelated run cannot promote. The writer uses the provider's checked-in catalog for supported historical producers that predate automation. Newly promoted producer revisions enter the catalog automatically through the protected producer tags. A proposal can identify the needed producer, but only the provider's record authorizes its checkout. There is no routine producer list or pin update in consumer repositories.

To contain a regression, pause promotion and release writes where needed. Restore the known-good implementation with a forward revert on main, preserving the ability to replay any proposal created by the regressed revision. Its immutable producer record remains available. Verify the revert and replay in the disposable repo, then re-enable promotion. Rerunning all jobs can resolve a moving ref again. Rerunning only failed jobs uses the originally resolved reusable workflow. Use a fresh run or rerun all jobs to pick up a promoted fix, and retain the original merge event for exact-landing recovery. [GitHub reusable workflow reruns](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs)

### Direct writer workflow

The reusable workflow requires a full tool SHA, trusted configuration JSON, release branch, expected numeric bot user ID, App ID and private-key secret. It checks out `lhajoosten/rolling-release` at that SHA, installs frozen tool dependencies without lifecycle scripts, builds/packs locally, and installs the tarball with only offline frozen production dependencies. This is a source-pinned packaged distribution, independent of registry publication of the private package. Review the tool revision, workflow and dependency lock together; use the same immutable SHA for the workflow and tool in the caller.

The workflow runs on GitHub-hosted `ubuntu-24.04` and needs network access to GitHub, pinned Node.js/pnpm downloads and the package registry for the initial frozen tool dependency installation. Other runners and platforms are not validated by this workflow. It does not pull the published container or a private artifact; private registry pull access remains unproven. The reusable workflow declares no `workflow_call` outputs: inspect the CLI result and failure diagnostics in the run logs rather than relying on job outputs. The CLI selects the baseline and source from trusted configuration and current Git/GitHub state, rather than accepting arbitrary caller-supplied source or baseline inputs.

Consumer history is checked out separately at the current configured release branch with complete tags, without persisted credentials. Consumer code, configuration files, dependencies and PR-head scripts are never executed. Configuration comes from the trusted caller input. The CLI reads Git objects and re-reads current GitHub state; if the source advances beyond the fetched objects, rerun with fresh history. Both routes share the repository/release-branch concurrency group with cancellation disabled. GitHub concurrency is not a durable event queue: pending ordinary jobs may be replaced safely because collection uses the complete current range, but a canceled tag event must be recovered by rerunning its original merge run (or explicit `tag-release` at its exact landing). The pending guard prevents duplicate proposals while it is missing.

After queueing and installation, pinned `actions/create-github-app-token` mints a short-lived token for the current repository (owner/repositories omitted intentionally, using the action's current-repository default), requesting contents/PR writes. It revokes the token at job completion. Only the routing step receives it through `RELEASE_LOG_APP_TOKEN`; no fallback to the default Actions token is allowed. The App key is passed only to the token action. The CLI cannot infer token provenance from an opaque token, so callers of the standalone command must supply an installation token explicitly.

GitHub documents [reusable input/secret forwarding](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) and [App-token event propagation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). Source/fixture checks alone cannot prove installation permissions, private consumer access, event delivery or downstream tag workflow behavior. The live evidence below establishes the exercised App-backed proposal/tag paths; the historical GHCR workflow has its own [publication/access/retry evidence](container-release.md#live-v0-2-1-publication), while broader consumer access still needs validation. No application CI or custom approval record gates ordinary consumer rolling, and existing CI triggers, hooks and protections are unchanged.

Recovery remains explicit: `release-tag-pending` identifies the merged PR and exact landing. Rerun that tag event or use `tag-release` with the same trusted config/bot and App token; never tag current HEAD, move a conflicting tag or advance the bootstrap boundary. A canceled/stale ordinary event can be rerun to collect current source. Partial branch/PR writes require inspecting state before retrying, as described in the proposal guide.

## Provider repository identity

The provider uses GitHub repository ID `1449550207`. Its self release and proposal replay checks validate that ID and the current provider slug. Historical snapshots retain the repository name and producer revision captured at creation. Replay compares the two approved provider names only for that repository ID, then verifies the original snapshot and generated files with the recorded producer.

The reusable workflow path must use the current GitHub repository slug. The GHCR image at `ghcr.io/lhajoosten/release-log` and the `release-log` CLI command are independent distribution names.

## First-time setup preflight

Run the preflight from a separate, clean checkout of the reviewed Release Log producer. Check out the full producer SHA that contains `preflight` and install its locked dependencies with `pnpm install --frozen-lockfile --ignore-scripts`. Use a full clone of the consumer with its release branch and tags fetched. Set `GITHUB_TOKEN` to a repository-scoped credential with Contents and Pull requests read access. Obtain the consumer's numeric repository ID from GitHub, for example with `gh api repos/OWNER/REPO --jq .id`.

```sh
node /path/to/release-log/src/cli.ts preflight \
  --repository /path/to/consumer --target OWNER/REPO --repository-id REPOSITORY_ID \
  --release-branch main --producer-sha REVIEWED_FULL_COMMIT_SHA --initial-version 0.1.0
```

The preflight captures the named local branch and checks that it still matches GitHub. Pass `--source FULL_SHA` to inspect an explicitly fetched tip, such as a remote-tracking ref resolved to a commit. It checks GitHub tags and the reserved proposal branch and PRs before suggesting an initial boundary. For a stable version tag, existing capture or reserved proposal, follow [established-release adoption](initial-adoption.md) or [release recovery](#operator-recovery-and-tool-updates). A source without commits needs a first commit with a supported static version manifest. A planning-only commit can serve as a baseline while candidate files are prepared.

- The **bootstrap baseline is exclusive**. Every commit reachable from the captured source but outside the baseline's history belongs to the range. The suggested baseline is the oldest first-parent commit. Review what it excludes and pass `--baseline-sha FULL_SHA` if your history requires a different complete boundary.
- The **onboarding cutoff is inclusive**. Commits in the range that are reachable from this SHA may use legacy evidence. Preflight proposes the earliest first-parent cutoff covering the commit-only evidence it found. Review the full included commit list, the exact commits with no qualifying PR, and PRs marked `legacy-eligible` or `strict`. A PR whose complete landing is outside the legacy window must meet current metadata and association checks. A cutoff that would include more history than intended needs review before it goes into the caller.
- If you supplied a cutoff and a later commit lacks PR evidence, the report identifies the commit and leaves the check blocked. Review any suggested range before rerunning with `--onboarding-sha FULL_SHA`. If a reviewed configuration already exists, supply it as `--config FILE` in place of the target, ID, branch and boundary options. This checks the recorded boundary without proposing an update. Use the existing review or recovery process for an established boundary.

Use `--candidate-sha FULL_SHA` to check the version files from a reviewed local commit that will be introduced by the setup PR. The report ties this check to that commit. GitHub history, App and proposal checks still use the captured release-branch tip. Fix missing or conflicting static manifests before activation. When a lockfile such as `uv.lock` is unsupported at the selected producer pin, choose a reviewed producer with the appropriate adapter or defer activation. The source check remains blocked until compatible files are present on the release branch.

When the range passes review, copy the report's `caller` YAML into `.github/workflows/rolling-release-caller.yml` in a normal setup PR. The caller pins both the reusable workflow and tool to the same SHA and sets `write: false`. Review the actual workflow and configuration in that PR. Give the setup PR ordinary release metadata so its landing can pass strict checks. Store `RELEASE_APP_ID` and `RELEASE_BOT_USER_ID` as repository variables and `RELEASE_APP_PRIVATE_KEY` as an Actions secret. Install the App on the consumer repository with Contents and Pull requests write granted.

After the setup PR lands, open **Actions → Rolling release caller → Run workflow** and choose the configured release branch. The workflow checks out the dispatch SHA as data and runs only the pinned producer. It checks App configuration, repository installation, permission grants and the bot account, then runs production proposal reconciliation with writes disabled. The token action requests tokens limited to the caller repository. If App checks fail, the fallback Actions read token can still verify history while the dry run stays unverified. [Pinned token action](https://github.com/actions/create-github-app-token/tree/fee1f7d63c2ff003460e3d139729b119787bc349)

A successful Actions run exits zero with `status: ready` and a passed `appDryRun`. Review the repository, branch, captured SHA, producer SHA, fixed range and input ID in the run log. The ID includes the configuration, source, version, producer and available App IDs. Rerun after changes to the source, caller inputs, producer or App settings. Local runs keep App findings unverified, and a passing candidate check alone gives no activation evidence. For blocked checks, use the remediation in the report and repeat the relevant stage. Keep `write: false` until a maintainer separately reviews and merges the one-line write activation in a PR. Manual dispatch remains read-only.

## Restart a consumer release series

Use this path for a reviewed restart at `0.1.0` after retiring a consumer's former releases. Keep the writer paused while preparing the reset. The repository's trusted caller owns the history start, legacy-metadata cutoff and reset evidence. The Rolling Release provider's own publication series keeps its existing boundary.

Add `freshSeries` to the consumer's schema-2 configuration and set `bootstrap.baselineSha` and `bootstrap.onboardingSha` to the reviewed start and cutoff. Remove any `adoptedRelease` boundary from the new caller configuration. Use the original configuration when replaying snapshots from the former series. Fill in the reset record from the reviewed repository state.

| Field                     | Required value                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | A new lowercase series ID with letters, digits and optional hyphens, up to 40 characters                                                                                                                                                                                        |
| `previousVersion`         | The stable version currently present in the source manifests and their supported lockfile mirrors                                                                                                                                                                               |
| `previousChangelogSha256` | The full lowercase SHA-256 of the source `CHANGELOG.md` bytes                                                                                                                                                                                                                   |
| `previousLandings`        | One record per old merged release proposal in the reset range. Use the old `release-log/<release-branch>` proposals. Each record contains `pullNumber`, `botUserId`, `headSha` and `landingSha`. All landings and their footprints must fall inside the reviewed legacy cutoff. |

Use a feature-capable producer with the pinned reusable writer and read-only preview. Keep any existing producer history in the consumer's configuration. The older pinned writer or preview image must be upgraded before a caller can supply the new fields.

The fresh series uses `release-log-series/<id>/<release-branch>`. It verifies that no stable version tag or visible GitHub Release remains before preparing the first online proposal and before creating its tag. The old proposal remains on its own branch. Close it as superseded through the reviewed consumer cutover so it cannot land after the cutoff. The controller leaves that PR and its branch untouched.

Rehearse with the scoped read-only workflow and review the captured commit set, excluded old release proposals, first changelog and version-file updates. The new proposal replaces the pinned old changelog and tracked snapshot and updates supported manifests and lockfile mirrors together. Prior bytes remain available in Git history. Merge only the reviewed proposal. Tag reconciliation verifies its exact landing, and the next cycle uses that tag as its baseline. Keep the series ID and reset record fixed in subsequent configuration.

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

The captured caller must still pin the executing producer, so stale queued runs cannot skip its retention. Self-upgrade candidates must contain the active producer, be the current main tip and a human-merged PR landing, and pass the latest main-push `.github/workflows/quality.yml` run for that SHA. The proposal path polls every 15 seconds for up to six minutes of waiting when the listing is empty or the latest run is queued or in progress. A change to the source or baseline stops the stale run. The next ordinary merge run collects the complete current range. Failed or inconsistent evidence and a polling timeout stop reconciliation before proposal writes. If Quality succeeds after the timeout, rerun the original merge workflow. The wait takes effect when a reviewed release updates the two caller pins to a revision containing it. The managed workflow edit changes only the reviewed producer SHA in the self-release caller. Historical proposals retain their two matching SHA scalars and remain verifiable with their original producer. Edited outputs and concurrent changes stop reconciliation.

### Reviewed bootstrap

The original `8828be515345d761a7375b5c00b1beff0cfabaeb` runtime cannot enable these fields itself. This repository bootstraps to the reviewed `e3f2d317370447f6608be17941ade53b099d8fd2` implementation with the explicit legacy verifier below. For an equivalent activation:

1. Choose its reviewed immutable implementation revision. In a separate reviewed caller-pin PR, set both existing pins to that same full SHA.
2. Add `"selfUpgrade":true` and, to publish GitHub Releases, `"githubRelease":true` to the trusted configuration JSON. Retain the current repository ID and bootstrap/onboarding SHAs.
3. Supply this trusted workflow input for the unrecorded legacy producer:

   ```yaml
   verification-runtimes: >-
     [{"sha":"8828be515345d761a7375b5c00b1beff0cfabaeb","legacy":true}]
   ```

4. Approve Actions read and Workflows write on the repository's App installation. The new workflow requests these only for self-upgrades, along with its existing Contents/PR write permissions. Keep the installation repository-limited.
5. Review a dry-run reconstruction of the existing proposal/history before live refresh. Once the bootstrap landing passes Quality, its merge event can refresh the same open release PR; rerun that event if it initially stopped on unfinished CI. Review its new version, enriched capture, changelog, producer identity and both pins before normal human merge.

The bootstrap updates only caller configuration and operations guidance. The controller refreshes the generated release PR after the bootstrap lands and passes Quality; preparation of this change does not edit the live proposal, create a tag or publish a release. The owner’s manually published `v0.2.1` is reused without editing its notes or latest selection. The App installation’s Actions-read and Workflows-write grants must be confirmed before the first activation run; its public metadata endpoint returned 404, so those grants were not independently audited.

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

The bootstrap rehearsal on 2026-11-16 repeated verification against the refreshed PR #83 at `11634a34b4327207fcfa5a7cb4160885d17c6c9e`, preserving its schema-3 `0.0.0` snapshot ID `d8aa470c0ff882e0774615ebafe2c0fa1aebfe529882bb675fe9e116eb6453b3`. The actual producer installer fetched and built the pinned legacy revision with frozen dependencies. GET-only GitHub access reconstructed the open proposal and all three completed release proposals (#62 / `v0.1.0`, #69 / `v0.2.0` and #73 / `v0.2.1`), verified the current `v0.2.1` cycle and existing GitHub Release, and admitted the chosen candidate’s human merge and successful main-push Quality evidence. Fresh collection of the six current ordinary PRs produced a local schema-5 preview with capture time, six contributor credits, section emojis and the comparison link. The rehearsal made 96 API reads and zero API writes; the eventual bootstrap PR itself is not part of that preview’s source range. Live activation and new release publication remain unexercised.

### Release publication and recovery

With `githubRelease: true`, the tag handler creates a published, non-prerelease GitHub Release after verifying the exact tag target. Notes come only from that tagged proposal's verified generated changelog section. The [GitHub API's `make_latest` field](https://docs.github.com/en/rest/releases/releases#create-a-release) selects latest; a delayed older release requests `false` when a newer stable release is already latest. Existing published stable releases are reused without changing human notes, titles, assets or latest selection. Drafts, prereleases and mismatched identities stop for review.

A release API failure leaves the correct version tag intact. Rerun the original merge event, or an authorized `tag-release --write` for the exact PR/landing, to create only the missing release. An uncertain successful POST is reconciled by reading the existing release on retry; it is never blindly repeated in the same execution. `github-release-pending` prevents an ordinary merge from starting a new cycle while that release is missing. Dry-runs report the pending release and make no writes.

GitHub Releases and self-upgrades have fixture coverage, including merge/squash landings, retries, older-event latest protection, conflicts, failures, producer transitions and approval/exclusion accounting. Live activation, automatic release publication, added App permissions and external latest-writer races have not been exercised. The [architecture decision](adr/0003-release-pr-self-upgrades.md) records the trust and recovery boundaries.

## Live evidence and remaining validation

The first live tag-only cycle completed on 2026-11-15:

- The controller created and refreshed the same [release PR #62](https://github.com/lhajoosten/rolling-release/pull/62), including the [refresh run after #65](https://github.com/lhajoosten/rolling-release/actions/runs/43713365848). Its final changes were limited to `.release-log/inputs.json`, `CHANGELOG.md`, and `package.json`.
- A human merged #62 at `53eaaf949d242b848108fed106a6809cadf74416`. The successful [tag run](https://github.com/lhajoosten/rolling-release/actions/runs/43713854142) created [v0.1.0](https://github.com/lhajoosten/rolling-release/tree/v0.1.0) at that exact landing.
- Landing [Quality/container checks](https://github.com/lhajoosten/rolling-release/actions/runs/43713853951), [container security](https://github.com/lhajoosten/rolling-release/actions/runs/43713853938), and [documentation](https://github.com/lhajoosten/rolling-release/actions/runs/43713853939) succeeded. These runs establish checks/builds, not published installable artifacts or downstream deployment.

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

[Lifecycle acceptance #25](https://github.com/lhajoosten/rolling-release/issues/25) was closed by the owner on 2026-11-16. Subsequent tag-baseline selection, released-section preservation, exact-landing tags and matching-tag retry are evidenced in the sandbox. This repository has completed the subsequent `v0.2.0` and `v0.2.1` cycles recorded below. Its docs-only #66 merge already yielded a successful [post-tag no-release run](https://github.com/lhajoosten/rolling-release/actions/runs/43742864400) from the v0.1.0 baseline; a nonbumping merge need not create a proposal.

Controlled stale-input and generated-content/body tamper rejection, identical proposal retry, closely spaced ordinary-event convergence, closed/deleted/orphan proposal states, and missing/conflicting-tag recovery remain outstanding live as applicable. Existing temporary-Git fixtures with GitHub HTTP replaced cover these guards but do not establish every live race, required-check setting, private consumer access or downstream behavior. Plan risky cases in a controlled sandbox and obtain specific authorization before live mutations, retries, merges or tag/fault exercises. Never move immutable tags or tamper with production history for a test.

### Subsequent self-use and downstream publication

| Release  | Source boundary and observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.2.0` | [Proposal run 43759113111, attempt 2](https://github.com/lhajoosten/rolling-release/actions/runs/43759113111/attempts/2) and subsequent refreshes maintained [PR #69](https://github.com/lhajoosten/rolling-release/pull/69). Its final snapshot starts at `v0.1.0` and contains only ordinary PRs #66, #67, #68, #70 and #71. The [tag run](https://github.com/lhajoosten/rolling-release/actions/runs/43761533860) tagged exact landing `f4738a3634edf97e2f5992f1091bb3a6a69e45f0`. |
| `v0.2.1` | [Proposal run 43928430510](https://github.com/lhajoosten/rolling-release/actions/runs/43928430510) created [PR #73](https://github.com/lhajoosten/rolling-release/pull/73) from the `v0.2.0` boundary with only ordinary PR #72. The [tag run](https://github.com/lhajoosten/rolling-release/actions/runs/43929431267) tagged exact landing `3c6a50e5192cf9fe110c9bcd2ffe2ed5854cf0be`.                                                                                               |

Inspection of the tagged snapshots confirms those boundaries and memberships; the `v0.1.0` rendered section remains byte for byte in both later changelogs. The `v0.2.0` App-created tag triggered container publication, which failed during installation before build/push. It remains unchanged. The subsequent `v0.2.1` image was published, anonymously pulled/run and retained on one authorized retry with the same digest and `reused: true`; see the [full publication evidence](container-release.md#live-v0-2-1-publication).

Published distribution and intentional partial-publication recovery belong to [publication #23](https://github.com/lhajoosten/rolling-release/issues/23), closed by the owner on 2026-11-16. The live matching-image retry does not prove intentional uncertain-write recovery or production conflict handling. After worker review, the owner requested closure of #14, #20, #21, #22, #23 and #24 on 2026-11-16. Their closure records distinguish delivered behavior from remaining unperformed live exercises and access audits; closure does not claim those checks passed. No GitHub Release/assets or npm publication is implied by GHCR distribution.

The owner closed [adoption #26](https://github.com/lhajoosten/rolling-release/issues/26) on 2026-11-16 after accepting the sandbox evidence for the adoption task. The owner reserved the independent consumer checkout for themselves. Independent consumer adoption remains unverified, and the controlled live exercises and private consumer access checks described above remain outstanding.

### Recover a release after an invalid generated proposal lands

For PR #83, review the corrected v0.3.0 changelog against the first-parent range after v0.2.1, including #87 and later fixes that will ship. The old captured inputs describe the rejected proposal only. Once the recovery PR passes its checks and lands, verify the exact release commit and its package version. Create a lightweight v0.3.0 tag at that reviewed commit and publish the corresponding stable GitHub Release. Inspect an existing tag before proceeding and stop on any mismatch.

In a separate reviewed caller update, pin both the reusable workflow and tool to the same immutable recovery implementation revision on main. Add `adoptedRelease` to the trusted caller configuration with `pullNumber: 83`, `headSha: 35363260d66053716354266d184b1b7bbec11f2a`, `landingSha: bb9bf88a467e32e9532521737b53464706052f15`, the reviewed `commitSha`, and `tag: "v0.3.0"`. Retain the producer runtime pins. The activation merge can be rerun once its main-push Quality check succeeds. Confirm that selection reports the adopted boundary and that the first proposal captures only commits after it. Refresh a stale generated proposal through the controller and rerun its checks.

Require the Quality `verify` check with strict up-to-date branch protection before relying on the proposal freshness safeguard. A main push does not rerun the check on an unchanged proposal head. Strict protection blocks that head until the controller refreshes it against the new base.
