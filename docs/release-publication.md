# Read-only publication reconciliation

`inspectReleasePublication()` (`release-log/publication`) and `inspect-publication` compare an approved release with existing GitHub/GHCR state. They return the missing publication actions without executing them. No workflow enables publication, and no tag, Release, asset or image is created by this command.

This is a prerequisite for [safe publication/retry work](https://github.com/lhajoosten/release-log/issues/23), not a publisher or completed-cycle authorization mechanism.

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

All requests are explicit reads. There are shared limits of 500 HTTP requests/five minutes, with lower component limits and per-read timeouts. Registry bodies are bounded to 4 MiB. Errors omit raw response bodies and credentials. The JSON result goes to stdout; there are no `--write` or `--dry-run` flags. Exit 0 means inspection succeeded, **not** that publication is complete: callers must inspect `complete` and `actions`.

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

`complete` describes observed state **relative to the independently trusted policy and receipt**. It is not a durable success flag, atomic lock, permission to publish or permission to advance the baseline. A saved result can become stale immediately. A future authorized executor/next-cycle consumer must recheck approval and publication state at execution time, serialize writers, and establish its own authenticated completion authority. Host integration, upload/push execution, trusted build-receipt production, OCI provenance/security checks and an explicitly approved end-to-end fault/retry rehearsal remain outstanding.
