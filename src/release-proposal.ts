import { describe, verifyGeneratedTree } from "./proposal-identity.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
} from "./github-proposals.ts";
import type { ProposalPullRequest } from "./github-proposals.ts";
import type { GitHubRead } from "./github.ts";
import { verifyPrevious } from "./proposal-verification.ts";
import { prepareReleaseFileContents } from "./proposal-files.ts";
import { validatePullRequestMetadata } from "./pr-readiness.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import { parseReleaseInputConfiguration, replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export interface ReleaseAutomationConfiguration {
  readonly schemaVersion: 1;
  readonly botUserId: number;
}
export function parseReleaseAutomation(value: unknown): ReleaseAutomationConfiguration {
  const item = proposalObject(value);
  if (
    item.schemaVersion !== 1 ||
    Object.keys(item).toSorted().join(",") !== "botUserId,schemaVersion" ||
    typeof item.botUserId !== "number" ||
    !Number.isSafeInteger(item.botUserId) ||
    item.botUserId <= 0
  )
    throw new ProposalConflictError(
      "Configure exactly schemaVersion 1 and the expected positive numeric botUserId.",
    );
  return { schemaVersion: 1, botUserId: item.botUserId };
}

export interface ReleaseProposalRequest {
  readonly snapshot: string;
  readonly configuration: ReleaseInputConfiguration;
  readonly version: ReleaseVersionConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly token: string;
  readonly write?: boolean;
}
export interface ReleaseProposalResult {
  readonly outcome:
    | "no-release"
    | "unchanged"
    | "would-create"
    | "would-refresh"
    | "created"
    | "refreshed";
  readonly sourceSha: string;
  readonly baselineSha: string;
  readonly snapshotId: string;
  readonly proposalId: string | null;
  readonly branch: string;
  readonly pullNumber: number | null;
  readonly headSha: string | null;
}
function samePull(left: ProposalPullRequest, right: ProposalPullRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function reconcileReleaseProposal(
  request: ReleaseProposalRequest,
  transport: GitHubRead = fetch,
): Promise<ReleaseProposalResult> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const automation = parseReleaseAutomation(request.automation);
  const snapshotJSON = request.snapshot;
  const selectedVersion = structuredClone(request.version);
  const token = request.token;
  const write = request.write === true;
  if (request.write !== undefined && typeof request.write !== "boolean")
    throw new ProposalConflictError("An explicit boolean write option is required.");
  const snapshot = await replayReleaseSnapshot(snapshotJSON, config);
  const api = new GitHubProposalRepository(config, automation.botUserId, token, transport);
  const sourceSha = snapshot.normalized.sourceCommitSha;
  const baseline = snapshot.input.range.baseline;
  const requireFresh = async () => {
    if ((await api.ref("heads", config.releaseBranch)) !== sourceSha)
      throw new ProposalConflictError(
        "Main changed after capture; collect and review the complete range again.",
      );
    if (baseline.kind === "tag" && (await api.ref("tags", baseline.name)) !== baseline.objectSha)
      throw new ProposalConflictError(
        "The captured baseline tag moved; review the completed release record.",
      );
  };
  await api.verifyRepository();
  await requireFresh();
  const pulls = await api.pulls();
  if (pulls.length > 1 || pulls.some((pull) => pull.state !== "open" || pull.merged))
    throw new ProposalConflictError(
      "A closed/merged or competing proposal exists; explicit recovery or completed-cycle verification is required before reuse.",
    );
  const previous = pulls[0] ?? null;
  const initialHead = await api.ref("heads", api.headRef, true);
  if (previous ? initialHead !== previous.headSha : initialHead !== null)
    throw new ProposalConflictError(
      "The proposal branch was deleted, moved, or exists without a verified PR; do not recreate or overwrite it automatically.",
    );
  const prior = previous ? await verifyPrevious(api, previous, config, automation.botUserId) : null;
  if (prior && JSON.stringify(prior.identity.baseline) !== JSON.stringify(baseline))
    throw new ProposalConflictError(
      "The proposal belongs to another baseline; review the release lifecycle before refreshing.",
    );
  if (prior) await api.requireDescendant(prior.identity.sourceSha, sourceSha);
  const source = await api.tree(sourceSha);
  const prepared = await prepareReleaseFileContents(
    snapshotJSON,
    config,
    selectedVersion,
    await api.contents(source),
  );
  const result = (
    outcome: ReleaseProposalResult["outcome"],
    proposalId: string | null,
    pullNumber = previous?.number ?? null,
    headSha = initialHead,
  ): ReleaseProposalResult => ({
    outcome,
    sourceSha,
    baselineSha: baseline.commitSha,
    snapshotId: snapshot.snapshotId,
    proposalId,
    branch: api.headRef,
    pullNumber,
    headSha,
  });
  if (!prepared.plan.release) {
    if (previous)
      throw new ProposalConflictError(
        "A proposal is open but the new plan has no release; do not silently close or remove it.",
      );
    return result("no-release", null);
  }
  if (
    prior?.identity.snapshotId === snapshot.snapshotId &&
    JSON.stringify(prior.identity.version) === JSON.stringify(prepared.plan.version)
  )
    return result("unchanged", prior.id);
  const description = describe(snapshot, prepared, automation.botUserId, initialHead);
  const readiness = await validatePullRequestMetadata(description.title, description.body, [
    { sha: sourceSha, message: description.message, parentCount: 1 },
  ]);
  if (!readiness.valid)
    throw new ProposalConflictError(
      `Generated proposal metadata does not satisfy contribution/readiness policy: ${readiness.errors.map((issue) => issue.code).join(", ")}.`,
    );
  if (!write) return result(previous ? "would-refresh" : "would-create", description.id);
  const unchanged = async () => {
    await requireFresh();
    if ((await api.ref("heads", api.headRef, true)) !== initialHead)
      throw new ProposalConflictError(
        "The proposal head changed during reconciliation; retry from freshly verified state.",
      );
    if (previous && !samePull(previous, await api.readPull(previous.number)))
      throw new ProposalConflictError(
        "PR metadata changed during reconciliation; preserve human edits and recover manually.",
      );
  };
  await unchanged();
  const head = await api.commit(source, initialHead, prepared.files, description.message);
  const generated = await api.tree(head);
  const expectedParents =
    initialHead && initialHead !== sourceSha ? [sourceSha, initialHead] : [sourceSha];
  if (
    generated.message !== description.message ||
    JSON.stringify(generated.parents) !== JSON.stringify(expectedParents)
  )
    throw new ProposalConflictError(
      "GitHub created unexpected proposal commit evidence; no branch update is permitted.",
    );
  verifyGeneratedTree(source, generated, prepared.files);
  const generatedContents = await api.contents(generated);
  if (prepared.files.some((file) => generatedContents[file.path] !== file.after))
    throw new ProposalConflictError(
      "GitHub created unexpected generated file content; no branch update is permitted.",
    );
  await unchanged();
  await api.setRef(head, initialHead !== null);
  await requireFresh();
  if ((await api.ref("heads", api.headRef)) !== head)
    throw new ProposalConflictError(
      "The proposal ref changed before PR save; reconcile remote state before retrying.",
    );
  if (
    previous &&
    !samePull(previous, { ...(await api.readPull(previous.number)), headSha: previous.headSha })
  )
    throw new ProposalConflictError(
      "PR metadata changed before save; recover the partially updated branch explicitly.",
    );
  const pull = await api.savePull(previous, description.title, description.body);
  if (
    pull.state !== "open" ||
    pull.merged ||
    pull.headSha !== head ||
    pull.title !== description.title ||
    pull.body !== description.body
  )
    throw new ProposalConflictError(
      "GitHub did not save the exact expected proposal; reconcile before retrying.",
    );
  await requireFresh();
  if (
    (await api.ref("heads", api.headRef)) !== head ||
    !samePull(pull, await api.readPull(pull.number))
  )
    throw new ProposalConflictError(
      "Proposal state changed after save; no approval or publication is authorized.",
    );
  return result(previous ? "refreshed" : "created", description.id, pull.number, head);
}
