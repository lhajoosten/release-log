# Deterministic technical changelog

`renderChangelog(snapshotJSON, expectedConfiguration, versionConfiguration)` revalidates the captured snapshot and [version decision](release-plan.md), returning a Markdown release section or `null` for no release. `updateChangelog(existingText, renderedSection)` returns updated text without writing files. Callers supply the renderer's output, not arbitrary generated content.

## Rendering contract

The heading is `## vMAJOR.MINOR.PATCH`, without a clock-derived date. Groups follow the accepted order: features, fixes, performance, reverts, refactoring, documentation, build, continuous integration, tests, style, maintenance. Within each group, scopes use code-point comparison, then ascending numeric PR number. Each PR appears once, including internal and nonbumping entries in a releasable batch.

Entries retain scope, context summary, the constructed source PR link, explicit breaking evidence, and nonempty required actions. Internal entries are visibly marked. The selected verbosity controls routine impact/diagnostic detail, never membership, audience, version calculation or validation. The snapshot retains complete impact/context, original titles/commits and validation warnings; the changelog does not turn contribution-format warnings into product-impact claims.

Under the [optional context policy](release-context.md#consumer-context-policy), an ordinary PR without a block uses its conventional title description and scope instead of a context summary. Every mode shows its PR link and a notice that audience and impact are unknown. Breaking entries also retain explicit breaking evidence and visibly flag missing migration instructions. No audience marker or missing context values are invented; original title/body/commits and warnings stay in the snapshot.

Context, title fallback and scope are plain text, not trusted Markdown: whitespace is folded to one space and punctuation/control/Markdown-active characters are emitted as numeric character references. Context cannot inject headings, HTML, image loads, links, code, or owned-section markers. Only source links constructed from validated repository identity are generated. This intentionally does not preserve authored Markdown formatting or paragraph layout. Golden output and Markdown-AST tests check this boundary.

## Format

Trusted configuration may select `changelog.format` as `classic` or `compact`, alongside the required `verbosity` field. Omission retains classic output byte for byte. This repository explicitly selects compact with concise verbosity.

```json
{
  "changelog": {
    "verbosity": "concise",
    "format": "compact"
  }
}
```

Compact puts each authored summary first and keeps its source link, without repeating scope or internal-audience labels. Visible changes retain the existing type-group order and use numeric PR order within groups. Explicitly internal entries appear once under a collapsed `<details>` section titled **Internal maintenance**, ordered by PR number; commit-only and historical entries preserve their real source identity and captured ordering. Unknown audience is never inferred as internal. Nothing is filtered out.

All breaking evidence appears in a visible **Breaking changes** section. Every nonempty authored action appears in a visible **Required actions** section, including actions associated with collapsed internal changes. Breaking entries without migration instructions explicitly flag the missing instructions. These sections cross-reference their source PR/commit; each change still has one primary entry. No existing action is silently discarded or rewritten as a process note.

Detailed verbosity includes available impact and historical diagnostics; concise omits routine detail; one-liner keeps each entry's notices inline. Missing-context notices remain visible. Source text is escaped with the existing rules; only the fixed disclosure tags are emitted as HTML. No AI shortening or inferred reader benefit is introduced.

The selected format participates in configuration/snapshot/proposal identity. Direct replay still requires the exact captured configuration. During a proposal refresh or completed-proposal verification, an explicit format selection permits a presentation-only transition: all other effective settings must match (omitted verbosity means detailed). The old snapshot is replayed and its files/body/identity reconstructed under its original format before a fresh capture renders the selected format. Context policy, verbosity, repository identity, exclusion pins and onboarding boundaries cannot change through this exception. Select explicit `classic` to return to the old layout. Consumers need a compatible pinned tool.

Only pending generated content changes format. Released sections retain their existing bytes and layout.

## Verbosity

Set the optional `changelog` field in trusted version-1 or version-2 release configuration:

```json
{
  "changelog": {
    "verbosity": "concise"
  }
}
```

This is a configuration fragment, not a complete repository configuration. Supported values are exactly:

| Value       | Entry format                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detailed`  | Existing format: summary/source plus nested impact, breaking warnings and required actions. Historical entries include available context and per-entry metadata diagnostics.                                  |
| `concise`   | Summary/source, with nested breaking warnings and required actions only. Historical review warnings are consolidated into the release-level notice; original historical titles and source links remain.       |
| `one-liner` | The same reduced detail, but each change occupies one physical Markdown line. Breaking warnings and required actions stay inline on that line. Group headings and the release-level historical notice remain. |

Omitting `changelog` preserves `detailed` output byte for byte. An explicitly supplied object requires `verbosity` and may additionally select `format`; empty objects, unsupported values, casing/whitespace variants and extra settings fail rather than silently falling back. This repository explicitly selects `concise` with `format: compact` in `release-log.config.json`.

All modes retain every change, source links, audience information through classic markers or compact grouping, and all available breaking/migration instructions. One-liner is a layout choice, **not** automatic text shortening: authored summaries/actions can make a long line. No AI rewrite or inferred impact/action is introduced. Audience filtering is not a verbosity feature. For historical entries without structured context, no mode invents missing migration instructions.

The option is captured in configuration/snapshot identity and generated-file/proposal digests. `render`, `prepare`, proposal refresh and approval verification all use that captured value; there is no unpinned render-only override. Changing verbosity requires a fresh capture and review rather than replaying old inputs under a different configuration. Existing snapshots without the option still replay in detailed mode with this tool; existing input schemas do not change. Older pinned tools may reject the new optional field, so use a compatible pinned tool when opting in.

Only the pending section is replaced when a refreshed proposal changes verbosity. Already released sections, unrelated human content and their original line endings stay untouched.

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
