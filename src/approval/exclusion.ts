import { ReleaseApprovalError, invalid, object } from "./validation.ts";
import { parseReleaseApprovalPolicy } from "./policy.ts";
import type { ReleaseApprovalPolicy } from "./policy.ts";
import { createHash } from "node:crypto";
import { inspectPendingRelease } from "../git.ts";
import type { PendingReleaseInspection } from "../git.ts";
import type { GitHubRead } from "../github.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { parseReleaseApproval } from "./record.ts";
import type {
  ReleaseApproval,
  ReleaseExclusionAudit,
  ReleaseExclusionAuthority,
} from "./record.ts";
import { verifyReleaseApproval } from "./verify.ts";

export function parseReleaseExclusionAuthorities(
  value: unknown,
): readonly ReleaseExclusionAuthority[] {
  const envelope = object(value, ["schemaVersion", "approvals"]);

  if (
    envelope.schemaVersion !== 1 ||
    !Array.isArray(envelope.approvals) ||
    envelope.approvals.length < 1 ||
    envelope.approvals.length > 100
  )
    return invalid(
      "Exclusion authority input requires schema 1 and 1–100 independently trusted approval records.",
    );

  const result = envelope.approvals.map((entry: unknown) => {
    const item = object(entry, ["configuration", "policy", "approval"]);

    return {
      configuration: parseReleaseInputConfiguration(item.configuration),
      policy: parseReleaseApprovalPolicy(item.policy),
      approval: parseReleaseApproval(item.approval),
    };
  });

  if (new Set(result.map((record) => record.approval.pullNumber)).size !== result.length)
    return invalid("Exclusion authority records must have unique PR numbers.");

  return result;
}

export async function auditReleaseExclusion(
  request: {
    readonly repository: string;
    readonly configuration: ReleaseInputConfiguration;
    readonly policy: ReleaseApprovalPolicy;
    readonly approval: ReleaseApproval;
    readonly range: PendingReleaseInspection;
    readonly token: string;
  },
  transport: GitHubRead = fetch,
): Promise<ReleaseExclusionAudit> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const policy = parseReleaseApprovalPolicy(request.policy);
  const approval = parseReleaseApproval(request.approval);
  const range = structuredClone(request.range);
  const repository = request.repository;
  const verifiedRange = await inspectPendingRelease(
    repository,
    range.baseline.kind === "tag" ? { kind: "tag", name: range.baseline.name } : range.baseline,
    range.sourceCommitSha,
  );

  if (
    !range.baselineIsAncestor ||
    JSON.stringify(range.baseline) !== JSON.stringify(verifiedRange.baseline) ||
    JSON.stringify(range.commitShas.toSorted()) !== JSON.stringify(verifiedRange.commitShas)
  )
    throw new ReleaseApprovalError(
      "exclusion-invalid",
      "The supplied audit range differs from actual immutable Git membership.",
    );

  if (verifiedRange.commitShas.length > 1000)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Exclusion audit supports at most 1000 range commits; history is never truncated.",
    );

  await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: approval.landingSha },
    verifiedRange.sourceCommitSha,
  );

  const verified = await verifyReleaseApproval(
    { repository, configuration: config, policy, approval, token: request.token },
    transport,
  );
  const members = new Set(verifiedRange.commitShas);
  const excludedCommitShas = verified.automationCommitShas.filter((commitSha) =>
    members.has(commitSha),
  );

  if (
    excludedCommitShas.length !== 0 &&
    excludedCommitShas.length !== verified.automationCommitShas.length
  )
    throw new ReleaseApprovalError(
      "exclusion-invalid",
      "The captured range crosses a verified release footprint; select a complete boundary rather than hiding partial membership.",
    );

  const excluded = new Set(excludedCommitShas);
  const result = {
    schemaVersion: 1 as const,
    repository: config.repository,
    releaseBranch: config.releaseBranch,
    range: verifiedRange,
    approvalVerificationId: verified.verificationId,
    pullNumber: approval.pullNumber,
    landingSha: approval.landingSha,
    excludedCommitShas,
    retainedCommitShas: verifiedRange.commitShas.filter((commitSha) => !excluded.has(commitSha)),
  };

  return { ...result, auditId: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
