# Verified automation in captured release inputs

Collection can retain a verified release PR's complete raw graph while excluding its generated changes from product release entries. This connects the [approval/exclusion audit](release-approval.md) to collection, offline replay, planning and rendering. It does not mark a release published, select a new baseline or enable controller writes. This separate approval-backed API is not required by the [rolling-release workflow](release-workflow.md), which starts each subsequent range at a verified release tag.

## Trust boundary

A bot name, branch, PR title, self-reported success flag or arbitrary commit allowlist grants no exemption. Two independently trusted inputs are required:

1. The current release configuration pins exact verification IDs for named PRs in optional `automationExclusions`.
2. A separate authority file supplies the original release configuration, human/bot policy and approval record for each pinned PR. Collection reruns full approval verification against actual Git/GitHub data before and after association collection.

Store both outside proposal control, using trusted pinned tool code. Never copy pins or authority records from an untrusted PR, artifact or snapshot and treat them as authorization. A matching checksum proves consistency with the expected pin, not who approved that pin. Host authentication/protected storage remain required before live automation.

## Configure and collect

First audit/verify the approved release using its **original** trusted configuration and policy, as described in the [approval guide](release-approval.md). Verification evidence now also binds the exact generated PR title/body and numeric bot ID. Recompute older cached verification IDs rather than relabeling them.

Add pins to the current trusted configuration. This is a fragment; the example digest must be replaced with the actual `approvalVerificationId` from the audit, not its `auditId`:

```json
{
  "automationExclusions": [
    {
      "pullNumber": 123,
      "verificationId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

Both configuration versions 1 and 2 support this optional field. Pins are sorted by PR number, bounded to 100, and must have unique positive PR numbers and complete unique lowercase SHA-256 IDs. Omit the field when no exclusions are authorized; an empty list is rejected.

The separately trusted authority file is a schema-1 JSON object containing `approvals`, a nonempty array of at most 100 records. Each record has exactly `configuration`, `policy`, and `approval`, using the existing strict configuration/approval schemas. `configuration` is the original configuration against which that release was approved, not the new configuration containing its pin. PR numbers must be unique. The CLI bounds the file to 1 MiB and rejects duplicate JSON keys.

```sh
release-log collect --config current-release-config.json --exclusions trusted-approvals.json --repository . --source FULL_SOURCE_SHA --baseline-tag v1.2.3
```

For initial collection use the configured `--bootstrap-sha` instead of a tag, retaining the fixed onboarding contract. `collect` requires both the pin list and the authority file, or neither. Pin/record discrepancies fail rather than silently treating bot changes as ordinary or excluded. The library's `collectMergedPullRequests()` accepts the parsed authority records as optional `automation` and returns `verifiedAutomation` alongside all raw PR/commit evidence.

Every authority is freshly verified. The normal association checks still apply: complete mapping/pagination, one owner per landed commit, exact footprints, no partial boundaries and final metadata checks. A release PR must match the verified repository, bot, branches, head, landing, title/body and full generated commit footprint. Verification and collection share the 2000-request/five-minute HTTP budget; individual Git/API/blob limits remain. There are no hidden retries or partial-success results.

## Offline capture and replay

With exclusion pins, legacy snapshots use **schema 4**, with a separate exclusion normalizer identity. New online captures use [schema 5](release-snapshot.md#capture-metadata-schema-5), retaining that exclusion contract alongside capture time and PR-author evidence. The raw `input` retains all PRs, landed/original commit evidence, the original full range and explicit `verifiedAutomation` evidence. Nothing is removed from Git membership to make a disconnected graph look complete.

Capture/replay strictly parse each verification record, recompute its verification digest, match it to the independently supplied configuration pins, and validate the raw PR identity/metadata/footprint against it. Unknown fields, forged output flags, changed evidence, missing records, changed pins and partial footprints fail. Validation never substitutes the snapshot's own configuration for the caller's trusted expected configuration.

`normalized.excludedPullRequests` records the verified automation PR number/source URL, verification ID and commit IDs. These PRs do not enter normal product contributions or rendered changelog entries. All ordinary changes stay eligible, including legitimate edits to version/changelog paths. A schema-4 or schema-5 plan exposes the same evidence as `excludedContributions`.

```sh
release-log plan --config current-release-config.json --snapshot inputs.json --current-version 1.2.3
release-log render --config current-release-config.json --snapshot inputs.json --current-version 1.2.3
```

Offline commands need neither the authority file nor credentials/network: the captured proof is checked against the separately trusted pins. They do not reauthenticate the host, prove publication or replace a fresh verification immediately before an authorized remote mutation.

Legacy configurations without exclusion pins retain schema-3 replay with the existing normalizer and byte format. New online captures use schema 5 with or without pins. There is no silent format upgrade, relabeling or automatic migration of old inputs. Exclusion-enabled snapshots require a compatible pinned tool and trusted configuration; their full JSON envelope remains bounded to 16 MiB.

## Completed cycles and remaining gates

For the accepted rolling workflow, the exact version tag establishes the release boundary; downstream artifact publication is independent. These exclusion APIs do not choose or advance that boundary. Callers of the separate receipt-based publication API must interpret its `complete` result relative to their own explicitly configured outputs, rather than impose that completion model on the rolling workflow. With a real completed tag at the landing, later ranges naturally omit its entire ancestry; an empty next-cycle range remains no-release, and later ordinary changes remain eligible. Retained historical pins do not create product entries when the verified footprint is wholly outside the range.

The rolling controller has [subsequent-cycle live evidence](release-workflow.md#live-evidence-and-remaining-validation). Authenticated host records/check enforcement and live race/publication exercises for this separate approval-backed path remain unverified. This feature does not create credentials, change settings, activate a workflow, merge release proposals, tag or publish a Release/image. Unit/integration tests use real temporary Git plus replaced HTTP; that is not a live publication proof.
