import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { PendingReleaseInspection, ResolvedReleaseBaseline } from "./git.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export class ReleaseApprovalError extends Error {
  readonly code:
    | "approval-invalid"
    | "identity-mismatch"
    | "stale-source"
    | "baseline-mismatch"
    | "content-mismatch"
    | "unsupported-merge"
    | "exclusion-invalid"
    | "resource-limit";
  constructor(code: ReleaseApprovalError["code"], message: string) {
    super(message);
    this.name = "ReleaseApprovalError";
    this.code = code;
  }
}
export interface ReleaseApprovalPolicy {
  readonly schemaVersion: 1;
  readonly botUserId: number;
  readonly approverUserIds: readonly number[];
}
export interface ReleaseApproval {
  readonly schemaVersion: 1;
  readonly repositoryId: number;
  readonly pullNumber: number;
  readonly approverUserId: number;
  readonly sourceSha: string;
  readonly headSha: string;
  readonly landingSha: string;
  readonly mergeKind: "merge" | "squash";
  readonly baseline: ResolvedReleaseBaseline;
  readonly snapshotId: string;
  readonly proposalId: string;
}

export interface ReleaseReviewTarget {
  readonly schemaVersion: 1;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly approverUserId: number;
}

export interface ReleaseReview extends ReleaseReviewTarget {
  readonly repositoryId: number;
  readonly sourceSha: string;
  readonly baseline: ResolvedReleaseBaseline;
  readonly snapshotId: string;
  readonly proposalId: string;
  readonly configurationId: string;
  readonly policyId: string;
}

export interface ReleaseMergeAttestation extends ReleaseReviewTarget {
  readonly repositoryId: number;
  readonly landingSha: string;
  readonly mergeKind: "merge" | "squash";
}

export interface VerifiedReleaseApproval extends ReleaseApproval {
  readonly releaseBranch: string;
  readonly version: string;
  readonly configurationId: string;
  readonly policyId: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly verificationId: string;
  readonly automationCommitShas: readonly string[];
  readonly pull: { readonly title: string; readonly body: string; readonly botUserId: number };
}

export interface ReleaseExclusionAuthority {
  readonly configuration: ReleaseInputConfiguration;
  readonly policy: ReleaseApprovalPolicy;
  readonly approval: ReleaseApproval;
}

export interface ReleaseExclusionAudit {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly releaseBranch: string;
  readonly range: PendingReleaseInspection;
  readonly approvalVerificationId: string;
  readonly pullNumber: number;
  readonly landingSha: string;
  readonly excludedCommitShas: readonly string[];
  readonly retainedCommitShas: readonly string[];
  readonly auditId: string;
}
export function invalid(message: string): never {
  throw new ReleaseApprovalError("approval-invalid", message);
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return invalid("Approval records/policies require exactly the supported schema fields.");
  return Object.fromEntries(Object.entries(value));
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid("Approval identities require positive safe integer IDs.");
  return value;
}
function sha(value: unknown, digest = false): string {
  if (
    typeof value !== "string" ||
    !(digest ? /^[a-f0-9]{64}$/u : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).test(value)
  )
    return invalid("Approval records require full lowercase object IDs and SHA-256 digests.");
  return value;
}
function baseline(value: unknown): ResolvedReleaseBaseline {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return invalid("An explicit approved baseline is required.");
  if (value.kind === "bootstrap") {
    const item = object(value, ["kind", "commitSha"]);
    return { kind: "bootstrap", commitSha: sha(item.commitSha) };
  }
  const item = object(value, ["kind", "name", "objectSha", "commitSha"]);
  if (
    item.kind !== "tag" ||
    typeof item.name !== "string" ||
    item.name.length > 128 ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(item.name)
  )
    return invalid("Approved release tags require stable vMAJOR.MINOR.PATCH names.");
  return {
    kind: "tag",
    name: item.name,
    objectSha: sha(item.objectSha),
    commitSha: sha(item.commitSha),
  };
}
export function parseReleaseApprovalJSON(serialized: string): unknown {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 1024 * 1024)
    return invalid("Approval JSON must be bounded to 1 MiB UTF-8.");
  try {
    const value: unknown = JSON.parse(serialized);
    if (parseDocument(serialized, { uniqueKeys: true, strict: true, version: "1.2" }).errors.length)
      return invalid("Approval JSON must not repeat property names.");
    return value;
  } catch {
    return invalid("Approval JSON must be valid and must not repeat property names.");
  }
}

