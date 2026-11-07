# PR release context — version 1

This is the structured PR-description format agreed for the release-context parser. Conventional metadata remains authoritative for change type and breaking declarations; the block supplies human-written explanation, not release membership or version-bump policy.

## Authoring a PR

Include exactly one top-level, explicitly closed code block whose language label is `release-log`. The heading is recommended for readability, not required by the parser.

````markdown
## Release context

```release-log
version: 1
audience: users
summary: Export only the rows you select.
impact: You no longer need to download the entire table and remove unwanted rows.
required_action: null
```
````

| Field             | Required value                                                   |
| ----------------- | ---------------------------------------------------------------- |
| `version`         | The number `1`, not the string `"1"`.                            |
| `audience`        | Exactly `users` or `internal`.                                   |
| `summary`         | Nonempty text explaining what changed.                           |
| `impact`          | Nonempty text explaining its effect.                             |
| `required_action` | Nonempty instructions or an explicit YAML null, normally `null`. |

Use `internal` for changes that belong in the technical changelog but not user-facing notes. The parser preserves internal context; filtering belongs to the later renderer. Do not omit internal changes or invent a user benefit for them.

Do not add a breaking-change override. A conventional `!` header or breaking footer remains the source of that classification. Describe necessary action in `required_action`; use `null` only when there is no required action.

## Parsing rules

- Read the body as CommonMark. Quoted blocks, list-nested blocks, indented examples, HTML comments, and examples inside larger fences are not top-level release context.
- The marker is case-sensitive and takes no extra metadata. Standard backtick or tilde fences and up to three spaces of indentation are supported. A closing fence must use the same character and be at least as long as the opener.
- Parse one YAML 1.2 core-schema mapping with the five required string-named fields. Reject unknown fields, duplicate keys, malformed YAML, unsupported schema versions, custom tags, aliases, anchors, and multiple documents.
- Text fields must be strings containing non-whitespace text. Text is not coerced, trimmed, or rewritten. YAML's quoted and multiline scalar semantics apply.
- `required_action:` with an omitted value is not an explicit null and is invalid. Explicit YAML null spellings such as `null` and `~` are accepted; a quoted `"null"` remains a string.
- Reject descriptions larger than 1 MiB in UTF-8 before parsing. This is a resource boundary, not a per-field writing limit.
- Never execute block contents or expand YAML references. The implementation validates scalar AST nodes without converting the document into an arbitrary JavaScript object.

## Component API and errors

`parseReleaseContext(description)` in `src/release-context.ts` returns a discriminated result:

- Success: `valid: true`, the typed `context`, and `rawBlock` copied from the original Markdown source span. The YAML field `required_action` maps to the TypeScript property `requiredAction`.
- Failure: `valid: false` and an `errors` array with stable codes, actionable messages, and field names where relevant. No partial context is returned.

Unknown fields are reported in sorted order, followed by required-field errors in schema order: version, audience, summary, impact, required action. Repeated input under pinned dependencies produces the same result. Original block text is retained even when Markdown/YAML normalize line endings or scalar syntax for interpretation.

## Scope

The PR template adopts this format for new descriptions. This change does not rewrite historical PRs or add a live PR-body CI gate. The future intake pipeline still needs a policy for historical or missing context; the parser itself reports missing context explicitly.

There are no GitHub calls, AI calls, release filtering, changelog rendering, or provider requirements in this component. Parser success does not prove the factual accuracy or writing quality of a summary. Those remain review responsibilities.

## Verification

`pnpm test` includes real Markdown/YAML cases for extraction, schema validation, failure diagnostics, examples that must not be interpreted, safe handling of references and tags, source preservation, and repeatability. Tests use synthetic descriptions and need no credentials or network access.
