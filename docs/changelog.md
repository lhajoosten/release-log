# Deterministic technical changelog

`renderChangelog(snapshotJSON, expectedConfiguration, versionConfiguration)` revalidates the captured snapshot and [version decision](release-plan.md), returning a Markdown release section or `null` for no release. `updateChangelog(existingText, renderedSection)` returns updated text without writing files. Callers supply the renderer's output, not arbitrary generated content.

## Rendering contract

The heading is `## vMAJOR.MINOR.PATCH`, without a clock-derived date. Groups follow the accepted order: features, fixes, performance, reverts, refactoring, documentation, build, continuous integration, tests, style, maintenance. Within each group, scopes use code-point comparison, then ascending numeric PR number. Each PR appears once, including internal and nonbumping entries in a releasable batch.

Entries retain scope, context summary, impact, the constructed source PR link, explicit breaking evidence, and nonempty required actions. Internal entries are visibly marked. The snapshot retains original titles/commits and validation warnings; the changelog does not turn contribution-format warnings into product-impact claims.

Context and scope are plain text, not trusted Markdown: whitespace is folded to one space and punctuation/control/Markdown-active characters are emitted as numeric character references. Context cannot inject headings, HTML, image loads, links, code, or owned-section markers. Only source links constructed from validated repository identity are generated. This intentionally does not preserve authored Markdown formatting or paragraph layout. Golden output and Markdown-AST tests check this boundary.

## Owned pending section

A generated section has exactly one pair of top-level comment boundaries:

```text
<!-- release-log:pending:v1 sha256:CONTENT_DIGEST -->

## v1.3.0

...rendered entries...

<!-- release-log:pending:end -->
```

The digest is SHA-256 of the exact rendered content, including its final newline. Regeneration verifies the existing digest before replacing only this block. It does not append another pending entry. Human edits inside it, unsupported/duplicate/reversed markers, reserved markers in fenced/nested content, or malformed framing fail with recovery instructions. The `release-log` comment namespace is reserved throughout the file. The checksum is an edit detector, not authentication against someone who recomputes it.

With no block, insert before the first top-level H2 (normally the first released version), preserving the preamble and all existing content. With no H2, append after the existing preamble. An empty file receives `# Changelog` and the pending block. Outside the block, existing bytes and line endings are retained; inserted boundaries and owned content use LF. Repeated updates are byte-identical.

A no-release update leaves a file with no pending block unchanged. If a pending block already exists, no-release is a conflict for explicit review, not permission to delete a proposal silently. This module does not finalize released sections after publication; that lifecycle belongs to the controller/publication contract.

Existing text, rendered sections, and final files are bounded to 16 MiB UTF-8. APIs only transform strings: filesystem path validation, symlinks, atomic writes, version-file adapters, and remote concurrency are caller responsibilities. No AI, GitHub calls, or publication is performed.