export function parseReleaseApprovalPolicy(value: unknown): ReleaseApprovalPolicy {
  const item = object(value, ["schemaVersion", "botUserId", "approverUserIds"]);
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.approverUserIds) ||
    item.approverUserIds.length < 1 ||
    item.approverUserIds.length > 1000
  )
    return invalid(
      "Configure schemaVersion 1 and an explicit nonempty bounded list of human approver IDs.",
    );
  const botUserId = positive(item.botUserId);
  const approverUserIds = item.approverUserIds.map(positive).toSorted((a, b) => a - b);
  if (
    new Set(approverUserIds).size !== approverUserIds.length ||
    approverUserIds.includes(botUserId)
  )
    return invalid("Human approvers must be unique and must not include the automation bot.");
  return { schemaVersion: 1, botUserId, approverUserIds };
}

export function parseReleaseReviewTarget(value: unknown): ReleaseReviewTarget {
  const item = object(value, ["schemaVersion", "pullNumber", "headSha", "approverUserId"]);

  if (item.schemaVersion !== 1) return invalid("Unsupported release review target schema.");

  return {
    schemaVersion: 1,
    pullNumber: positive(item.pullNumber),
    headSha: sha(item.headSha),
    approverUserId: positive(item.approverUserId),
  };
}

export function parseReleaseReview(value: unknown): ReleaseReview {
  const item = object(value, [
    "schemaVersion",
    "pullNumber",
    "headSha",
    "approverUserId",
    "repositoryId",
    "sourceSha",
    "baseline",
    "snapshotId",
    "proposalId",
    "configurationId",
    "policyId",
  ]);
  const target = parseReleaseReviewTarget({
    schemaVersion: item.schemaVersion,
    pullNumber: item.pullNumber,
    headSha: item.headSha,
    approverUserId: item.approverUserId,
  });

  return {
    ...target,
    repositoryId: positive(item.repositoryId),
    sourceSha: sha(item.sourceSha),
    baseline: baseline(item.baseline),
    snapshotId: sha(item.snapshotId, true),
    proposalId: sha(item.proposalId, true),
    configurationId: sha(item.configurationId, true),
    policyId: sha(item.policyId, true),
  };
}

function mergeKind(value: unknown): "merge" | "squash" {
  if (value !== "merge" && value !== "squash")
    throw new ReleaseApprovalError(
      "unsupported-merge",
      "A trusted merge/squash method record is required; rebase or an inferred merge strategy is unsupported.",
    );

  return value;
}

export function parseReleaseMergeAttestation(value: unknown): ReleaseMergeAttestation {
  const item = object(value, [
    "schemaVersion",
    "pullNumber",
    "headSha",
    "approverUserId",
    "repositoryId",
    "landingSha",
    "mergeKind",
  ]);
  const target = parseReleaseReviewTarget({
    schemaVersion: item.schemaVersion,
    pullNumber: item.pullNumber,
    headSha: item.headSha,
    approverUserId: item.approverUserId,
  });

  return {
    ...target,
    repositoryId: positive(item.repositoryId),
    landingSha: sha(item.landingSha),
    mergeKind: mergeKind(item.mergeKind),
  };
}

