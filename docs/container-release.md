# Stable-tag container publication

The [accepted distribution contract](adr/0001-container-distribution.md) selects GHCR at `ghcr.io/lhajoosten/release-log`, public anonymous pulls, Linux/amd64, canonical `vMAJOR.MINOR.PATCH` image tags and digest references. The updated publisher also maintains a mutable `latest` alias for convenient pulls, with the exact manifest digest of the highest successfully published stable version. The first successful publication is `v0.2.1`; anonymous version/digest pulls and CLI execution were verified on 2026-11-16. See the [live publication evidence](#live-v0-2-1-publication). npm publication and the package manifest's `private` flag are independent of GHCR visibility.

## Trigger and source

`.github/workflows/container-release.yml` reacts separately to creation of stable version tags. It ignores deletions and updates to existing tags. GitHub's tag glob narrows candidates; the script enforces canonical stable syntax, including no leading zeroes or prereleases. Checkout uses the event SHA, with complete tag history and no persisted checkout credential. The checked-out HEAD, peeled tag commit and event SHA must agree, and `package.json` must match the tag without its `v`. The image version comes from the packaged manifest; OCI revision records the checked-out commit and OCI source links the repository. No branch head, merge date, proposal receipt or release executor selects the source.

The workflow must exist in the tagged source. It does not backfill historical tags lacking the workflow. Rerun the original tag event for recovery; there is deliberately no manual dispatch accepting a branch or arbitrary source. Retagging, tag deletion and force pushing are not recovery mechanisms.

The live rolling caller selects the reviewed workflow/CLI revision described in the [rolling-release guide](release-workflow.md#implementation-checkpoint). That workflow mints a repository-scoped App installation token, passes it as `RELEASE_LOG_APP_TOKEN`, and the `roll` command uses that token for the `POST /git/refs` tag creation. There is no `GITHUB_TOKEN` fallback. GitHub documents that [App installation-token events can trigger workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), unlike ordinary `GITHUB_TOKEN` pushes. The App-created `v0.2.0` tag has now triggered the downstream workflow; see the bootstrap result below. The subsequent `v0.2.1` publication and anonymous pulls succeeded; see the live evidence below.

## Gates, credentials and evidence

The workflow installs locked dependencies with `pnpm install --frozen-lockfile --ignore-scripts` before running any pnpm script, including tag validation. pnpm 12 can implicitly install dependencies before a script, so validating first could attempt dependency lifecycle builds and leave an ignored-build failure for the subsequent explicit install. Keep the explicit scripts-disabled install first; no dependency build approvals or relaxed build policy are needed.

Root commands are the shared interface:

```sh
pnpm container:build --tag release-log-candidate:release
pnpm check:container --image release-log-candidate:release
mkdir -p reports/container-release
pnpm container:scan --image release-log-candidate:release --output reports/container-release/candidate-scan
```

`check:container --image` exercises an existing local image without building or deleting it. The default command still builds and removes its own temporary image. Tests cover actual offline CLI planning/rendering, Git inspection, Node/Python writes, mount/UID boundaries, denied writes and failure exit codes. The scan saves and inventories that local image, applies the existing High/Critical/Unknown policy (including unfixed findings), and records both the local image ID and the config digest extracted from that exact Docker archive. Local IDs can name a config, platform manifest or index depending on Docker storage. Publication checks that scan evidence names the exact candidate ID and that the pushed registry config matches the archive config digest. See [runtime and build details](container.md) and [scan policy](container-security.md).

Only the final publication step receives `GHCR_TOKEN` and `GHCR_ACTOR`. It exchanges the job token for a scoped GHCR bearer token and writes Docker authentication into a mode-0600 temporary config removed in `finally`. Build inputs never include these credentials. Child smoke/scan processes receive an explicit environment without the publishing token or Docker authentication. Package write permission is job scoped because Actions permissions cannot be assigned per step; the token is explicitly supplied only to publication. Actions are SHA pinned and checkout credentials are not persisted. No PAT or OIDC permission is required for publishing from this repository.

The workflow uploads `reports/container-release/` for 90 days even on failure. It includes scanner/database identity, inventory, findings, local image ID and archive config digest; successful reconciliation also writes `publication.json` and the run summary with the version reference, registry manifest digest, config ID, source commit, platform and reuse status. Download and preserve that evidence for durable release records; workflow artifacts are not permanent registry attestations. OCI labels are not cryptographic provenance.

## Pull and run

After an authorized first push, GHCR initially defaults the package to private. Public visibility must be selected separately in package settings, with approval. Public container packages [allow anonymous access](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry). For a private package, operators need a classic PAT with `read:packages` and package access, or an Actions `GITHUB_TOKEN` for a repository granted package access. Supply tokens through standard input to `docker login`, using a temporary Docker config; never put them in image build arguments.

The verified `v0.2.1` release can be pulled without logging in. To reproduce with empty Docker authentication:

```sh
docker_config=$(mktemp -d)
trap 'rm -rf "$docker_config"' EXIT
export DOCKER_CONFIG="$docker_config"

docker pull --platform linux/amd64 ghcr.io/lhajoosten/release-log:v0.2.1
docker pull --platform linux/amd64 ghcr.io/lhajoosten/release-log@sha256:1f0ba94d9a78c183942460179721c565f2698cc8523a5f9e868330578ff47c7f
docker run --rm --network none --read-only --cap-drop ALL \
  ghcr.io/lhajoosten/release-log@sha256:1f0ba94d9a78c183942460179721c565f2698cc8523a5f9e868330578ff47c7f --version
docker run --rm --network none --read-only --cap-drop ALL \
  ghcr.io/lhajoosten/release-log@sha256:1f0ba94d9a78c183942460179721c565f2698cc8523a5f9e868330578ff47c7f --help
```

Use the digest form in automation. The [runtime guide](container.md#run-with-mounted-inputs) explains read-only input mounts, host UID/GID and explicit writes; replace its local image reference with the published digest. No arm64 support or emulation validation is claimed.

## Latest image alias

On the next stable release containing this implementation, pull the convenient alias with:

```sh
docker pull ghcr.io/lhajoosten/release-log:latest
```

The publisher first completes the existing exact-source, smoke, scan, version-image and digest checks. It then copies the verified manifest bytes to `latest` through the [registry manifest API](https://distribution.github.io/distribution/spec/api/#put-manifest), preserving its digest without rebuilding or creating an index. The resulting alias is read back and recorded in `publication.json` and the run summary.

Equal-version alias conflicts fail rather than overwriting ambiguous state. A newer existing stable alias is retained when an older event arrives late. All versions share one workflow concurrency group; independent external writers remain outside that serialization guarantee. If alias promotion fails after version publication, the version remains intact. Retry reuses, tests and scans that version by digest, then repairs only the alias as needed. No major/minor aliases, prereleases or additional platforms are introduced.

The `latest` path has controlled registry-fixture coverage; its first live push/pull remains pending the next authorized tagged publication. Digest references remain the reproducible choice for automation. Historical tags run their original workflow code and do not acquire this feature by rerunning an older event.

## Failure and retry recovery

Registry reads fail closed on authentication/authorization errors, rate limits, outages, malformed metadata, unexpected redirects and digest mismatches. Only a registry `MANIFEST_UNKNOWN` or `NAME_UNKNOWN` 404 means the version is absent. Registry manifest and config bytes must match their SHA-256 identities. Multi-platform indexes and mismatched version/platform/source metadata are rejected.

For an absent version, tag and push the already verified local candidate ID. Docker API 1.46+ is required: [`docker push --platform linux/amd64`](https://docs.docker.com/reference/cli/docker/image/push/) publishes only the platform manifest, excluding builder indexes and attestations. Recheck absence immediately before writing. Check the resulting registry config against the scanned archive config digest and record the manifest digest. If the push succeeded but acknowledgement or artifact upload failed, rerunning the original event finds the existing image. A matching version/source/platform is pulled by digest and reruns smoke and current vulnerability checks before being recorded as retained. It is never pushed again. A conflict stops without a write; inspect its provenance and package access, then use a separately reviewed new release or recovery decision. Do not delete/reassign a published version to get a green run.

Workflow concurrency serializes all version and latest writers and does not cancel an in-progress push. All release-tag writers must use this workflow; out-of-band concurrent writes cannot be made atomic with GHCR. No registry-side immutability guarantee is claimed. The original event and pinned inputs must remain available for reruns. Candidate preparation also runs on retries, so retired upstream build inputs or a current scan failure can block recovery; do not bypass the gate or substitute updated source under an existing Git tag. A scanner download/database outage is retryable after service recovery. New vulnerabilities require review and generally a new patched release.

## Approved live verification procedure

Publication and anonymous pull/run checks have passed for `v0.2.1`; the authorized same-event retry also retained the digest with `reused: true` and no push. The live evidence below records the exact scope. Obtain authorization for commits/push/PR and the first publication before making this workflow reachable by a new stable tag. Package visibility/access changes require explicit authorization too.

1. Review and land the implementation through the normal PR process, then let the human-merged rolling release create the next stable tag containing it. Do not recreate historical tags. Capture the App-created tag ref, exact commit, rolling run and independent Container release run URLs. Confirm `latest` has the same digest as the version tag, unless a newer stable version is already latest. No major/minor aliases or image-publisher GitHub Release assets are created.
2. Inspect the release run's exact checkout/package checks, smoke output, vulnerability evidence and push result. Download `publication.json` and confirm tag, commit, platform and digest. Verify the package is linked to this repository and that the workflow has package access; a preexisting package may require a separately approved Actions access setting.
3. Check anonymous access first. If the package is private, obtain approval before changing its visibility to public in GHCR settings. On a clean Linux/amd64 client, use a new empty `DOCKER_CONFIG` directory and no login. Pull both version and recorded digest, inspect `RepoDigests` and OCI labels, then run `--version` and `--help`. Confirm the version tag resolves to the recorded digest and the expected source revision. Remove the temporary Docker config afterwards. A previously cached image or authenticated client alone does not prove anonymous pull access.
4. Obtain approval for a controlled rerun of that same event. Save the original digest. Rerun the completed job using GitHub Actions **Re-run jobs**. Confirm it reports `reused: true`, tests/scans the pulled existing digest, does not push the immutable version again and preserves its exact digest; a missing or older `latest` alias may be repaired separately. Do not manufacture a production conflict. Credential-free tests cover conflicting publication and registry failures.
5. If a run fails before push, resolve infrastructure/access issues and rerun the original job. If push status is uncertain, preserve logs and let reconciliation discover the registry state. If source/metadata conflicts or vulnerability gates fail, stop for review. Do not move tags, change visibility/access, delete versions or broaden credentials as an automatic retry.

Record actual run URLs, digest/config ID, tag/commit, scan policy/database identity, clean-client pull result, visibility and approved retry outcome. Local builds and unit fixtures establish none of those live registry/access results.

## Live bootstrap result

On 2026-11-15, the [successful rolling run](https://github.com/lhajoosten/release-log/actions/runs/43761533860) created `v0.2.0` at `f4738a3634edf97e2f5992f1091bb3a6a69e45f0`. The independent [Container release run](https://github.com/lhajoosten/release-log/actions/runs/43761586854) started from that source and passed the exact-tag/package checks. This confirms downstream delivery from the App-created tag.

That run then failed installation with `ERR_PNPM_IGNORED_BUILDS` for esbuild. Its earlier `pnpm container:release validate` invocation had implicitly installed dependencies before the explicit scripts-disabled install. Build, smoke, scan and publication steps were skipped; this run published no image. The corrected order installs explicitly first and is covered by an offline cold-store regression using the workflow's actual command sequence.

Rerunning the original `v0.2.0` event still uses its tagged workflow, so a fix merged to main does not change that run. Use a reviewed subsequent patch release containing the corrected workflow for publication. Do not move or recreate `v0.2.0`, approve dependency scripts, or weaken build checks to recover this ordering defect. The subsequent `v0.2.1` evidence below establishes publication and anonymous access. The subsequent controlled retry also passed.

## Live v0.2.1 publication

On 2026-11-16, [release PR #73](https://github.com/lhajoosten/release-log/pull/73) landed at `3c6a50e5192cf9fe110c9bcd2ffe2ed5854cf0be`, the exact `v0.2.1` target. [Container release run 43929562742, attempt 1](https://github.com/lhajoosten/release-log/actions/runs/43929562742/attempts/1) completed successfully after the installation-order fix in [PR #72](https://github.com/lhajoosten/release-log/pull/72). Explicit scripts-disabled installation, exact-source/version validation, build, smoke tests, scan and publication all passed.

| Publication evidence                   | Recorded value                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Version reference                      | `ghcr.io/lhajoosten/release-log:v0.2.1`                                                  |
| Manifest digest                        | `sha256:1f0ba94d9a78c183942460179721c565f2698cc8523a5f9e868330578ff47c7f`                |
| Config digest                          | `sha256:d05bd0fb5b3546e13661586ae4cbf68aaf8de16c6ef02b5a157233c809cf6a21`                |
| Source/revision                        | `https://github.com/lhajoosten/release-log` / `3c6a50e5192cf9fe110c9bcd2ffe2ed5854cf0be` |
| Platform / version / reused            | `linux/amd64` / `0.2.1` / `false`                                                        |
| Artifact                               | `container-release-43929562742-1`, ID `14256319680`                                      |
| Artifact ZIP SHA-256 (GitHub metadata) | `69f4a8c7245a0880c612263a91d3e63a59431063824fdd2d1d587f7dc1a233f9`                       |

The artifact contains `publication.json` and the full `candidate-scan/` inventory, findings, scanner/database identities and logs. It was downloaded for preservation; GitHub retention expires on 2027-02-14. Preserve a durable copy before expiry. The scan at `2026-11-16T18:32:17.925Z` used Syft `1.57.0`, Grype `0.121.2` and database schema `v6.1.10`, built `2026-11-16T06:30:54Z`. It inventoried 122 packages and recorded five Medium findings, with no High, Critical or Unknown findings; `blocked` was `false`. This is a dated policy result, not a permanent vulnerability verdict.

Anonymous verification used Docker Engine `29.9.1` on Linux/amd64 with a newly created empty Docker config and no login. The release image was absent before the version pull; that pull downloaded the image and returned the recorded manifest digest. The subsequent digest pull also succeeded. Some layers were already cached on the host; this was not an empty Docker daemon. Inspection confirmed Linux/amd64 and the expected OCI source, revision and version labels. Digest-pinned runs with `--network none --read-only --cap-drop ALL` returned `0.2.1` for `--version` and CLI usage for `--help`, both with exit code 0.

These pulls establish anonymous read access at verification time. The available GitHub API credential returned HTTP 403 for package metadata because it lacks `read:packages`; package settings, repository linkage and writer access were not independently audited. No visibility or access settings were changed. Keep the workflow as the sole release-version writer. The authorized controlled rerun below passed; no production conflict was created.

### Controlled same-event retry

With explicit authorization, [attempt 2 of the same event](https://github.com/lhajoosten/release-log/actions/runs/43929562742/attempts/2) completed successfully on 2026-11-16. Its `publication.json` reports `reused: true`; image reference, manifest digest, config digest, source, revision, version and platform exactly match attempt 1. The existing-image branch in the tagged `scripts/container-release.ts` pulls the retained digest, reruns smoke tests and scans it, and contains no `docker push` call. Authenticated Docker output is intentionally suppressed, so the no-push conclusion comes from the observed reuse branch and the reviewed code, rather than a separate registry write audit.

The `reused-scan/evidence.json` scan at `2026-11-16T18:39:53.568Z` names the original config digest and registry digest. It passed with the same scanner versions/database identity, 122 packages and five Medium findings, with `blocked: false`. The saved SBOM and vulnerability report bytes match their recorded SHA-256 hashes. Retry evidence is in artifact `container-release-43929562742-2`, ID `14259730036`, ZIP SHA-256 `297698c8f215ddd1bda3ba1dce074bf7969d35b998935d1bb22046642521bb26` (GitHub metadata), expiring 2027-02-14. Both attempts' full artifacts and logs were downloaded for preservation.

The live matching-publication retry is verified. Conflicts remain covered by credential-free tests; no conflicting production publication or settings change was attempted. GHCR still has no atomic create-only tag write, so retaining the workflow as the sole release-version writer remains a required operating condition.
