# Stable-tag container publication

The [accepted distribution contract](adr/0001-container-distribution.md) selects GHCR at `ghcr.io/lhajoosten/release-log`, public anonymous pulls, Linux/amd64, canonical `vMAJOR.MINOR.PATCH` image tags and digest references. There are no moving aliases. This implementation has not established a published image or public access. npm publication and the package manifest's `private` flag are independent of GHCR visibility.

## Trigger and source

`.github/workflows/container-release.yml` reacts separately to creation of stable version tags. It ignores deletions and updates to existing tags. GitHub's tag glob narrows candidates; the script enforces canonical stable syntax, including no leading zeroes or prereleases. Checkout uses the event SHA, with complete tag history and no persisted checkout credential. The checked-out HEAD, peeled tag commit and event SHA must agree, and `package.json` must match the tag without its `v`. The image version comes from the packaged manifest; OCI revision records the checked-out commit and OCI source links the repository. No branch head, merge date, proposal receipt or release executor selects the source.

The workflow must exist in the tagged source. It does not backfill historical tags lacking the workflow. Rerun the original tag event for recovery; there is deliberately no manual dispatch accepting a branch or arbitrary source. Retagging, tag deletion and force pushing are not recovery mechanisms.

The live rolling caller pins `.github/workflows/rolling-release.yml` and the CLI to `8828be515345d761a7375b5c00b1beff0cfabaeb`. That workflow mints a repository-scoped App installation token, passes it as `RELEASE_LOG_APP_TOKEN`, and the `roll` command uses that token for the `POST /git/refs` tag creation. There is no `GITHUB_TOKEN` fallback. GitHub documents that [App installation-token events can trigger workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), unlike ordinary `GITHUB_TOKEN` pushes. This establishes the intended event path from inspected code and documentation; observing the downstream run from a new App-created tag remains a live gate.

## Gates, credentials and evidence

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

Once publication and visibility are verified, substitute a published version and its recorded digest:

```sh
docker pull --platform linux/amd64 ghcr.io/lhajoosten/release-log:vX.Y.Z
docker pull --platform linux/amd64 ghcr.io/lhajoosten/release-log@sha256:RECORDED_DIGEST
docker run --rm --network none --read-only --cap-drop ALL \
  ghcr.io/lhajoosten/release-log@sha256:RECORDED_DIGEST --version
```

Use the digest form in automation. The [runtime guide](container.md#run-with-mounted-inputs) explains read-only input mounts, host UID/GID and explicit writes; replace its local image reference with the published digest. No arm64 support or emulation validation is claimed.

## Failure and retry recovery

Registry reads fail closed on authentication/authorization errors, rate limits, outages, malformed metadata, unexpected redirects and digest mismatches. Only a registry `MANIFEST_UNKNOWN` or `NAME_UNKNOWN` 404 means the version is absent. Registry manifest and config bytes must match their SHA-256 identities. Multi-platform indexes and mismatched version/platform/source metadata are rejected.

For an absent version, tag and push the already verified local candidate ID. Docker API 1.46+ is required: [`docker push --platform linux/amd64`](https://docs.docker.com/reference/cli/docker/image/push/) publishes only the platform manifest, excluding builder indexes and attestations. Recheck absence immediately before writing. Check the resulting registry config against the scanned archive config digest and record the manifest digest. If the push succeeded but acknowledgement or artifact upload failed, rerunning the original event finds the existing image. A matching version/source/platform is pulled by digest and reruns smoke and current vulnerability checks before being recorded as retained. It is never pushed again. A conflict stops without a write; inspect its provenance and package access, then use a separately reviewed new release or recovery decision. Do not delete/reassign a published version to get a green run.

Workflow concurrency serializes each version and does not cancel an in-progress push. All release-tag writers must use this workflow; out-of-band concurrent writes cannot be made atomic with GHCR. No registry-side immutability guarantee is claimed. The original event and pinned inputs must remain available for reruns. Candidate preparation also runs on retries, so retired upstream build inputs or a current scan failure can block recovery; do not bypass the gate or substitute updated source under an existing Git tag. A scanner download/database outage is retryable after service recovery. New vulnerabilities require review and generally a new patched release.

## Approved live verification procedure

This procedure is prepared, not executed. Obtain authorization for commits/push/PR and the first publication before making this workflow reachable by a new stable tag. Package visibility/access changes require explicit authorization too.

1. Review and land the implementation through the normal PR process, then let the human-merged rolling release create the next stable tag containing it. Do not recreate historical tags. Capture the App-created tag ref, exact commit, rolling run and independent Container release run URLs. Confirm that no moving aliases or GitHub Release assets are created.
2. Inspect the release run's exact checkout/package checks, smoke output, vulnerability evidence and push result. Download `publication.json` and confirm tag, commit, platform and digest. Verify the package is linked to this repository and that the workflow has package access; a preexisting package may require a separately approved Actions access setting.
3. With approval, change the package visibility to public in GHCR settings. On a clean Linux/amd64 client, use a new empty `DOCKER_CONFIG` directory and no login. Pull both version and recorded digest, inspect `RepoDigests` and OCI labels, then run `--version` and `--help`. Confirm the version tag resolves to the recorded digest and the expected source revision. Remove the temporary Docker config afterwards. A previously cached image or authenticated client alone does not prove anonymous pull access.
4. Obtain approval for a controlled rerun of that same event. Save the original digest. Rerun the completed job using GitHub Actions **Re-run jobs**. Confirm it reports `reused: true`, tests/scans the pulled existing digest, performs no push and preserves the exact digest. Do not manufacture a production conflict. Credential-free tests cover conflicting publication and registry failures.
5. If a run fails before push, resolve infrastructure/access issues and rerun the original job. If push status is uncertain, preserve logs and let reconciliation discover the registry state. If source/metadata conflicts or vulnerability gates fail, stop for review. Do not move tags, change visibility/access, delete versions or broaden credentials as an automatic retry.

Record actual run URLs, digest/config ID, tag/commit, scan policy/database identity, clean-client pull result, visibility and approved retry outcome. Local builds and unit fixtures establish none of those live registry/access results.
