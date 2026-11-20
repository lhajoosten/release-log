import { ReleaseApprovalError } from "./validation.ts";
import { parseReleaseApprovalPolicy } from "./policy.ts";
import type { ReleaseApprovalPolicy } from "./policy.ts";
import { createHash } from "node:crypto";
import { inspectPendingRelease } from "../git.ts";
import { GitHubProposalRepository } from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { verifyPrevious } from "../proposal/verification.ts";
import { selectReleaseCycle } from "../cycle/select.ts";
import { requireSameReadiness, verifyReleaseReadiness } from "../release-readiness.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import {
  parseReleaseApproval,
  parseReleaseReviewTarget,
  parseReleaseReview,
  parseReleaseMergeAttestation,
} from "./record.ts";
import type {
  ReleaseApproval,
  ReleaseReviewTarget,
  ReleaseReview,
  ReleaseMergeAttestation,
} from "./record.ts";
import { readLocalProposalTree, readProposalContents, verifyProposalHistory } from "./history.ts";
import { verifyReleaseApproval } from "./verify.ts";

export async function captureReleaseReview(
  request: {
    readonly repository: string;
    readonly configuration: ReleaseInputConfiguration;
    readonly policy: ReleaseApprovalPolicy;
    readonly target: ReleaseReviewTarget;
    readonly token: string;
  },
  transport: GitHubRead = fetch,
): Promise<ReleaseReview> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const policy = parseReleaseApprovalPolicy(request.policy);
  const target = parseReleaseReviewTarget(request.target);
  const repository = request.repository;
  const token = request.token;

  if (!policy.approverUserIds.includes(target.approverUserId))
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The review actor is not an allowed human approver.",
    );

  const api = new GitHubProposalRepository(config, policy.botUserId, token, transport);

  await api.verifyRepository();

  const pull = await api.readPull(target.pullNumber);

  if (
    pull.number !== target.pullNumber ||
    pull.state !== "open" ||
    pull.merged ||
    pull.headSha !== target.headSha
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Review capture requires the exact intended open PR head before merge.",
    );

  const readiness = await verifyReleaseReadiness(api, config, policy, target);
  const head = await readLocalProposalTree(repository, target.headSha);
  const files = await readProposalContents(repository, head, config.selfUpgrade === true);
  const snapshotJSON = files[".release-log/inputs.json"];

  if (snapshotJSON === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The reviewed head does not contain its captured inputs.",
    );

  const verified = await verifyPrevious(api, pull, config, policy.botUserId);
  const snapshot = verified.snapshot;
  const capturedBaseline = snapshot.input.range.baseline;
  if ((await api.ref("heads", config.releaseBranch)) !== snapshot.normalized.sourceCommitSha)
    throw new ReleaseApprovalError(
      "stale-source",
      "Main changed after capture; refresh and review again.",
    );
  if ((await api.ref("heads", api.headRef)) !== target.headSha)
    throw new ReleaseApprovalError(
      "stale-source",
      "The proposal head changed during review capture.",
    );
  if (
    capturedBaseline.kind === "tag" &&
    (await api.ref("tags", capturedBaseline.name)) !== capturedBaseline.objectSha
  )
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The baseline changed during review capture.",
    );
  const history = await api.pulls();
  if (
    history.filter((p) => p.state === "open").length !== 1 ||
    history.some((p) => p.state === "closed" && !p.merged)
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Competing or closed unmerged release proposals require recovery before review.",
    );
  if (history.some((p) => p.merged)) {
    const cycle = await selectReleaseCycle(
      {
        configuration: config,
        automation: { schemaVersion: 1, botUserId: policy.botUserId },
        token,
        sourceSha: snapshot.normalized.sourceCommitSha,
      },
      transport,
    );
    if (
      cycle.outcome !== "selected" ||
      cycle.baseline.kind !== "tag" ||
      capturedBaseline.kind !== "tag" ||
      cycle.baseline.name !== capturedBaseline.name ||
      cycle.baseline.objectSha !== capturedBaseline.objectSha ||
      cycle.baseline.commitSha !== capturedBaseline.commitSha
    )
      throw new ReleaseApprovalError(
        "baseline-mismatch",
        "The reviewed proposal is not based on the latest verified release.",
      );
  }
  const range = await inspectPendingRelease(
    repository,
    capturedBaseline.kind === "tag"
      ? { kind: "tag", name: capturedBaseline.name }
      : capturedBaseline,
    snapshot.normalized.sourceCommitSha,
  );

  if (
    JSON.stringify(range.baseline) !== JSON.stringify(capturedBaseline) ||
    JSON.stringify(range.commitShas.toSorted()) !==
      JSON.stringify(snapshot.input.range.commitShas.toSorted())
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The reviewed snapshot does not match the actual Git baseline and membership.",
    );

  await verifyProposalHistory(
    repository,
    config,
    policy.botUserId,
    snapshot.normalized.sourceCommitSha,
    target.headSha,
    capturedBaseline,
  );

  requireSameReadiness(readiness, await verifyReleaseReadiness(api, config, policy, target));

  if (
    (await api.ref("heads", config.releaseBranch)) !== snapshot.normalized.sourceCommitSha ||
    (await api.ref("heads", api.headRef)) !== target.headSha
  )
    throw new ReleaseApprovalError(
      "stale-source",
      "The source or proposal head changed during review capture; refresh and review again.",
    );

  if (
    capturedBaseline.kind === "tag" &&
    (await api.ref("tags", capturedBaseline.name)) !== capturedBaseline.objectSha
  )
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The baseline changed during review capture.",
    );

  if (JSON.stringify(await api.readPull(target.pullNumber)) !== JSON.stringify(pull))
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "PR metadata changed during review capture; obtain fresh review evidence.",
    );

  return {
    ...target,
    repositoryId: config.repositoryId,
    sourceSha: snapshot.normalized.sourceCommitSha,
    baseline: capturedBaseline,
    snapshotId: snapshot.snapshotId,
    proposalId: verified.id,
    configurationId: snapshot.configurationId,
    policyId: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
  };
}

export async function finalizeReleaseApproval(
  request: {
    readonly repository: string;
    readonly configuration: ReleaseInputConfiguration;
    readonly policy: ReleaseApprovalPolicy;
    readonly review: ReleaseReview;
    readonly attestation: ReleaseMergeAttestation;
    readonly token: string;
  },
  transport: GitHubRead = fetch,
): Promise<ReleaseApproval> {
  const review = parseReleaseReview(request.review);
  const attestation = parseReleaseMergeAttestation(request.attestation);

  if (
    review.repositoryId !== attestation.repositoryId ||
    review.pullNumber !== attestation.pullNumber ||
    review.headSha !== attestation.headSha ||
    review.approverUserId !== attestation.approverUserId
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The trusted merge action must match the independently stored review repository, PR, head and human actor.",
    );

  const approval = parseReleaseApproval({
    schemaVersion: 1,
    repositoryId: review.repositoryId,
    pullNumber: review.pullNumber,
    approverUserId: review.approverUserId,
    sourceSha: review.sourceSha,
    headSha: review.headSha,
    landingSha: attestation.landingSha,
    mergeKind: attestation.mergeKind,
    baseline: review.baseline,
    snapshotId: review.snapshotId,
    proposalId: review.proposalId,
  });
  const verified = await verifyReleaseApproval({ ...request, approval }, transport);

  if (verified.configurationId !== review.configurationId || verified.policyId !== review.policyId)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Configuration or approval policy changed since the independently stored review.",
    );

  return approval;
}
