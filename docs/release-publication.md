# Publication reconciliation and GitHub execution

`inspectReleasePublication()` (`release-log/publication`) and `inspect-publication` compare an approved release with existing GitHub/GHCR state. They return the missing publication actions without executing them. No workflow enables publication, and no tag, Release, asset or image is created by this command.

The separate `publishGitHubRelease()` / `publish-github` executor can perform the GitHub steps only with explicit `--write`. It defaults to dry-run, never pushes images, and has no enabled workflow. Both components are part of [publication/retry work](https://github.com/lhajoosten/release-log/issues/23), not a completed-cycle authorization mechanism or evidence of a live release.

## Trusted inputs

Use the original release configuration, independently protected [approval and approval policy](release-approval.md), an explicit publication policy, and a trusted build receipt. None may be taken from an untrusted proposal branch or accepted solely because its JSON schema is valid.

The host must authenticate and protect the publication policy and receipt outside proposal control. A receipt records expected build bytes at an approved commit; its hashes do not prove who built them or that they came from that commit. This module does not build artifacts, authenticate receipt producers, sign receipts, verify provenance, provision credentials or configure protected storage.

Publication policy schema 1:

```json
{
  "schemaVersion": 1,
  "assets": ["release-log.tgz"],
  "images": ["ghcr.io/example/project"]
}
```

Configure 1–100 artifacts in total. Asset names are bounded filenames without paths. Image names must explicitly identify lowercase GHCR owner/repository destinations, without tags or digests. Use empty arrays for unused artifact kinds. Duplicates and unknown fields are rejected; parsing sorts artifact names canonically.

The build receipt has exactly these fields:

| Field                    | Required value                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `schemaVersion`          | `1`                                                                                   |
| `approvalVerificationId` | Complete lowercase SHA-256 from fresh approval verification                           |
| `landingSha`             | Exact approved merge/squash landing commit ID                                         |
| `assets`                 | Objects with `name`, complete lowercase `sha256` and positive integer `size` in bytes |
| `images`                 | Objects with `name` and immutable `digest` in `sha256:` format                        |

The receipt must cover precisely the configured destinations. A receipt for another approval/landing, incomplete artifact coverage, duplicate names or unsupported fields fails. Hash the actual packaged asset bytes and the exact OCI root manifest/index bytes, not a reserialized JSON object or an image configuration ID.

## Command and credentials

```sh
release-log inspect-publication \
  --config release-config.json \
  --approval approved-release.json \
  --policy approval-policy.json \
  --publication-policy publication-policy.json \
  --receipt build-receipt.json \
  --repository .
```

`--policy` remains the approval policy. Git must have the immutable local history needed by approval verification. The command does not fetch it or change the worktree.

Supply `GITHUB_TOKEN` with GitHub.com repository/PR read access through the environment. If images are configured, also supply `GHCR_READ_TOKEN`: a separately minted, pull-scoped **registry bearer**, not a raw PAT or a `GITHUB_TOKEN` substituted automatically. Bearer minting/token exchange is not implemented. The GitHub credential is never forwarded to GHCR; registry requests go only to the configured `ghcr.io/v2/.../manifests/vVERSION` endpoint, without following redirects or authentication challenges. Asset-only policies require no registry token or registry requests.

All inspector requests are explicit reads. There are shared limits of 500 HTTP requests/five minutes, with lower component limits and per-read timeouts. Registry bodies are bounded to 4 MiB. Errors omit raw response bodies and credentials. The JSON result goes to stdout; there are no `--write` or `--dry-run` flags. Exit 0 means inspection succeeded, **not** that publication is complete: callers must inspect `complete` and `actions`.

## Matching existing state

The inspector freshly verifies approval before reading publication state, derives the version and deterministic notes from the approved landing's captured inputs, reads remote state twice, then freshly verifies approval again. A later ordinary main commit does not retarget publication away from the approved landing.

- **Tag:** `vVERSION` must resolve to the approved landing. Lightweight and annotated tags are supported, with bounded annotation peeling. A conflicting tag fails; it is never moved.
- **GitHub Release:** an existing Release needs its expected tag, exact version name/tag and deterministic notes, a valid numeric identity, boolean draft state and `prerelease: false`. Edited notes or an inconsistent Release fail rather than get overwritten. `target_commitish` is not used to retarget an existing tag.
- **Assets:** every existing asset must be expected, uploaded and uniquely identified, with the exact receipt size and GitHub-reported `sha256:` digest. The inspector constructs bounded asset-list requests locally rather than following response-supplied URLs. Missing assets produce actions; unexpected, unfinished or conflicting assets fail. Asset bytes are not downloaded or independently rehashed.
- **Images:** GET the version tag's root manifest/index, validate supported OCI/Docker schema-2 structure and bounded SHA-256 descriptors, hash the raw UTF-8 bytes and compare with the receipt and any `Docker-Content-Digest` header. Only HTTP 200 is accepted as present; HTTP 404 means missing. Authentication, rate-limit, redirect, partial-response and other HTTP failures do not mean success or absence.

Registry inspection checks **root manifest bytes**, not child manifests, blob pullability, image labels, signatures, provenance, vulnerability findings or private-access rollout. See the separate [container/security boundaries](container.md). HTTP fixtures test this contract; live GHCR bearer compatibility and publication have not been demonstrated.

## Actions, recovery and completion

The schema-1 result identifies its repository, exact landing/version/tag, approval verification, canonical policy/receipt digests, observed state and deterministic `inspectionId`. `mode` is always `read-only`. Actions are ordered:

1. `create-tag` at the approved landing, if absent.
2. `create-draft-release` with the deterministic notes digest, if absent.
3. `upload-asset` for each missing expected asset.
4. `publish-image` for each missing expected image tag/digest.
5. `publish-release` if the Release is absent or still draft.

A matching tag alone is not completion. A published Release missing artifacts still returns missing-artifact actions and `complete: false`. A fully matching published Release, tag, assets and image roots returns no actions and `complete: true`. Repeated unchanged observations produce identical output; changes between the two observations fail rather than returning a mixed-state plan.

After interruption or an uncertain network outcome, inspect remote state again. Reuse matching outputs; investigate conflicts and permission failures without deleting assets, moving tags or overwriting images. This command never retries writes because it performs none.

`complete` describes observed state **relative to the independently trusted policy and receipt**. It is not a durable success flag, atomic lock, permission to publish or permission to advance the baseline. A saved result can become stale immediately. The executor rechecks approval and publication state at execution time, but its host and any next-cycle consumer must serialize writers and establish authenticated completion authority. Host integration, image-push execution, trusted build-receipt production, OCI provenance/security checks and an explicitly approved end-to-end fault/retry rehearsal remain outstanding.

## Explicit GitHub executor

`publishGitHubRelease()` is exported from `release-log/publication`. Its request extends the inspector inputs with `assetDirectory` and an optional boolean `write` (default `false`). The command uses the same trusted configuration, approval, policy and receipt files:

```sh
release-log publish-github \
  --config release-config.json \
  --approval approved-release.json \
  --policy approval-policy.json \
  --publication-policy publication-policy.json \
  --receipt build-receipt.json \
  --repository . \
  --asset-directory ./approved-artifacts \
  --dry-run
```

Dry-run validates local artifacts and performs the inspector's online reads, returning `{ schemaVersion: 1, mode: "dry-run", performed: [], inspection }`. It performs no remote writes. `--write` and `--dry-run` are mutually exclusive. **Adding `--write` permits real tag/Release/asset mutations; obtain separate execution approval first.** No workflow invokes it automatically. Use pinned trusted code and independently authenticated/protected inputs, never untrusted PR code/configuration or arbitrary uploaded receipts. The implementation does not authenticate its host.

For writes, `GITHUB_TOKEN` needs repository-limited contents write plus the repository/PR reads needed for verification. Use the separately approved short-lived App credential model; no provisioning or credential exchange is implemented. Registry reads still use only the separate `GHCR_READ_TOKEN`. The executor never sends credentials to supplied upload URLs, follows redirects or grants registry write access.

### Local asset preflight

Provide every receipt asset at `assetDirectory/name`, including on retry. The directory and its parents must not be symlinks; assets must be ordinary files, not symlinks or special files. Asset filenames come only from the parsed trusted receipt. Extra local files are ignored, not uploaded. Even image-only policies require an explicit ordinary asset directory.

Before any HTTP request, read and hash all configured assets, checking exact size, SHA-256 and stable file metadata. Limits are **64 MiB per asset and 128 MiB total**. The verified bytes are held in memory and uploaded directly; changing/replacing a path later cannot substitute different bytes. No consumer install, pack/build command or lifecycle script runs. Use an isolated trusted directory: filesystem checks are not protection against a hostile host/filesystem, and hashes do not authenticate build provenance.

### Execution and retry

The executor re-runs full approval/publication inspection before the first mutation and after every successful write, using the resulting fresh state for the next step. Configured image roots must already match; a missing image blocks all initial GitHub writes. Build/push images only in a separate approved job using the exact approved landing/receipt. A later missing/changed image stops remaining writes; no image push is attempted here.

GitHub steps are limited to:

1. Create the missing lightweight `vVERSION` tag at the approved landing. Never update/delete a tag.
2. Create the missing **draft** Release with exact deterministic notes and landing. Disable generated notes; do not modify existing notes.
3. Upload only missing assets, using the fixed `https://uploads.github.com/repos/OWNER/REPO/releases/ID/assets` endpoint, verified in-memory bytes and receipt filenames. Check returned asset identity/size/digest, then freshly inspect it.
4. Publish the matching draft only when all configured artifacts match, by changing its draft state. Do not overwrite title, notes or artifacts. Requests explicitly use `make_latest: "false"`; promoting a release to GitHub's latest pointer is not part of this executor.

The result is `{ schemaVersion: 1, mode: "write", performed, inspection }`. `performed` lists writes confirmed during this invocation; it is not a durable journal. An already complete matching release returns no writes. A published Release missing an asset may be repaired by uploading that missing asset; immutable-release policies or permission failures stop rather than trigger deletion/overwrite.

Transport errors, rejected writes, malformed/oversized/interrupted responses, mismatching returned evidence or unconfirmed progress stop execution with an instruction to inspect remote state. There is **no automatic write retry**. A request can have succeeded despite a timeout or bad response. Run `inspect-publication`, investigate conflicts/unfinished assets, then explicitly rerun with the same trusted inputs and local artifacts. Fresh matching state is reused, without repeating confirmed uploads or tag/Release creation. No rollback/deletion is attempted. Raw bodies/tokens are omitted from results and diagnostics.

The execution budget is 2000 HTTP requests/fifteen minutes across inspections and writes, with each inspector's lower limits retained. JSON requests retain ten-second timeouts; asset uploads use sixty seconds and bounded 4 MiB response bodies. Large histories/artifact sets can hit these limits partway through: inspect and resume, never increase scope by bypassing verification.

### Host gates and race limitations

This is not an atomic transaction or a lock. GitHub does not provide a combined compare-and-swap for tag, Release metadata, assets and publication. The host must serialize publication jobs by repository/release branch, restrict concurrent edits, authenticate approval/build-receipt producers, and protect records independently of proposal control. Those host controls are not provided or proven by this CLI.

Fresh checks detect the tested state changes and prevent subsequent writes after a failed check. They cannot prevent a human/other writer editing a Release after the last read but before `draft: false`; a post-write failure may therefore detect an already published inconsistent Release. Stop, inspect and recover with the owner; do not describe post-write detection as prevention or blindly advance baseline.

Tests exercise real temporary Git and mocked GitHub/GHCR boundaries, including unknown write outcomes followed by fresh retries. Live GitHub upload/Release behavior, App permissions/event propagation, GHCR bearer compatibility, private pulls and a sandbox publication/retry rehearsal remain unverified. Implementing the executor is not permission to run it, publication readiness or completion of #23.
