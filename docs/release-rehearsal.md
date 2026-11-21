# Read-only self-release rehearsal

The manual **Read-only release rehearsal** workflow in `.github/workflows/release-rehearsal.yml` exercises the latest published stable CLI against this repository's captured main revision. It is an early planning rehearsal, not the complete publication lifecycle in [#25](https://github.com/lhajoosten/release-log/issues/25) or a general consumer CI integration completing [#24](https://github.com/lhajoosten/release-log/issues/24).

## Prerequisites and historical bootstrap runs

The workflow must be merged into main before it can be dispatched there. Review its source and prerequisites first:

1. An owner selects and records the exact release boundary. With no completed release, choose a full bootstrap commit SHA after reviewing intentionally excluded history; the initial version is explicitly `0.1.0`. Do not choose a moving branch or silently pick a convenient recent commit to hide invalid history.
2. Review the checked-in `release-log.config.json` and its fixed bootstrap/onboarding SHAs. Historical PR/commit metadata through onboarding becomes source-linked review warnings; do not rewrite old PRs merely to pass adoption. New changes after onboarding still require scoped titles, conventional commit metadata and the configured v1 context policy. Ambiguous/incomplete membership, failed reads and unverified automation still block the run.
3. Confirm artifact access/retention is acceptable. Preview artifacts contain release decisions and rendered summaries/impact/actions, which may still contain sensitive project information even without full raw PR bodies. GitHub Actions artifact storage/access rules apply; no visibility is changed by this workflow.
4. Confirm the main manifest matches the selected version mode. Bootstrap permits the current matching `0.0.0` placeholder or `0.1.0`; released mode requires the recorded stable tag and matching manifest version. Node/Python manifest and lockfile limitations are documented in the [CLI guide](cli.md).

The owner approved the initial commit `bb0033fb274e69a8aabad6a17d71f18ec9292f60` as this repository's exclusive bootstrap baseline on 2026-11-08. The first [live read-only run](https://github.com/lhajoosten/release-log/actions/runs/42493012564), targeting `57ce3e2be4a2c5e6280764abb1454c9754298c0f`, built/installed the CLI but stopped on unassociated commit `4d283a4`; it produced no preview artifacts and attempted no release. The [second run](https://github.com/lhajoosten/release-log/actions/runs/42512443149), at `c28fe6faa4d516847fbc725e9186cc80ac8873af`, progressed past that commit and stopped on PR #1 metadata. The owner then approved general [initial adoption](initial-adoption.md): keep that source as the fixed onboarding SHA and treat old metadata as warnings instead of backfilling PRs. Those earlier failures are historical evidence, not a successful plan or completed lifecycle.

## Dispatch inputs

Use Actions → **Read-only release rehearsal** → **Run workflow**, selecting **main**:

| Input             | Bootstrap                                         | Established release                         |
| ----------------- | ------------------------------------------------- | ------------------------------------------- |
| `baseline_mode`   | `bootstrap`                                       | `released`                                  |
| `baseline`        | Full SHA matching the checked-in bootstrap record | Recorded completed `vMAJOR.MINOR.PATCH` tag |
| `current_version` | Leave empty; initial is fixed `0.1.0`             | Version matching the tag, without `v`       |

The wrapper reads `release-log.config.json` from the captured checkout and checks its repository ID/name/main branch against trusted workflow identity. Bootstrap must use that file's recorded baseline and onboarding cutoff; no input silently advances onboarding. Released mode uses the supplied real tag/current version without resetting the application.

The workflow captures `github.sha` at dispatch, checks out that immutable revision with full history and persisted credentials disabled, and only runs for `refs/heads/main`. It does not fetch mutable main again during planning. A later main merge is a separate future rehearsal, not an implicit refresh of these inputs.

## What runs

1. Pull `ghcr.io/lhajoosten/release-log:latest` for Linux/amd64. Use the resulting local image ID for the whole rehearsal so every command runs the same CLI.
2. Run `collect` once with the explicit baseline and source, complete Git history mounted read-only, and the repository's read-only `GITHUB_TOKEN` permissions (`contents: read`, `pull-requests: read`).
3. Run offline `plan`, `render`, and `prepare --dry-run` without credentials or network access. Repeat plan and render and require byte-identical output.
4. Delete temporary raw snapshots and configuration. Upload only `plan.json`, `changelog.md`, and `evidence.json` for seven days.

The rehearsal leaves repository files and GitHub release state untouched. The self-publication workflow separately builds and verifies the exact candidate before publishing it. Every external Action is SHA-pinned, and runs serialize by branch without canceling an earlier rehearsal.

## Evidence, failure, and recovery

A successful run proves the chosen source range passed collection/readiness, installed-artifact execution, version/changelog generation, dry-run version-file preparation, and repeated offline replay for that run. A no-release batch succeeds with an explicit no-release preview; it does not advance a baseline or approve publication.

If collection fails, review the explicit boundary, historical metadata/association evidence, token read access, and documented resource limits. Repair legitimate metadata or configuration through review; do not bypass a failing PR or fabricate context. If manifest/generated-section checks fail, resolve version conflicts, unsupported dynamic/lockfile adapters, or human edits explicitly. An image pull failure stops the rehearsal. There is no remote mutation to roll back; a later dispatch creates independent evidence. Do not publish from this preview.

The earlier live runs above reached collection and failed before planning. They predate the general initial-adoption mode. Local tests use captured synthetic inputs and real offline CLI subprocesses (only collection replaced), verify no repository writes/temporary input retention, propagate failures and replay differences, verify safe diagnostics without leaking tokens/raw subprocess output, and inspect manual events, read permissions, trusted immutable checkout, and Action pins. Existing artifact smoke tests exercise the packed production installation. These checks are not a live GitHub API or full lifecycle proof.

The active [rolling workflow](release-workflow.md#live-evidence-and-remaining-validation) now has proposal/refresh, exact-tag and subsequent-cycle self-use evidence. The separate [GHCR publisher](container-release.md#live-v0-2-1-publication) has first publication, anonymous pull/run and matching-digest retry evidence. Those results do not turn this manual rehearsal into a release controller or prove intentional stale/tamper, uncertain-write, conflict or race recovery. Those controlled exercises remain separately authorized and unverified. The owner closed #25 and downstream #23 on 2026-11-16; that closure does not claim these unperformed exercises passed.
