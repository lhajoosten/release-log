# Local OCI distribution

The local image wraps the actual [packaged CLI](cli.md), Node.js and Git. `container/Dockerfile`, `scripts/build-container.ts`, `scripts/check-container.ts` and `scripts/scan-container.ts` implement the local build, smoke tests and vulnerability gate for [#21](https://github.com/lhajoosten/release-log/issues/21). Nothing pushes to a registry or creates a release; the package remains private at `0.0.0`. **The current image fails the vulnerability gate; it is not cleared for publication.**

## Build from locked inputs

On a Linux x86-64 host with the pinned development Node/pnpm, Docker Engine, `tar`, and dependencies installed with `pnpm install --frozen-lockfile --ignore-scripts`:

```sh
pnpm container:build --tag release-log-local:development
pnpm check:container
```

The first command requires an explicit local tag and leaves that image available. It does not accept a push option. The second builds a uniquely named temporary image, exercises it, and removes that image and its temporary repositories. It does not prune unrelated Docker state. Rootless engines, user-namespace remapping, remote Docker daemons, non-Linux bind mounts and other CPU architectures are not validated; the bind-mount smoke test requires a local Linux/amd64 daemon.

The builder runs `pnpm pack`, unpacks the resulting archive, restores its preserved production lock bytes, and installs only production dependencies with `--offline --prod --frozen-lockfile --ignore-scripts`. Project installation must populate the pnpm content cache first; no lifecycle scripts or consumer build backend run. The context contains only that packaged runtime/dependency tree and the reviewed Dockerfile/ignore file. It excludes this checkout's `.git`, `.env`, credentials, tests, source tooling and development-only dependencies. Package manifests may retain dev-dependency declarations; those dependencies are not installed. pnpm's host workspace/store metadata is removed before sending the context.

The base is official `node:26.13.0-bookworm-slim`, pinned to manifest-list digest `sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`. Build uses only `linux/amd64`. Git/CA certificates come from fixed Debian/bookworm and security snapshots at `20261105T000000Z`. Snapshot expiry checks are explicitly disabled because the archive is historical; package/index signatures and hashes remain enabled. Image build needs network access to Docker Hub and Debian's snapshot archives, never a GitHub token or build secret.

The runtime removes the base image's unused npm/npx and Yarn installations. Installing dependencies happens before the image build; the CLI needs only Node and its already-installed production dependencies. Smoke tests enforce the package managers' absence. This is a runtime-filesystem reduction, not a claim that their bytes disappear from inherited base layers.

These pins make the dependency selection repeatable; they do **not** promise byte-identical OCI digests. Local timestamps, builder versions, compression and provenance can change image bytes. Record the resulting digest when an image is eventually approved/published.

## Run with mounted inputs

For offline commands, keep networking disabled and inputs read-only. Match the host UID/GID so Git ownership checks and any explicit output writes work without running the CLI as root:

```sh
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
  --mount "type=bind,src=$(pwd),dst=/workspace,readonly" \
  release-log-local:development plan --config /workspace/release-config.json \
  --snapshot /workspace/inputs.json --current-version 1.2.3
```

The default image user is `1000:1000`, workdir `/workspace`, entrypoint `node /opt/release-log/dist/src/cli.js`. Default command is `--help`. Tool version and `org.opencontainers.image.version` both come from the packaged artifact. Other OCI labels identify title, source, description and MIT license; this local build is not signed release provenance.

To use `prepare --write`, deliberately mount a trusted isolated workspace writable (omit `readonly` from that bind mount), still with the matching non-root UID/GID. The root filesystem can remain read-only; temporary proposal files are created beside their intended outputs. Use absolute container paths for configuration/snapshot/repository. Mounted symlinks, lockfile/version restrictions and partial-write recovery follow the existing [CLI contract](cli.md). Do not mount your home directory, credential stores or Docker socket into the tool container.

Git's normal safe-directory ownership checks stay enabled: mismatched repository ownership fails, rather than adding `safe.directory=*`. The image ignores system/global Git configuration and uses an ephemeral `/tmp` home; it does not import host Git credentials or configuration. Prefer matching ownership. Any narrowly scoped exception needs explicit operator configuration, not a blanket image exemption. Complete local history and required objects/tags must already be available; inspection does not fetch them. Git reading never checks out the inspected repository or executes its hooks.

Online `collect`, `propose` or `verify-approval` require separately approved execution, deliberate network access and a runtime-only repository-limited `GITHUB_TOKEN`. Pass it through the runtime environment, not build arguments, image layers, command-line token values, configuration or captured inputs. Credentials do not grant release authority; the proposal/approval trust contracts still apply. No workflow here supplies credentials or enables proposal writes/publication.

## Tests and CI

`pnpm check:container` builds the real image and runs containers with networking disabled, a read-only root filesystem, dropped capabilities and isolated fixtures. It checks:

- Default non-root help/version behavior, matching packaged/OCI versions, and absence of checkout/development material and baked-in GitHub token configuration.
- Offline planning/rendering, mixed Node/Python dry-run and explicit writes, unchanged dry-run input, read-only mount rejection, and output UID/GID ownership.
- Mounted Git history, ownership mismatch rejection, no consumer lifecycle/hook execution, and a runtime-only synthetic token reaching a sanitized network failure without contacting GitHub.
- Success, usage-error (2) and operation-error (1) exit statuses.

The unprivileged Quality workflow adds a separate `container` job on PRs/main/manual dispatch, alongside ordinary `pnpm verify`. It installs locked dependencies without lifecycle scripts, builds locally, and runs these same checks. It does not login, push, upload an image or receive package-write/OIDC permissions. Local `pnpm verify` does not require Docker; run `pnpm check:container` explicitly for this integration gate. No live release rehearsal/controller is exercised.

## Size, security and registry gates

The first local smoke run measured **516,838,822 bytes uncompressed** (Docker image `Size`), with Node 26.13.0, Git 2.39.5 and packaged CLI 0.0.0. This is not registry transfer size or a size limit. Debian/glibc, the Node base's existing utilities, Git's libraries/Perl and production parser dependencies favor compatibility over a minimal/distroless runtime. No Python interpreter/build backend is needed for static `pyproject.toml` edits. Further size reduction must preserve runtime behavior and remains separate work.

The [2026-11-09 local scan review](container-security.md) records actual before/after image identities, scanner/database identities, remediation and unresolved OS findings. Dependency/base pinning is not a vulnerability verdict. Keep the Node tag/digest and Debian snapshot timestamp explicit; review security updates before each release and promptly for relevant advisories, then rerun `pnpm verify`, `pnpm check:container` and the image scan below. Do not silently float the base or claim an old scan covers a new image.

### Vulnerability gate

On the same supported Linux/amd64 host, scan the image built above:

```sh
mkdir -p reports
node scripts/scan-container.ts --image release-log-local:development --output reports/container-security
```

The output directory must not already exist; choose a new directory for each run. Exit 0 means the scan completed with no High, Critical or Unknown-severity matches; exit 1 means a policy or operational failure. **The current image exits 1 with unresolved OS findings.** This command downloads checksum-pinned Syft 1.57.0 and Grype 0.121.2 release archives from GitHub, verifies them before extraction/execution, and downloads a fresh Grype database from `grype.anchore.io`. It needs public HTTPS access but no registry login, GitHub token or model service. TLS remains enabled.

The scanner inspects an existing local image, exports it by immutable Docker ID (not a second lookup of its mutable tag), hashes that archive, and catalogs its squashed runtime filesystem with Syft. Grype matches that exact SBOM against the downloaded database. Neither tool runs the target image or sends its image/source/SBOM to an external analysis service. Scan subprocesses get an isolated home/cache/configuration and no inherited tokens, `GRYPE_*`/`SYFT_*` overrides or repository ignore rules. Docker uses the default local daemon; remote/rootless daemon configuration is not supported here.

Required coverage is Debian packages, the separately installed Node binary, and installed production npm packages. The Node binary must be inventoried independently of dpkg; an OS-only or package-manifest-only scan is insufficient. Results are advisory matches, not proof of exploitability or absence of unknown vulnerabilities. Bundled native libraries in Node and scanner/cataloger coverage gaps still require upstream advisory review. Deleted historical layers are not scanned as installed runtime packages.

The failure policy includes **unfixed and `wont-fix` High/Critical findings** and fails closed on Unknown severity, missing required inventory, malformed reports, scanner/download/hash failures, or database validation failure. Grype validates the database hash and rejects databases built more than 120 hours ago. Each run starts with a fresh cache and explicitly updates it; there is no stale-cache fallback or automatic risk waiver. Low/Medium findings remain in the full report for review. Grype's built-in matcher suppressions are distinct from repository waivers; the raw report preserves its configuration/ignored matches.

Evidence includes `image.json`, `scanner-pins.json`, both scanner version records, `sbom.syft.json`, `database.json`, `vulnerabilities.json`, logs and `evidence.json` with scan time, image/repository digests and archive/SBOM/report hashes. Failure writes `failure.json`; operational failure before report completion does not produce successful evidence. Temporary executables, image archive and database are removed, but reports remain. Image digests are local identities, not evidence of registry publication. Reports contain inventory/paths and image metadata: scan only the intended non-secret-bearing build and review artifacts before sharing them.

The dedicated **Container security** workflow uses read-only repository permissions on unprivileged PRs, main pushes, Monday 06:23 UTC scheduled runs and manual dispatch. It builds the packaged image, invokes this same scanner, and attempts to retain reports for 14 days even on failure. External Actions are SHA-pinned; scanner releases are version/SHA-256 pinned in `scripts/scan-container.ts`. It does not use `pull_request_target`, secrets, registry login, package-write or OIDC permissions, SARIF publication, or image uploads. Enforcing the check in branch protection is a separate settings operation; no required-check configuration is claimed.

Update scanner version/checksum pairs together after reviewing upstream releases; verify the archive SHA-256 against the upstream release assets/checksum records, not a newly fetched binary alone. Database content intentionally stays current rather than permanently pinned; each report records its schema/build/source checksum so historical findings are attributable. Review scheduled failures, relevant advisories and pins before each release. Base/snapshot or production-dependency changes need a fresh build, full checks, Docker smoke and scan. No expiry bypass or ignore list is accepted merely to make CI green.

Proposed publication contract (not created): `ghcr.io/lhajoosten/release-log:vX.Y.Z`, matching the approved tool version, plus an immutable `@sha256:...` reference for consumers/CI. Do not rely on mutable `latest`. Publication belongs to #23 and needs approved credentials/visibility/recovery; no package access policy or registry settings were changed. Private-package pulls must be tested with an explicitly approved reader identity and denied without access where intended. The repository being public does not establish package visibility or prove anonymous pull works. That access/authentication evidence and resolution of the recorded vulnerability blockers remain open gates in #21; passing local build/smoke tests or merely producing a scan report does not complete them.
