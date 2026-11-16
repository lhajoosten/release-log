# Release PR tool upgrades and GitHub Releases

Status: accepted for implementation, 2026-11-16. Activation requires a separate reviewed caller-pin change after this implementation has an immutable revision and successful CI.

## Context

This repository uses a source-pinned reusable release workflow. Its open release PR was produced by tool version `0.0.0`, while the current source declares `0.2.1`. Ordinary replay deliberately rejects that version mismatch even when the dependency lock and normalization identity match. A tool upgrade must retain verification of existing proposals and release history without rewriting captured evidence.

The release source SHA exists before review; the eventual release-PR landing cannot be embedded in that same PR. The runner tool version and the consumer version being proposed are separate identities. Git tags alone also do not create GitHub Releases or a latest-release entry.

## Decision

Explicit `selfUpgrade: true` is supported only for repository `lhajoosten/release-log`, ID `1449550207`. Its release PR proposes the captured source SHA in exactly the two existing `jobs.release` caller pins. YAML structure is inspected, but only the scalar bytes change. Both old pins must already be full, matching immutable SHAs. Comments, permissions and other workflow bytes are preserved.

Admit a candidate only when it contains the active producer in Git ancestry, is the current release-branch tip, is the exact landing of a human-merged PR to main, and has a completed successful latest main-push Quality run for that exact SHA. A queued, absent or failed run stops reconciliation; retry the original merge workflow after Quality succeeds. The same admission checks run before proposal writes. This gate applies to self-upgrades, not ordinary consumers.

New workflow-generated proposal identities record the active producer SHA. A trusted runtime registry supplies separate installed producer modules for reconstruction. Each producer replays its original snapshot, prepares its files and reconstructs its proposal identity with its own package manifest and frozen dependency lock. Unknown recorded SHAs fail closed. Unrecorded predecessor snapshots require explicit `legacy: true` authority for a pinned runtime; only a normalizer mismatch permits trying another explicitly trusted legacy runtime. Integrity or configuration failures are never repaired or recaptured.

The reusable workflow installs these producers before minting App credentials. In self-use it also retains the predecessor pins found in the reviewed active tool checkout and its reviewed predecessor checkouts. It never derives executable revisions from consumer source, PR text, snapshots or markers. Explicit legacy pins terminate that ancestry walk. Installation and the registry are bounded to twenty producers; exceeding this bound requires reviewed retention decisions. Administrator-supplied local registry directories are executable authority, not untrusted data.

`githubRelease: true` separately opts into GitHub Release publication after tag verification/creation. Publish only the verified version's generated changelog section, with no AI, generated GitHub notes or assets. Create a published stable release, requesting latest unless a newer stable release is already latest. Reuse an existing published stable release for the tag without editing its notes, title or latest selection. Drafts, prereleases and inconsistent identities require recovery. A partial tag-only run is recoverable through the original tag handler; it blocks the next cycle until its GitHub Release exists.

The App needs Actions read and Workflows write for self-upgrade evidence and workflow edits, in addition to the existing Contents/PR write permissions. GitHub Release creation uses Contents write. No additional default `GITHUB_TOKEN` permissions are requested. Human review and merge remain required.

## Alternatives and consequences

Accepting arbitrary old version strings with a matching normalizer would lose source/runtime provenance. Recomputing old snapshots under current rules would change their IDs or rendered history. Using explicitly installed pinned producers retains the original checks across package-version, dependency-lock and renderer changes, at the cost of additional bounded installation time.

An updater PR for every tool change would split the review lifecycle. Capturing the source SHA instead lets the ordinary release PR carry the pin changes. The chosen tool source precedes the release-PR merge; it intentionally differs from the exact landing used for the version tag.

Release creation and tag creation are separate API operations. A release failure leaves the exact tag intact, and retries inspect published state before writing. Latest selection is serialized by the rolling workflow; GitHub provides no compare-and-swap against independent external latest-release writers. Existing manual releases are preserved. Historical backfill, live activation, merges, tag changes and release writes are not performed by implementing this decision.

See [bootstrap and recovery](../release-workflow.md#self-upgrades-and-github-releases).
