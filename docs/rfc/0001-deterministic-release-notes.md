# Deterministic release notes from captured evidence

Status: proposed for review in [issue #76](https://github.com/lhajoosten/release-log/issues/76).

## Decision requested

Approve the audience rules, first Markdown layout, and review identity below. The technical changelog remains the complete release record. The notes give readers supported explanations and upgrade instructions, and give maintainers a visible list of evidence gaps to review.

Generate the notes offline by replaying a [release snapshot](../release-snapshot.md) with the expected trusted configuration and deriving the [release plan](../release-plan.md) with explicit version configuration. Follow the plan for release membership, exclusions, version, classification, and breaking status. Read explanatory text and review warnings from the matching normalized snapshot entries. The changelog can omit context by design at lower verbosity settings, so reading it back would lose evidence. The existing `pnpm notes:preview` script is a separate development preview based on a changelog section.

## Markdown

Proposed entry point: `release-log notes` takes the same configuration, snapshot, and version arguments as `render`. A release produces one UTF-8 Markdown artifact on stdout with LF line endings and one final newline. A no-release plan produces empty stdout. Replay, planning, or rendering failure exits nonzero with a diagnostic on stderr and no partial artifact. Maintainers can save the stdout bytes under a path of their choosing.

Use the title `# Release notes for vVERSION`, a visible draft notice, and the binding described below. Emit nonempty sections in this order: **Breaking changes**, **Required actions**, **Improvements**, **Fixes**, **Other changes**, **Needs review**. Keep plan order within each section, following the plan's ordinary, bootstrap, and historical arrays in that order. Include a source reference on every entry, even when a source occurs in multiple sections.

| Evidence                                              | Output                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Valid `users` context                                 | Render the captured summary and impact. Group `feat` and `perf` under improvements, `fix` under fixes, and other types under other changes.                                          |
| Valid `internal` context                              | Suppress summary and impact. Retain breaking evidence and required actions. Retain captured historical review warnings where present.                                                |
| Missing or unusable context admitted by replay        | Put the captured title or subject and the metadata gap in Needs review. Treat audience and impact as unknown. Keep any trusted breaking flag and captured explanation.               |
| Breaking contribution of any audience                 | Render captured breaking explanations. With no explanation, say that the source declares a breaking change and supplies no explanation.                                              |
| Valid nonnull action, or breaking with missing action | Render the supplied action, including for nonbreaking changes. For a breaking entry with no action, flag that migration instructions are missing and direct reviewers to the source. |

Historical and bootstrap entries use real PR or commit identities. A historical entry with usable context follows its declared audience and retains any captured review warnings. A historical user entry without an authoritative type appears under Other changes. Invalid or incomplete raw context admitted historically supplies no summary, impact, or action text. An ordinary malformed context block still fails replay under the existing policy. Verified exclusions follow the plan and produce no entries. If every section is empty, emit “No user-facing changes or required actions were recorded.”

Treat authored text as literal Markdown text, including titles, warnings, and actions. Normalize line breaks and escape markup so authored text cannot add a heading, link, image, HTML, or review metadata. Build links from validated GitHub repository and PR number or full commit SHA. Raw PR descriptions supply neither links nor prose. Context validation checks the format of authored claims. Reviewers still check their accuracy against the captured evidence.

## Review and freshness

Put the full snapshot ID, a Markdown contract revision (`release-notes-v1`), and the resolved version in the artifact. Review the exact artifact bytes. For the first iteration, record the binding and the SHA-256 of those bytes together in the maintainer's review. The snapshot ID identifies all captured evidence, including raw PR text, source and baseline identity, and capture time. Bind the notes independently of proposal identity so generating a draft needs only the existing offline replay inputs.

Before relying on a prior review, replay the snapshot selected for the current release with the current trusted configuration and version inputs, regenerate with the trusted renderer, and compare both the visible binding and the digest of the exact UTF-8 bytes. Any mismatch requires a fresh draft and review. This includes a new capture with an unchanged version or unchanged visible changes, a revised renderer contract, and edited Markdown. Replaying the original inputs can reproduce a past draft. The check establishes agreement with the selected snapshot. Detecting live GitHub changes requires an explicit new collection, and a digest alone confers no approval.

## Worked example

Suppose a captured release contains a user feature (#41), a user fix (#42), an internal breaking PR with an action (#43), an internal nonbreaking PR with an action (#44), a breaking PR admitted under optional context (#45), and an internal maintenance PR with no action or breaking flag (#46).

```markdown
# Release notes for v2.0.0

> Draft for maintainer review.

Snapshot ID: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
Contract: release-notes-v1

## Breaking changes

- The service no longer reads the legacy cache directory. ([#43](https://github.com/example/app/pull/43))
- The source declares a breaking change and supplies no explanation. ([#45](https://github.com/example/app/pull/45))

## Required actions

- Move the cache to the configured data directory before upgrading. ([#43](https://github.com/example/app/pull/43))
- Restart background workers after upgrading. ([#44](https://github.com/example/app/pull/44))
- Migration instructions are missing. Review the linked source. ([#45](https://github.com/example/app/pull/45))

## Improvements

- Export selected rows. You can download just the rows you select. ([#41](https://github.com/example/app/pull/41))

## Fixes

- Resume interrupted exports. Downloads continue from the last checkpoint. ([#42](https://github.com/example/app/pull/42))

## Needs review

- Remove legacy authentication. Audience and impact are unknown because release context is missing. ([#45](https://github.com/example/app/pull/45))
```

In a separate bootstrap draft, an unassociated historical commit could appear in Needs review as follows. The link uses the full captured SHA.

```markdown
- Initialize workspace defaults. Audience and impact are unknown because release context is missing. ([abcdef012345](https://github.com/example/app/commit/abcdef0123456789abcdef0123456789abcdef01))
```

If #43's action changes and the evidence is recaptured for the same version, the new snapshot ID invalidates the previous review. Changing those words directly in the old Markdown also invalidates the review because its byte digest changes.

## Implementation after agreement

Add the offline renderer and CLI entry point, document the command and review procedure, and verify them with synthetic captures. Cover supported historical and current snapshots, the cases above, literal rendering of hostile Markdown, repeated byte-identical output, and stale review after changes to inputs or draft bytes. Keep review manual for this first artifact. Proposal storage, automated approval and publication, AI integration, and the [#77 export schema](https://github.com/lhajoosten/release-log/issues/77) are separate work.
