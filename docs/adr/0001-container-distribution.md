# Container distribution after stable tags

Status: accepted, 2026-11-15. Implementation and local verification do not authorize first publication or a visibility change.

The exclusion of `latest` and per-version writer serialization are superseded by [ADR 0004](0004-release-presentation-and-latest.md). Other distribution boundaries remain in force.

## Context

The rolling release workflow already creates a version tag at a manually merged release landing. Consumers need a pullable packaged CLI. Distribution must take that tag as input without depending on proposal approval receipts or the older publication executor.

## Decision

Publish `ghcr.io/lhajoosten/release-log:vMAJOR.MINOR.PATCH` for canonical stable Git tags with matching package versions. Support Linux/amd64 only. Record and recommend digest references. Do not publish `latest`, major/minor aliases, prereleases or additional distributions.

The intended visibility is public with anonymous pulls, selected by the user. GHCR initially creates packages private; changing visibility and verifying anonymous access require separate authorization. The workflow never changes visibility, access settings or credentials. Until made public, pulls require package read access.

Use the repository's `GITHUB_TOKEN` with `packages: write` only in the publication step. Build, smoke-test and scan the candidate before pushing. On retry, retain an existing image only when platform, version, source URL and revision match; smoke-test and rescan that retained image. Reject conflicts and ambiguous registry failures. Never overwrite a known version publication.

Serialize writes for each version and designate this workflow as the sole writer of registry release-version tags. GHCR tag updates have no create-only compare-and-swap guarantee; arbitrary concurrent external writers are outside this contract. Restrict package write access accordingly. Digest references preserve consumer identity even if an external writer violates the contract.

## Alternatives and consequences

GHCR reuses repository-scoped Actions authentication and source association. Docker Hub would require separately managed publishing credentials; mirroring is out of scope. Moving aliases are convenient but add mutable state and recovery rules; reconsider only on explicit request.

Build input pins do not guarantee byte-identical rebuilds. Retry identity therefore uses the published source/platform/version metadata, retains the existing digest and reruns its gates instead of replacing it with a new build. These labels are consistency evidence under the sole-writer policy, not signed provenance. A matching image with new blocking vulnerabilities fails recovery without changing the registry.

See [publication operations](../container-release.md) and the [container runtime guide](../container.md).

## Implementation evidence — 2026-11-16

The decision remains unchanged. `v0.2.1` was published from its exact release landing; anonymous Linux/amd64 version/digest pulls and CLI execution passed. One authorized same-event retry retained the original digest with `reused: true`. [Operations evidence](../container-release.md#live-v0-2-1-publication) records scan identities, artifacts and limits. No package visibility/access settings were changed during verification; those settings were not independently audited because the available API credential lacks `read:packages`.
