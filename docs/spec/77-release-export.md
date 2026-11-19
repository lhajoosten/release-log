# Version 1 release export proposal

This contract is proposed for review under [#77](https://github.com/lhajoosten/release-log/issues/77). A downstream tool should be able to consume a local JSON document without reconstructing release membership from Git or parsing a changelog. The export is a projection of reviewed release evidence. Release planning, membership and version selection retain their existing authority.

## Document shape

A document contains one GitHub.com repository and one explicitly selected audience. The example shows a public export of a verified tagged release with no recorded tag timestamp.

```json
{
  "schemaVersion": 1,
  "repositoryId": 17,
  "audience": "public",
  "releases": [
    {
      "id": "github:17:release:1.2.3",
      "version": "1.2.3",
      "state": "tagged",
      "baseline": {
        "kind": "bootstrap",
        "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "tag": null
      },
      "sourceSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "tag": {
        "name": "v1.2.3",
        "targetSha": "cccccccccccccccccccccccccccccccccccccccc"
      },
      "taggedAt": null,
      "publication": null,
      "entries": [
        {
          "id": "github:17:pr:42",
          "source": { "kind": "pull-request", "number": 42 },
          "audience": "users",
          "breaking": false,
          "summary": "Export reviewed release entries as JSON.",
          "impact": "Automation can consume entries directly.",
          "requiredAction": null
        }
      ]
    }
  ]
}
```

- Repository IDs and PR numbers are positive safe integers. Versions use the existing stable version policy and tag names use its canonical `v` prefix. SHA fields hold full lowercase Git object IDs for the repository's object format.
- The baseline is either `bootstrap` with a null tag, or `tag` with its verified previous tag name and peeled commit. The source is the captured upper membership boundary. The tag target is the verified release commit, which can differ from the membership source.
- Release IDs use repository ID and version because the stable version tag occupies the repository-wide namespace. An entry ID is `github:<repositoryId>:pr:<number>` for an associated PR or `github:<repositoryId>:commit:<sha>` for an unassociated historical commit. The latter uses source `{"kind":"commit","sha":"<sha>"}`. IDs survive repository renames and proposal refreshes. Scope a rendered entry occurrence to its release ID as well as its entry ID.
- Source references are structured locators. A consumer can construct GitHub.com PR, commit and tag links using a trusted current repository slug. A published record also carries the GitHub Release ID for lookup. The document carries no URLs supplied by PR authors or derived from prose.

## Admission, state and time

Supply exact reviewed artifacts and any state evidence locally. Verify the binding between repository, version, reviewed head or landing, baseline, source and recorded state before projecting entries. Snapshot replay validates capture consistency. Review must be established separately through the existing verified review/landing path or equivalent independently trusted records for the exact release. A current PR body, a snapshot digest alone, a checkout's current version, and an arbitrary tag name are insufficient. History with insufficient review evidence is outside v1. Fail the export for any supplied release that cannot be validated, with a diagnostic identifying the affected evidence.

| State       | Required evidence                                                                                   | Fields                                       |
| ----------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `proposed`  | Reviewed release proposal at the exact captured head, with no verified tag in the supplied evidence | `tag`, `taggedAt` and `publication` are null |
| `tagged`    | Verified matching stable tag and peeled release target                                              | `tag` is present and `publication` is null   |
| `published` | Verified tag plus trusted observation of a matching non-draft, stable GitHub Release                | `tag` and `publication` are present          |

State describes the strongest matching evidence supplied for this generation. A draft GitHub Release leaves a verified tag in the tagged state. Registry and image publication remain separate events. Conflicting supplied evidence fails validation. Consumers tracking lifecycle progression must retain the latest trusted state evidence when regenerating.

- `taggedAt` uses the tagger timestamp of the verified annotated version tag, converted to UTC. A lightweight tag or missing timestamp yields null. The timestamp records tag-object metadata, which can predate when the ref became visible remotely.
- `publication` contains `githubReleaseId` (a positive safe integer) and `publishedAt` from the trusted GitHub Release observation, normalized to UTC, or null for unavailable time. A non-null timestamp in either field is an ISO 8601 UTC string with milliseconds. Invalid supplied timestamps fail validation.
- Capture time and commit timestamps never substitute for either field. There is no generation timestamp. State checks can run offline on retained trusted inputs and describe those inputs as observed, without claiming live freshness.

Only explicit pending opt-in includes a reviewed proposal. The default export includes tagged and published releases. Integrations selecting releases announced through GitHub Releases must filter on `state === "published"`.

## Audience and text

Require an explicit `public` or `internal` audience when exporting. A public document includes only entries with captured valid context explicitly classified as `users`. An internal document can also include `internal` entries and entries without valid context. The latter use null audience, summary, impact and required action, preserving source identity and the validated breaking flag. Valid context contributes its summary, impact and required action. Breaking classification comes from reviewed normalized evidence.

If public projection would conceal a breaking entry or a nonempty required action, fail the public export. The reviewed record needs a publicly eligible entry for that change before it can be exported publicly. This also covers historical entries with recorded breaking evidence and missing context. Ordinary excluded entries contribute no text, identifiers or counts to public output. The repository and release boundaries remain visible, so a maintainer must separately decide whether those references are appropriate for the intended destination.

The input fields are an allowlist. Raw PR descriptions, commit messages, contributor identities and review evidence stay in their existing artifacts. Serialize text as JSON strings, preserving literal text such as markup or link syntax. Serve the file as standalone `application/json` if publishing it. A downstream HTML consumer must insert text as text nodes or escape it for the destination context, including when embedding JSON inside HTML.

## Reproducibility and implementation acceptance

- Serialize UTF-8 with two-space indentation, a final newline and fixed key order as shown. Emit empty arrays for empty history and empty projected releases. Sort releases by descending numeric major, minor and patch. Sort entries by ascending ID in ASCII order.
- Coalesce byte-equivalent validated release rows by release ID. Fail duplicate release IDs with conflicting projected rows or conflicting reviewed evidence. Reject duplicate entry IDs within a release. Generate a full replacement document from the selected evidence. Consumers upsert by ID instead of appending. Proposal refresh or matching reviewed promotion updates the same release ID on regeneration.
- An implementation PR must exercise the public API and packed CLI with captured fixture history, supported review evidence, repeated and shuffled inputs, conflicting evidence, all states, missing and invalid timestamps, empty results, mixed audiences, hidden safety information and literal markup. A local export must work without a network request or AI credentials.
- A consumption example should read the standalone JSON, select published rows if needed and render escaped entry text. A maintainer can publish the generated JSON as a static file in their own hosting pipeline.

The first implementation depends on agreement on this contract and identification of concrete local review and publication records that satisfy admission. Command syntax, adapters and fixtures belong to that implementation. Reviewed user-facing notes and their integration belong to [#76](https://github.com/lhajoosten/release-log/issues/76). Reader-facing formats and feed design remain follow-up work under #77. Hosted delivery and publication mutations are outside this slice.
