# release-log

<img width="2172" height="724" alt="image" src="https://github.com/user-attachments/assets/e414345c-7151-4dbc-8277-d2791a54e147" />

## How it works

1. **Merge an ordinary PR.** When the batch warrants a release, the GitHub App creates or refreshes one release PR containing the next version, changelog and captured release inputs.
2. **Review the release PR.** Each refresh includes the complete range since the previous version tag. Supported root Node/Python manifests are updated together, and released changelog sections are preserved.
3. **Merge the release PR.** The workflow creates `vMAJOR.MINOR.PATCH` at that exact merge landing. It does not create another proposal for the release itself.
4. **Use the tag downstream.** Your repository can trigger image publication, packaging or deployment from that version tag.

Release membership comes from Git reachability, not merge dates. Conventional PR titles classify changes; structured PR context explains their impact and any required action. Captured inputs support deterministic offline replay without fetching mutable PR descriptions again. Invalid metadata and missing associations are surfaced explicitly.

The [rolling-release workflow guide](docs/release-workflow.md) covers setup, permissions, generated files and recovery. The [release policy](docs/release-policy.md) defines versioning and membership rules.

## Proven behavior

This repository uses the source-pinned workflow with proposal/tag writes enabled. Its first release, [v0.1.0](https://github.com/lhajoosten/release-log/tree/v0.1.0), tags the exact landing of [release PR #62](https://github.com/lhajoosten/release-log/pull/62).

A private validation sandbox has also demonstrated:

- Creating a proposal and refreshing that same PR after another ordinary merge.
- A subsequent `v0.1.0` → `v0.2.0` cycle using the released tag as its baseline, including only new ordinary changes and preserving the old changelog section byte for byte.
- Tagging the exact human-merge landing, with no recursive proposal.
- Repeating a successful tag run with an `unchanged` result and unchanged tags and generated files.

The sandbox uses synthetic examples; it proves those lifecycle behaviors, not production adoption or every failure mode. Controlled stale/tamper, concurrency and missing/conflicting-tag exercises remain outstanding. See [run evidence and remaining validation](docs/release-workflow.md#live-evidence-and-remaining-validation).

## Try the CLI from source

Use Node.js **26.13.0** and pnpm **12.14.0**:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli.js --help
```

The [CLI guide](docs/cli.md) covers online collection, offline planning/rendering, dry-run preparation, explicit proposal writes and exact-landing tagging. The [container guide](docs/container.md) covers the local Linux/amd64 image and its smoke/security checks.

The package is private at `0.1.0`. Local/runner tarballs and CI container builds are available; no GitHub Release assets, npm package or published OCI image is established by this rollout. The [stable-tag container workflow](docs/container-release.md) targets GHCR with version tags and digest references; first publication and public pull access remain unverified.

## Set up release automation

Start with the [consumer workflow template](examples/rolling-release.yml) and [setup contract](docs/release-workflow.md#reusable-workflow-and-callers). New consumers need their own repository identity, reviewed bootstrap/onboarding boundaries, trusted configuration and GitHub App installation. Pin both workflow and tool to the same reviewed full commit SHA; the example keeps writes disabled until setup is approved.

PRs use conventional titles and the [version 1 release-context block](docs/release-context.md). Context is required by default; consumers can explicitly select the [optional policy](docs/release-context.md#consumer-context-policy). This repository keeps it required.

The App maintains proposals and tags; a human reviews and merges release PRs. Matching-tag retries reuse the existing tag. Conflicting tags and unexpected edits stop for review rather than being overwritten. Downstream publishing permissions belong to downstream jobs. Custom approval receipts and the separate publication executor are not prerequisites for this flow.

## Optional AI notes

AI-written user-facing release notes are planned and remain unimplemented; no provider or model is configured. Ordinary changelog generation works without AI credentials or an available provider.

AI will not determine release membership, classification or breaking status. Any future notes must preserve supported impact, warnings, required actions and source references, omit explicitly internal changes, and avoid invented claims. AI output is a separate artifact from the deterministic changelog.

## Documentation and development

The [documentation overview](docs/index.md) links component and operations guides. [CONTRIBUTING.md](CONTRIBUTING.md) covers toolchain setup, checks, hooks and CI; run `pnpm verify` for the canonical repository checks. [AGENTS.md](AGENTS.md) defines coding-agent guidance.

Licensed under the [MIT License](LICENSE.md).
