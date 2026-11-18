# release-log

<img width="2172" height="724" alt="image" src="https://github.com/user-attachments/assets/e414345c-7151-4dbc-8277-d2791a54e147" />

## How it works

1. **Merge an ordinary PR.** When the batch warrants a release, the GitHub App creates or refreshes one release PR containing the next version, changelog and captured release inputs.
2. **Review the release PR.** Each refresh includes the complete range since the previous version tag. Supported Node, Python, and Cargo version files are updated together, and released changelog sections are preserved.
3. **Merge the release PR.** The workflow creates `vMAJOR.MINOR.PATCH` at that exact merge landing. With `githubRelease: true`, it also publishes that version’s verified changelog as a GitHub Release and requests latest. It does not create another proposal for the release itself.
4. **Use the tag downstream.** Your repository can trigger image publication, packaging or deployment from that version tag.

Release membership comes from Git reachability, not merge dates. Conventional PR titles classify changes; structured PR context explains their impact and any required action. Captured inputs support deterministic offline replay without fetching mutable PR descriptions again. Invalid metadata and missing associations are surfaced explicitly.

The [rolling-release workflow guide](docs/release-workflow.md) covers setup, permissions, generated files and recovery. The [release policy](docs/release-policy.md) defines versioning and membership rules.

## Proven behavior

This repository uses the source-pinned workflow with proposal/tag writes enabled. Its first release, [v0.1.0](https://github.com/lhajoosten/release-log/tree/v0.1.0), tags the exact landing of [release PR #62](https://github.com/lhajoosten/release-log/pull/62). Subsequent self-use releases `v0.2.0` and `v0.2.1` also tag their exact release-PR landings, with tag-bound membership and preserved prior changelog content.

A private validation sandbox has also demonstrated:

- Creating a proposal and refreshing that same PR after another ordinary merge.
- A subsequent `v0.1.0` → `v0.2.0` cycle using the released tag as its baseline, including only new ordinary changes and preserving the old changelog section byte for byte.
- Tagging the exact human-merge landing, with no recursive proposal.
- Repeating a successful tag run with an `unchanged` result and unchanged tags and generated files.

The sandbox uses synthetic examples; it proves those lifecycle behaviors, not independent consumer adoption or every failure mode. Controlled stale/tamper, concurrency and missing/conflicting-tag exercises remain outstanding. See [run evidence and remaining validation](docs/release-workflow.md#live-evidence-and-remaining-validation).

## Run the published CLI

On Linux/amd64 with Docker, pull and run the verified `v0.2.1` image without logging in:

```sh
docker pull --platform linux/amd64 ghcr.io/lhajoosten/release-log:v0.2.1
docker run --rm --network none --read-only --cap-drop ALL \
  ghcr.io/lhajoosten/release-log@sha256:1f0ba94d9a78c183942460179721c565f2698cc8523a5f9e868330578ff47c7f --version
docker run --rm --network none --read-only --cap-drop ALL \
  ghcr.io/lhajoosten/release-log@sha256:1f0ba94d9a78c183942460179721c565f2698cc8523a5f9e868330578ff47c7f --help
```

Use the digest reference in automation. The [runtime guide](docs/container.md#run-with-mounted-inputs) shows configuration/snapshot mounts, host UID/GID and explicit writes. Stable version tags and digest references are available. The updated publisher also promotes `ghcr.io/lhajoosten/release-log:latest` to the highest successfully published stable version with the same digest; its first live promotion is pending a release containing that implementation. No arm64 image is provided.

## Build the CLI from source

Use Node.js **26.13.0** and pnpm **12.14.0**:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli.js --help
```

The [CLI guide](docs/cli.md) covers online collection, offline planning/rendering, dry-run preparation, explicit proposal writes and exact-landing tagging. The [container guide](docs/container.md) covers the local Linux/amd64 image and its smoke/security checks.

The npm package remains private at `0.2.1`. The Linux/amd64 image `ghcr.io/lhajoosten/release-log:v0.2.1` is published, and anonymous version/digest pulls plus `--version` and `--help` have passed. Use the [verified pull/run examples and digest](docs/container-release.md#pull-and-run) in automation. The authorized same-event retry retained the digest with `reused: true` and no push. No npm package or GitHub Release assets are distributed.

## Set up release automation

Start with the [consumer workflow template](examples/rolling-release.yml) and [setup contract](docs/release-workflow.md#reusable-workflow-and-callers). New consumers need their own repository identity, reviewed bootstrap/onboarding boundaries, trusted configuration and GitHub App installation. Pin both workflow and tool to the same reviewed full commit SHA; the example keeps writes disabled until setup is approved.

The newer controller also supports opt-in [release PR self-upgrades and GitHub Releases](docs/release-workflow.md#self-upgrades-and-github-releases). This repository’s caller selects the reviewed implementation revision and retains its legacy verification runtime; the operations guide records the bootstrap’s required App permissions and read-only verification evidence.

PRs use conventional titles and the [version 1 release-context block](docs/release-context.md). Context is required by default; consumers can explicitly select the [optional policy](docs/release-context.md#consumer-context-policy). This repository keeps it required.

The App maintains proposals and tags; a human reviews and merges release PRs. Matching-tag retries reuse the existing tag. Conflicting tags and unexpected edits stop for review rather than being overwritten. Downstream publishing permissions belong to downstream jobs. Custom approval receipts and the separate publication executor are not prerequisites for this flow.

## Optional AI notes

AI-written user-facing release notes are planned and remain unimplemented. A separate [optional text-generation API](docs/text-generation.md) now supports explicit OpenAI, Anthropic, Azure and OpenAI-compatible connections through AI SDK Core; no provider or model is enabled by default. Ordinary changelog generation works without AI credentials or an available provider. The [architecture decision](docs/adr/0002-ai-sdk-provider-integration.md) records the provider integration choice.

AI will not determine release membership, classification or breaking status. Any future notes must preserve supported impact, warnings, required actions and source references, omit explicitly internal changes, and avoid invented claims. AI output is a separate artifact from the deterministic changelog.

## Documentation and development

The [documentation overview](docs/index.md) links component and operations guides. [CONTRIBUTING.md](CONTRIBUTING.md) covers toolchain setup, checks, hooks and CI; run `pnpm verify` for the canonical repository checks. [AGENTS.md](AGENTS.md) defines coding-agent guidance.

Licensed under the [MIT License](LICENSE.md).
