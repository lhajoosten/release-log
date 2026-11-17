# Concise changelogs and a latest container alias

Status: accepted, 2026-11-17. Partially supersedes [ADR 0001](0001-container-distribution.md) on moving aliases and writer serialization.

## Decision

Keep the recorded capture date in enriched version headings and the complete timestamp in snapshots. Omit the capture-time paragraph from newly rendered Markdown. Explicit historical backfill adds dates, contributor credits, section icons and adjacent-tag comparisons throughout this repository's released history, preserving authored prose, warnings and source links. Generated capture-time and fallback-provenance paragraphs are removed from the rendered historical sections; fallback dates still come from verified immutable Git tags, and the fallback rules remain documented.

Continue to reconstruct existing proposals with their explicitly trusted original producer SHA and dependencies. A renderer change must not replace old proposal bytes during verification or relabel their snapshots. Deploy the new renderer through a reviewed immutable caller pin before refreshing the open proposal; normal refresh continues to preserve released history. Backfill is a separate explicit source change, not implicit historical regeneration on every release.

After an immutable stable container image has passed the existing source, smoke, scan and digest checks, promote the same manifest bytes to `ghcr.io/lhajoosten/release-log:latest`. Read back the alias to verify its digest. Do not rebuild or create a multi-platform index for this alias. Keep version tags and digest references unchanged.

Compare stable semantic versions before promotion. Retain a newer latest image when an older event arrives late, reuse a matching digest without writing, and fail on equal-version conflicts or invalid metadata. Serialize all version and alias writers in one repository workflow group. GHCR has no compare-and-swap for independent external tag writers; the workflow remains the sole designated writer.

Alias failure does not undo a successful version publication. A retry reuses, tests and scans the retained version image before repairing the alias. Credentials remain step-local; no extra registry credentials, platforms, major/minor aliases or historical tag changes are introduced. No live alias publication is performed while implementing this decision.

The consumer example enables compact formatting and optional GitHub Release publication while retaining `write: false`, explicit consumer identity/onboarding placeholders and guidance for trusted predecessor runtimes. Release-log self-upgrades remain reserved for its own repository identity.

## Consequences

Readers get concise, consistently formatted changelogs and a convenient mutable image reference. Automation can continue to pin immutable digests. Existing captured evidence and producer verification remain strict. A normal merge must retain an implementation commit referenced by a caller-pin commit in the same PR; squash/rebase would drop that ancestry and intentionally fail the source-admission guard. The referenced implementation must pass CI and receive human review before activation.
