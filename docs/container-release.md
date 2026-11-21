# Stable container publication

The [accepted distribution contract](adr/0001-container-distribution.md) selects GHCR at `ghcr.io/lhajoosten/release-log`, public anonymous pulls, Linux/amd64, canonical `vMAJOR.MINOR.PATCH` image tags and digest references. The updated publisher also maintains a mutable `latest` alias for convenient pulls, with the exact manifest digest of the highest successfully published stable version. The first successful publication is `v0.2.1`; anonymous version/digest pulls and CLI execution were verified on 2026-11-16. See the [live publication evidence](#live-v0-2-1-publication). npm publication and the package manifest's `private` flag are independent of GHCR visibility.

## Trigger and source

The [self-release workflow](adr/0005-internal-release-publication.md) runs on main pushes and every four hours. It discovers current work from verified merged release PRs and stable publication state. **Run workflow** on `main` requests an immediate reconciliation and takes no source or version input. A verified generated PR landing is the candidate. Its package version matches the intended stable tag, and its built image records the exact landing as the OCI revision. Stable Git tags use canonical `vMAJOR.MINOR.PATCH` syntax.

While a candidate is blocked, a new source or pinned-input fix goes through the ordinary PR path. A newly reviewed release landing may supersede the pending candidate until public writes begin. Main advancing does not change the current candidate. The previous stable tag remains the planning baseline until the image, tag and GitHub Release are verified.

The **Release proposal replay** check replays open generated release PRs from the trusted main checkout, using the runtime registry that the proposed self-upgrade would use after merge. It does not execute PR code or write release state. If a producer SHA is missing, review that revision and retain it in the caller’s explicitly trusted verification runtimes rather than trusting the PR marker. Refresh the proposal if its captured source is no longer current. To enforce this check as a merge gate, add `release-proposal-replay` to the required checks on `main` after confirming GitHub reports it on release PRs.

## Gates, credentials and evidence

The workflow installs locked dependencies with `pnpm install --frozen-lockfile --ignore-scripts` before running any pnpm script, including candidate validation. pnpm 12 can implicitly install dependencies before a script, so validating first could attempt dependency lifecycle builds and leave an ignored-build failure for the subsequent explicit install. Keep the explicit scripts-disabled install first; no dependency build approvals or relaxed build policy are needed.

Root commands are the shared interface:

```sh
pnpm container:build --tag release-log-candidate:release
pnpm check:container --image release-log-candidate:release
mkdir -p reports/container-release
pnpm container:scan --image release-log-candidate:release --output reports/container-release/candidate-scan
```

`check:container --image` exercises an existing local image without building or deleting it. The default command still builds and removes its own temporary image. Tests cover actual offline CLI planning/rendering, Git inspection, Node/Python writes, mount/UID boundaries, denied writes and failure exit codes. The scan saves and inventories that local image, applies the existing High/Critical/Unknown policy (including unfixed findings), and records both the local image ID and the config digest extracted from that exact Docker archive. Local IDs can name a config, platform manifest or index depending on Docker storage. Publication checks that scan evidence names the exact candidate ID and that the pushed registry config matches the archive config digest. See [runtime and build details](container.md) and [scan policy](container-security.md).

Only the reconciliation step receives the publication token. The publisher exchanges it for a scoped GHCR bearer token and keeps Docker authentication in a mode-0600 temporary config. Install, build, smoke and scan processes receive an explicit environment without publication credentials. The repository App handles proposal and journal writes. The job token handles stable outputs, so its Git tag creation does not start the historical tag-triggered publisher. Actions are SHA pinned and checkout credentials are ephemeral.

The workflow uploads `reports/container-release/` for 90 days even on failure. It includes scanner/database identity, inventory, findings, local image ID and archive config digest; successful reconciliation also records the version reference, registry manifest digest, config ID, source commit and platform in `publication.json`. The run summary and `status.json` identify pending, blocked, stale, conflicting and completed candidates. Download and preserve that evidence for durable release records; workflow artifacts are not permanent registry attestations. OCI labels are not cryptographic provenance.

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

Pull the convenient alias with:

```sh
docker pull ghcr.io/lhajoosten/release-log:latest
```

After the stable outputs are verified, the workflow copies the version manifest to `latest` through the [registry manifest API](https://distribution.github.io/distribution/spec/api/#put-manifest) and checks the exact digest. It also reconciles the GitHub latest Release. Both aliases retain newer stable versions and report equal-version conflicts. An alias failure leaves the completed version intact. A retry can repair either alias from the completed version. Digest references remain the reproducible choice for automation.

## Failure and retry recovery

Registry reads fail closed on authentication/authorization errors, rate limits, outages, malformed metadata, unexpected redirects and digest mismatches. Only a registry `MANIFEST_UNKNOWN` or `NAME_UNKNOWN` 404 means the version is absent. Registry manifest and config bytes must match their SHA-256 identities. Multi-platform indexes and mismatched version/platform/source metadata are rejected.

For an absent version, use the verified local image ID. The controller checks the running candidate and registry state, records the scanned config digest in the publication journal, then pushes the Linux/amd64 image. Docker API 1.46 or later is required for [the single-platform push](https://docs.docker.com/reference/cli/docker/image/push/). GHCR must report the same config digest before the controller creates the Git tag and GitHub Release.

The reserved `release-log/publication` ref records the claim and confirmed manifest digest. Leave this workflow-owned ref in place. If a push, tag or Release write had an uncertain result, the next run verifies the journal and existing outputs. An incomplete run with a retained version pulls by digest and applies smoke tests and fresh scans before completing the remaining public writes. The full policy remains in force, including when an advisory appears partway through recovery.

A normal vulnerability block includes the candidate identity and blocking report. Infrastructure errors retry on the next qualifying event or schedule. A conflicting ref, release or digest requires inspection. Preserve version tags, releases and images while resolving conflicts. Workflow concurrency serializes approved writers. Independent external writers operate outside that guarantee.

## Live verification procedure

First exercise blocked, superseded and interrupted runs in an authorized sandbox. During an authorized production release, record the exact release PR landing, scan database and report, Git tag, GitHub Release and manifest digest. Confirm no stable output changes while validation is blocked. After successful reconciliation, verify anonymous version and digest pulls with fresh Docker credentials, and confirm that the aliases resolve to the expected version or a newer stable one. The historical runs below predate the self-release controller.

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