export function parseReleaseApproval(value: unknown): ReleaseApproval {
  const item = object(value, [
    "schemaVersion",
    "repositoryId",
    "pullNumber",
    "approverUserId",
    "sourceSha",
    "headSha",
    "landingSha",
    "mergeKind",
    "baseline",
    "snapshotId",
    "proposalId",
  ]);
  if (item.schemaVersion !== 1)
    return invalid(
      "Unsupported release approval schema; no migration or inferred approval is performed.",
    );
  const method = mergeKind(item.mergeKind);

  return {
    schemaVersion: 1,
    repositoryId: positive(item.repositoryId),
    pullNumber: positive(item.pullNumber),
    approverUserId: positive(item.approverUserId),
    sourceSha: sha(item.sourceSha),
    headSha: sha(item.headSha),
    landingSha: sha(item.landingSha),
    mergeKind: method,
    baseline: baseline(item.baseline),
    snapshotId: sha(item.snapshotId, true),
    proposalId: sha(item.proposalId, true),
  };
}

export function parseVerifiedReleaseApproval(value: unknown): VerifiedReleaseApproval {
  const item = object(value, [
    "schemaVersion",
    "repositoryId",
    "pullNumber",
    "approverUserId",
    "sourceSha",
    "headSha",
    "landingSha",
    "mergeKind",
    "baseline",
    "snapshotId",
    "proposalId",
    "releaseBranch",
    "version",
    "configurationId",
    "policyId",
    "files",
    "pull",
    "automationCommitShas",
    "verificationId",
  ]);
  const approval = parseReleaseApproval(
    Object.fromEntries(
      [
        "schemaVersion",
        "repositoryId",
        "pullNumber",
        "approverUserId",
        "sourceSha",
        "headSha",
        "landingSha",
        "mergeKind",
        "baseline",
        "snapshotId",
        "proposalId",
      ].map((key) => [key, item[key]]),
    ),
  );

  if (
    typeof item.releaseBranch !== "string" ||
    !item.releaseBranch.trim() ||
    item.releaseBranch.length > 1024 ||
    /[\0\r\n]/u.test(item.releaseBranch) ||
    typeof item.version !== "string" ||
    item.version.length > 128 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(item.version) ||
    !Array.isArray(item.files) ||
    item.files.length < 2 ||
    item.files.length > 4 ||
    !Array.isArray(item.automationCommitShas) ||
    item.automationCommitShas.length < 1 ||
    item.automationCommitShas.length > 101
  )
    return invalid(
      "Verification evidence requires bounded branch/version/files and complete generated commit IDs.",
    );

  const files = item.files.map((entry: unknown) => {
    const file = object(entry, ["path", "sha256"]);

    if (
      typeof file.path !== "string" ||
      !["package.json", "pyproject.toml", "CHANGELOG.md", ".release-log/inputs.json"].includes(
        file.path,
      )
    )
      return invalid("Verification evidence contains an unsupported output path.");

    return { path: file.path, sha256: sha(file.sha256, true) };
  });
  const automationCommitShas = item.automationCommitShas.map((entry: unknown) => sha(entry));
  const pull = object(item.pull, ["title", "body", "botUserId"]);

  if (
    typeof pull.title !== "string" ||
    Buffer.byteLength(pull.title, "utf8") > 1024 ||
    typeof pull.body !== "string" ||
    Buffer.byteLength(pull.body, "utf8") > 1024 * 1024 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    new Set(automationCommitShas).size !== automationCommitShas.length ||
    JSON.stringify(automationCommitShas) !== JSON.stringify(automationCommitShas.toSorted()) ||
    !automationCommitShas.includes(approval.landingSha)
  )
    return invalid(
      "Verification evidence has incomplete or duplicated metadata, files or footprint IDs.",
    );

  const result = {
    ...approval,
    releaseBranch: item.releaseBranch,
    version: item.version,
    configurationId: sha(item.configurationId, true),
    policyId: sha(item.policyId, true),
    files,
    pull: { title: pull.title, body: pull.body, botUserId: positive(pull.botUserId) },
    automationCommitShas,
  };
  const verificationId = createHash("sha256").update(JSON.stringify(result)).digest("hex");

  if (sha(item.verificationId, true) !== verificationId)
    return invalid("Verification evidence does not match its pinned digest.");

  return { ...result, verificationId };
}
