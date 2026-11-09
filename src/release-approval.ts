import { createHash } from "node:crypto";
import { inspectCommit, inspectGitTree, inspectPendingRelease, readGitBlob } from "./git.ts";
import type { PendingReleaseInspection, ResolvedReleaseBaseline } from "./git.ts";
import { GitHubProposalRepository } from "./github-proposals.ts";
import type { ProposalTree } from "./github-proposals.ts";
import type { GitHubRead } from "./github.ts";
import { prepareReleaseFileContents } from "./proposal-files.ts";
import type { ReleaseFileContents } from "./proposal-files.ts";
import { capturedIdentity, describe, verifyGeneratedTree } from "./proposal-identity.ts";
import { validateConventionalMessage } from "./conventional.ts";
import { reconcileReleaseProposal } from "./release-proposal.ts";
import { requireSameReadiness, verifyReleaseReadiness } from "./release-readiness.ts";
import { parseReleaseInputConfiguration, replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

import {
  ReleaseApprovalError,
  parseReleaseApproval,
  parseReleaseApprovalPolicy,
  parseReleaseReviewTarget,
  parseReleaseReview,
  parseReleaseMergeAttestation,
  object,
  invalid,
} from "./release-approval-record.ts";
import type {
  ReleaseApprovalPolicy,
  ReleaseApproval,
  ReleaseReviewTarget,
  ReleaseReview,
  ReleaseMergeAttestation,
  VerifiedReleaseApproval,
  ReleaseExclusionAudit,
  ReleaseExclusionAuthority,
} from "./release-approval-record.ts";
export {
  ReleaseApprovalError,
  parseReleaseApproval,
  parseReleaseApprovalPolicy,
  parseReleaseReviewTarget,
  parseReleaseReview,
  parseReleaseMergeAttestation,
  parseReleaseApprovalJSON,
  parseVerifiedReleaseApproval,
} from "./release-approval-record.ts";
export type {
  RequiredReleaseCheck,
  ReleaseApprovalPolicy,
  ReleaseApproval,
  ReleaseReviewTarget,
  ReleaseReview,
  ReleaseMergeAttestation,
  VerifiedReleaseApproval,
  ReleaseExclusionAudit,
  ReleaseExclusionAuthority,
} from "./release-approval-record.ts";

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

async function localTree(repository: string, commitSha: string): Promise<ProposalTree> {
  const tree = await inspectGitTree(repository, commitSha);
  const commit = await inspectCommit(repository, commitSha);
  return { ...tree, message: commit.message, parents: commit.parentShas };
}
async function contents(repository: string, tree: ProposalTree): Promise<ReleaseFileContents> {
  const get = async (path: string): Promise<string | null> => {
    const directory = tree.entries.get(".release-log");
    if (
      path.startsWith(".release-log/") &&
      directory &&
      (directory.type !== "tree" || directory.mode !== "040000")
    )
      throw new ReleaseApprovalError(
        "content-mismatch",
        "The approved snapshot directory must not be a symlink or submodule.",
      );
    const entry = tree.entries.get(path);
    if (!entry) return null;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new ReleaseApprovalError(
        "content-mismatch",
        "Approved proposal inputs must be ordinary tracked files.",
      );
    return readGitBlob(repository, entry.sha);
  };
  return {
    "package.json": await get("package.json"),
    "pyproject.toml": await get("pyproject.toml"),
    "CHANGELOG.md": await get("CHANGELOG.md"),
    ".release-log/inputs.json": await get(".release-log/inputs.json"),
    "package-lock.json": await get("package-lock.json"),
    "npm-shrinkwrap.json": await get("npm-shrinkwrap.json"),
    "uv.lock": await get("uv.lock"),
  };
}

async function verifyProposalHistory(
  repository: string,
  config: ReleaseInputConfiguration,
  botUserId: number,
  sourceSha: string,
  headSha: string,
  expectedBaseline: ResolvedReleaseBaseline,
): Promise<readonly string[]> {
  const history = await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: sourceSha },
    headSha,
  );

  if (history.commitShas.length > 100)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Proposal history exceeds 100 generated commits; explicit recovery is required.",
    );

  const deadline = Date.now() + 300_000;
  let snapshotBytes = 0;

  for (const commitSha of history.commitShas) {
    if (Date.now() >= deadline)
      throw new ReleaseApprovalError(
        "resource-limit",
        "Proposal history verification exceeded five minutes; no exclusion is usable.",
      );

    // The caller has already checked the current head; older parents need the same scrutiny.
    if (commitSha === headSha) continue;

    const head = await localTree(repository, commitSha);
    const marker = capturedIdentity(head.message);
    const files = await contents(repository, head);
    const snapshotJSON = files[".release-log/inputs.json"];

    if (snapshotJSON === null)
      throw new ReleaseApprovalError(
        "content-mismatch",
        "A prior proposal head is missing its captured inputs; do not exclude its history.",
      );

    snapshotBytes += Buffer.byteLength(snapshotJSON, "utf8");

    if (snapshotBytes > 16 * 1024 * 1024)
      throw new ReleaseApprovalError(
        "resource-limit",
        "Prior proposal snapshots exceed the 16 MiB audit budget.",
      );

    const snapshot = await replayReleaseSnapshot(snapshotJSON, config);
    const capturedBaseline = snapshot.input.range.baseline;
    const range = await inspectPendingRelease(
      repository,
      capturedBaseline.kind === "tag"
        ? { kind: "tag", name: capturedBaseline.name }
        : capturedBaseline,
      marker.sourceSha,
    );

    if (
      snapshot.normalized.sourceCommitSha !== marker.sourceSha ||
      JSON.stringify(capturedBaseline) !== JSON.stringify(expectedBaseline) ||
      JSON.stringify(range.baseline) !== JSON.stringify(capturedBaseline) ||
      JSON.stringify(range.commitShas.toSorted()) !==
        JSON.stringify(snapshot.input.range.commitShas.toSorted())
    )
      throw new ReleaseApprovalError(
        "identity-mismatch",
        "A prior proposal snapshot has inconsistent source, baseline or Git membership.",
      );

    await inspectPendingRelease(
      repository,
      { kind: "bootstrap", commitSha: marker.sourceSha },
      sourceSha,
    );

    const source = await localTree(repository, marker.sourceSha);
    const prepared = await prepareReleaseFileContents(
      snapshotJSON,
      config,
      marker.version,
      await contents(repository, source),
    );
    const description = describe(snapshot, prepared, botUserId, marker.previousHeadSha);
    const parents =
      marker.previousHeadSha && marker.previousHeadSha !== marker.sourceSha
        ? [marker.sourceSha, marker.previousHeadSha]
        : [marker.sourceSha];

    if (
      head.message !== description.message ||
      JSON.stringify(head.parents) !== JSON.stringify(parents)
    )
      throw new ReleaseApprovalError(
        "identity-mismatch",
        "A prior proposal commit does not match its generated identity and parents.",
      );

    verifyGeneratedTree(source, head, prepared.files);

    if (prepared.files.some((file) => files[file.path] !== file.after))
      throw new ReleaseApprovalError(
        "content-mismatch",
        "A prior proposal contains edited generated outputs; do not exclude it.",
      );
  }

  if (Date.now() >= deadline)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Proposal history verification exceeded five minutes; no exclusion is usable.",
    );

  return history.commitShas;
}

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
  const head = await localTree(repository, target.headSha);
  const files = await contents(repository, head);
  const snapshotJSON = files[".release-log/inputs.json"];

  if (snapshotJSON === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The reviewed head does not contain its captured inputs.",
    );

  const snapshot = await replayReleaseSnapshot(snapshotJSON, config);
  const capturedBaseline = snapshot.input.range.baseline;
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

  // Reuse the controller's exact generated-tree/metadata checks without enabling writes.
  const result = await reconcileReleaseProposal(
    {
      snapshot: snapshotJSON,
      configuration: config,
      version: capturedIdentity(head.message).version,
      automation: { schemaVersion: 1, botUserId: policy.botUserId },
      token,
      write: false,
    },
    transport,
  );

  if (
    result.outcome !== "unchanged" ||
    result.headSha !== target.headSha ||
    result.pullNumber !== target.pullNumber ||
    result.proposalId === null
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The intended reviewed head is not the complete current generated proposal.",
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
    proposalId: result.proposalId,
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
  const source = await localTree(repository, approval.sourceSha);
  const head = await localTree(repository, approval.headSha);
  const landing = await localTree(repository, approval.landingSha);
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
  const files = await contents(repository, head);
  const snapshotJSON = files[".release-log/inputs.json"];
  if (snapshotJSON === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The reviewed head does not contain its captured inputs.",
    );
  const snapshot = await replayReleaseSnapshot(snapshotJSON, config);
  const marker = capturedIdentity(head.message);
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
  const prepared = await prepareReleaseFileContents(
    snapshotJSON,
    config,
    marker.version,
    await contents(repository, source),
  );
  const description = describe(snapshot, prepared, policy.botUserId, marker.previousHeadSha);
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
