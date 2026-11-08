# Local OCI distribution

The local image wraps the actual [packaged CLI](cli.md), Node.js and Git. `container/Dockerfile`, `scripts/build-container.ts` and `scripts/check-container.ts` implement the build/smoke-test portion of [#21](https://github.com/lhajoosten/release-log/issues/21). Nothing pushes to a registry or creates a release; the package remains private at `0.0.0`.

## Build from locked inputs

On a Linux x86-64 host with the pinned development Node/pnpm, Docker Engine, `tar`, and dependencies installed with `pnpm install --frozen-lockfile --ignore-scripts`:

```sh
pnpm container:build --tag release-log-local:development
pnpm check:container
```

The first command requires an explicit local tag and leaves that image available. It does not accept a push option. The second builds a uniquely named temporary image, exercises it, and removes that image and its temporary repositories. It does not prune unrelated Docker state. Rootless engines, user-namespace remapping, remote Docker daemons, non-Linux bind mounts and other CPU architectures are not validated; the bind-mount smoke test requires a local Linux/amd64 daemon.

The builder runs `pnpm pack`, unpacks the resulting archive, restores its preserved production lock bytes, and installs only production dependencies with `--offline --prod --frozen-lockfile --ignore-scripts`. Project installation must populate the pnpm content cache first; no lifecycle scripts or consumer build backend run. The context contains only that packaged runtime/dependency tree and the reviewed Dockerfile/ignore file. It excludes this checkout's `.git`, `.env`, credentials, tests, source tooling and development-only dependencies. Package manifests may retain dev-dependency declarations; those dependencies are not installed. pnpm's host workspace/store metadata is removed before sending the context.

The base is official `node:26.13.0-bookworm-slim`, pinned to manifest-list digest `sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`. Build uses only `linux/amd64`. Git/CA certificates come from fixed Debian/bookworm and security snapshots at `20261105T000000Z`. Snapshot expiry checks are explicitly disabled because the archive is historical; package/index signatures and hashes remain enabled. Image build needs network access to Docker Hub and Debian's snapshot archives, never a GitHub token or build secret.

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

No vulnerability scan has been completed: Docker Scout, Trivy and Grype were unavailable locally. Dependency/base pinning is not a vulnerability verdict. Before publishing, review a current OS/runtime/production-dependency scan/SBOM, record tool/database/date and dispositions, and rebuild with reviewed updates as needed. Keep the Node tag/digest and Debian snapshot timestamp explicit; review security updates before each release and promptly for relevant advisories, then rerun `pnpm verify` and `pnpm check:container`. Do not silently float the base or claim an old scan covers a new image.

Proposed publication contract (not created): `ghcr.io/lhajoosten/release-log:vX.Y.Z`, matching the approved tool version, plus an immutable `@sha256:...` reference for consumers/CI. Do not rely on mutable `latest`. Publication belongs to #23 and needs approved credentials/visibility/recovery; no package access policy or registry settings were changed. Private-package pulls must be tested with an explicitly approved reader identity and denied without access where intended. The repository being public does not establish package visibility or prove anonymous pull works. That access/authentication evidence and vulnerability review remain open gates in #21; a passing local container build does not complete them.
