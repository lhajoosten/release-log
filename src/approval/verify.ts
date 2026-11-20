import { ReleaseApprovalError } from "./validation.ts";
import { parseReleaseApprovalPolicy } from "./policy.ts";
import type { ReleaseApprovalPolicy } from "./policy.ts";
import { createHash } from "node:crypto";
import { inspectPendingRelease } from "../git.ts";
import { GitHubProposalRepository } from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { reconstructProposal } from "../producer-runtime.ts";
import { capturedVerificationConfiguration } from "../proposal/verification.ts";
import { capturedIdentity, verifyGeneratedTree } from "../proposal/identity.ts";
import { validateConventionalMessage } from "../conventional.ts";
import { requireSameReadiness, verifyReleaseReadiness } from "../release-readiness.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { parseReleaseApproval } from "./record.ts";
import type { ReleaseApproval, VerifiedReleaseApproval } from "./record.ts";
import { readLocalProposalTree, readProposalContents, verifyProposalHistory } from "./history.ts";

export async function verifyReleaseApproval(
  request: {
    readonly repository: string;
    readonly configuration: ReleaseInputConfiguration;
    readonly policy: ReleaseApprovalPolicy;
    readonly approval: ReleaseApproval;
    readonly token: string;
  },
  transport: GitHubRead = fetch,
): Promise<VerifiedReleaseApproval> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const policy = parseReleaseApprovalPolicy(request.policy);
  const approval = parseReleaseApproval(request.approval);
  const repository = request.repository;
  if (
    approval.repositoryId !== config.repositoryId ||
    !policy.approverUserIds.includes(approval.approverUserId)
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The approval repository or human approver is not allowed by trusted policy.",
    );
  const api = new GitHubProposalRepository(config, policy.botUserId, request.token, transport);
  await api.verifyRepository();
  const pull = await api.readPull(approval.pullNumber);
  if (
    pull.number !== approval.pullNumber ||
    pull.state !== "closed" ||
    !pull.merged ||
    pull.headSha !== approval.headSha ||
    pull.mergeCommitSha !== approval.landingSha ||
    pull.mergedByUserId !== approval.approverUserId
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "GitHub must confirm the exact merged PR, reviewed head, actual landing and allowed human merger.",
    );
  const readiness = await verifyReleaseReadiness(api, config, policy, approval);
  const current = await api.ref("heads", config.releaseBranch);
  if (current === null)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The configured release branch is unavailable.",
    );
  await api.requireDescendant(approval.landingSha, current);
  if (
    approval.baseline.kind === "tag" &&
    (await api.ref("tags", approval.baseline.name)) !== approval.baseline.objectSha
  )
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The approved baseline tag moved after capture; do not publish from cached checks.",
    );
  const selectedBaseline =
    approval.baseline.kind === "tag"
      ? { kind: "tag" as const, name: approval.baseline.name }
      : { kind: "bootstrap" as const, commitSha: approval.baseline.commitSha };
  const sourceRange = await inspectPendingRelease(repository, selectedBaseline, approval.sourceSha);
  if (JSON.stringify(sourceRange.baseline) !== JSON.stringify(approval.baseline))
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The local resolved baseline differs from the approved immutable baseline.",
    );
  await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: approval.sourceSha },
    approval.landingSha,
  );
  const source = await readLocalProposalTree(repository, approval.sourceSha);
  const head = await readLocalProposalTree(repository, approval.headSha);
  const landing = await readLocalProposalTree(repository, approval.landingSha);
  const expectedLandingParents =
    approval.mergeKind === "merge" ? [approval.sourceSha, approval.headSha] : [approval.sourceSha];
  if (JSON.stringify(landing.parents) !== JSON.stringify(expectedLandingParents))
    throw new ReleaseApprovalError(
      "stale-source",
      "The actual release landing parents differ from the captured source/reviewed head; refresh and review rather than publishing a stale proposal.",
    );
  if (landing.treeSha !== head.treeSha)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The actual landing tree differs from the reviewed proposal tree.",
    );
  const files = await readProposalContents(repository, head, config.selfUpgrade === true);
  const snapshotJSON = files[".release-log/inputs.json"];
  if (snapshotJSON === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The reviewed head does not contain its captured inputs.",
    );
  const marker = capturedIdentity(head.message);
  const { snapshot, prepared, description } = await reconstructProposal(
    snapshotJSON,
    capturedVerificationConfiguration(snapshotJSON, config),
    marker.version,
    await readProposalContents(repository, source, config.selfUpgrade === true),
    policy.botUserId,
    marker.previousHeadSha,
    marker.producerSha,
    marker.bodyFormat,
  );
  if (
    snapshot.snapshotId !== approval.snapshotId ||
    snapshot.normalized.sourceCommitSha !== approval.sourceSha ||
    marker.sourceSha !== approval.sourceSha ||
    JSON.stringify(snapshot.input.range.baseline) !== JSON.stringify(approval.baseline) ||
    JSON.stringify(snapshot.input.range.commitShas.toSorted()) !==
      JSON.stringify(sourceRange.commitShas.toSorted())
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The reviewed snapshot/source/baseline or actual Git membership does not match the independent approval record.",
    );
  const expectedHeadParents =
    marker.previousHeadSha && marker.previousHeadSha !== approval.sourceSha
      ? [approval.sourceSha, marker.previousHeadSha]
      : [approval.sourceSha];
  if (
    description.id !== approval.proposalId ||
    head.message !== description.message ||
    JSON.stringify(head.parents) !== JSON.stringify(expectedHeadParents) ||
    pull.title !== description.title ||
    pull.body !== description.body
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Reviewed commit, proposal identity or PR metadata differs from recomputed approved inputs.",
    );
  verifyGeneratedTree(source, head, prepared.files);
  if (prepared.files.some((file) => files[file.path] !== file.after))
    throw new ReleaseApprovalError(
      "content-mismatch",
      "Reviewed generated file content differs from recomputation.",
    );
  if (approval.mergeKind === "squash") {
    const message = await validateConventionalMessage(landing.message);
    if (
      !message.valid ||
      message.commit.type !== "chore" ||
      message.commit.scope !== null ||
      message.commit.description !== `prepare v${prepared.plan.nextVersion}` ||
      message.commit.breaking
    )
      throw new ReleaseApprovalError(
        "content-mismatch",
        "The release squash commit must retain the approved unscoped conventional subject without breaking declarations.",
      );
  }
  if (prepared.plan.nextVersion === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "A no-release plan cannot be approved for publication.",
    );
  const proposalCommits = await verifyProposalHistory(
    repository,
    config,
    policy.botUserId,
    approval.sourceSha,
    approval.headSha,
    approval.baseline,
  );
  const footprint = await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: approval.sourceSha },
    approval.landingSha,
  );
  const automationCommitShas = (
    approval.mergeKind === "merge"
      ? [...proposalCommits, approval.landingSha]
      : [approval.landingSha]
  ).toSorted();

  if (JSON.stringify(footprint.commitShas) !== JSON.stringify(automationCommitShas))
    throw new ReleaseApprovalError(
      "exclusion-invalid",
      "The release landing introduces unexpected history outside verified generated proposal commits.",
    );

  requireSameReadiness(readiness, await verifyReleaseReadiness(api, config, policy, approval));

  if (JSON.stringify(await api.readPull(approval.pullNumber)) !== JSON.stringify(pull))
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Merged PR metadata changed during verification; obtain fresh evidence.",
    );
  if (
    approval.baseline.kind === "tag" &&
    (await api.ref("tags", approval.baseline.name)) !== approval.baseline.objectSha
  )
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The baseline changed during verification; do not reuse stale approval.",
    );
  const latest = await api.ref("heads", config.releaseBranch);
  if (latest === null)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The release branch became unavailable during verification.",
    );
  await api.requireDescendant(approval.landingSha, latest);
  const result = {
    ...approval,
    releaseBranch: config.releaseBranch,
    version: prepared.plan.nextVersion,
    configurationId: snapshot.configurationId,
    policyId: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    files: description.identity.files,
    pull: { title: pull.title, body: pull.body, botUserId: policy.botUserId },
    automationCommitShas,
  };
  return {
    ...result,
    verificationId: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  };
}
