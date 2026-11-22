import { requireUnusedReleaseVersions } from "../tagging/evidence.ts";
import { createHash } from "node:crypto";
import { activeProducerSha } from "../producer-runtime.ts";
import { readToolPin } from "./tool-pins.ts";
import { workflowPath } from "../proposal-paths.ts";
import { verifyToolUpgradeCandidate } from "../tool-upgrade.ts";
import { isDeepStrictEqual } from "node:util";
import { describe } from "./identity.ts";
import { GitHubProposalRepository, ProposalConflictError } from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { verifyPrevious } from "./verification.ts";
import { inspectProposalHistory } from "./history.ts";
import type { CandidateProposalHistory } from "./history.ts";
export type { CandidateProposalHistory } from "./history.ts";
import { writeProposal } from "./write.ts";
import { prepareVerifiedRelease, validateReleaseFileContents } from "./prepare.ts";
import { encodeVerifiedSnapshot } from "../snapshot/canonical.ts";
import { validatePullRequestMetadata } from "../pr-readiness.ts";
import type { ReleaseVersionConfiguration } from "../planning/derive-release-plan.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import { replayReleaseSnapshot } from "../snapshot/replay.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";

import { parseReleaseAutomation } from "../config/automation.ts";
import type { ReleaseAutomationConfiguration } from "../config/automation.ts";

export interface ReleaseProposalRequest {
  readonly snapshot: string;
  readonly configuration: ReleaseInputConfiguration;
  readonly version: ReleaseVersionConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly token: string;
  readonly write?: boolean;
}
interface ProposalResultBase {
  readonly sourceSha: string;
  readonly baselineSha: string;
  readonly snapshotId: string;
  readonly branch: string;
}
type ExistingProposalOutcome = "would-refresh" | "unchanged" | "created" | "refreshed";
type ExistingProposalResult = {
  [K in ExistingProposalOutcome]: {
    readonly outcome: K;
    readonly proposalId: string;
    readonly pullNumber: number;
    readonly headSha: string;
  } & (K extends "would-refresh" ? { readonly changedPaths: readonly string[] } : object);
}[ExistingProposalOutcome];
export type ReleaseProposalResult = ProposalResultBase &
  (
    | {
        readonly outcome: "no-release";
        readonly proposalId: null;
        readonly pullNumber: null;
        readonly headSha: string | null;
      }
    | {
        readonly outcome: "would-create";
        readonly changedPaths: readonly string[];
        readonly proposalId: string;
        readonly pullNumber: null;
        readonly headSha: string | null;
      }
    | ExistingProposalResult
  );

export async function reconcileReleaseProposal(
  request: ReleaseProposalRequest,
  transport: GitHubRead = fetch,
  candidateHistory?: CandidateProposalHistory,
): Promise<ReleaseProposalResult> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const automation = parseReleaseAutomation(request.automation);
  const selectedVersion = structuredClone(request.version);
  const token = request.token;
  const write = request.write === true;
  if (request.write !== undefined && typeof request.write !== "boolean")
    throw new ProposalConflictError("An explicit boolean write option is required.");
  let snapshot = await replayReleaseSnapshot(request.snapshot, config);
  const api = new GitHubProposalRepository(
    config,
    automation.botUserId,
    token,
    transport,
    // Self-upgrade admission reserves up to six minutes for the main-push Quality run.
    config.selfUpgrade ? 600_000 : undefined,
  );
  const sourceSha = snapshot.normalized.sourceCommitSha;
  const baseline = snapshot.input.range.baseline;
  const requireFresh = async () => {
    await candidateHistory?.assertCurrent();
    if (config.freshSeries && baseline.kind === "bootstrap")
      await requireUnusedReleaseVersions(api);
    if ((await api.ref("heads", config.releaseBranch)) !== sourceSha)
      throw new ProposalConflictError(
        "Main changed after capture; collect and review the complete range again.",
      );
    if (baseline.kind === "tag" && (await api.ref("tags", baseline.name)) !== baseline.objectSha)
      throw new ProposalConflictError(
        "The captured baseline tag moved; review the completed release record.",
      );
  };
  const { previous, completed } = await inspectProposalHistory({
    api,
    config,
    automation,
    token,
    sourceSha,
    baseline,
    selectedVersion,
    transport,
    ...(candidateHistory ? { candidateHistory } : {}),
  });
  await requireFresh();
  const initialHead = await api.ref("heads", api.headRef, true);
  if (
    previous
      ? initialHead !== previous.headSha
      : initialHead !== null && initialHead !== completed?.headSha
  )
    throw new ProposalConflictError(
      "The proposal branch was deleted, moved, or exists without a verified PR; do not recreate or overwrite it automatically.",
    );
  const historyHead = previous ? initialHead : (completed?.headSha ?? null);
  const prior = previous ? await verifyPrevious(api, previous, config, automation.botUserId) : null;
  if (
    prior &&
    !candidateHistory &&
    JSON.stringify(prior.identity.baseline) !== JSON.stringify(baseline)
  )
    throw new ProposalConflictError(
      "The proposal belongs to another baseline; review the release lifecycle before refreshing.",
    );
  if (prior) await api.requireDescendant(prior.identity.sourceSha, sourceSha);
  if (
    prior?.snapshot.schemaVersion === 5 &&
    snapshot.schemaVersion === 5 &&
    isDeepStrictEqual(
      { ...prior.snapshot, capturedAt: null, snapshotId: null },
      { ...snapshot, capturedAt: null, snapshotId: null },
    )
  ) {
    // An identical collection retry retains the first capture instead of creating
    // a proposal commit solely to advance its timestamp.
    snapshot = await replayReleaseSnapshot(encodeVerifiedSnapshot(prior.snapshot), config);
  }
  const source = await api.tree(sourceSha);
  const sourceContents = await api.contents(source);
  if (config.selfUpgrade && !activeProducerSha())
    throw new ProposalConflictError(
      "Self-upgrades require an explicitly pinned active producer runtime.",
    );
  if (
    config.selfUpgrade &&
    !candidateHistory &&
    readToolPin(sourceContents[workflowPath] ?? "") !== activeProducerSha()
  )
    throw new ProposalConflictError(
      "The captured caller no longer pins the active producer; rerun using the reviewed current caller.",
    );
  validateReleaseFileContents(sourceContents);
  const prepared = prepareVerifiedRelease(snapshot, selectedVersion, sourceContents);
  const base = { sourceSha, baselineSha: baseline.commitSha, snapshotId: snapshot.snapshotId };
  if (!prepared.plan.release) {
    if (previous)
      throw new ProposalConflictError(
        "A proposal is open but the new plan has no release; do not silently close or remove it.",
      );
    return {
      outcome: "no-release",
      ...base,
      proposalId: null,
      branch: api.headRef,
      pullNumber: null,
      headSha: initialHead,
    };
  }
  if (config.selfUpgrade) {
    await api.requireDescendant(activeProducerSha() ?? "", sourceSha);
    await verifyToolUpgradeCandidate(api, sourceSha, requireFresh);
  }
  if (
    previous &&
    prior?.identity.snapshotId === snapshot.snapshotId &&
    JSON.stringify(prior.identity.version) === JSON.stringify(prepared.plan.version) &&
    isDeepStrictEqual(
      prior.identity.files,
      prepared.files.map((file) => ({
        path: file.path,
        sha256: createHash("sha256").update(file.after).digest("hex"),
      })),
    )
  )
    return {
      outcome: "unchanged",
      ...base,
      proposalId: prior.id,
      branch: api.headRef,
      pullNumber: previous.number,
      headSha: previous.headSha,
    };
  const description = describe(
    snapshot,
    prepared,
    automation.botUserId,
    historyHead,
    activeProducerSha(),
  );
  const readiness = await validatePullRequestMetadata(description.title, description.body, [
    { sha: sourceSha, message: description.message, parentCount: 1 },
  ]);
  if (!readiness.valid)
    throw new ProposalConflictError(
      `Generated proposal metadata does not satisfy contribution/readiness policy: ${readiness.errors.map((issue) => issue.code).join(", ")}.`,
    );
  if (!write) {
    const changedPaths = prepared.files
      .filter((file) => file.before !== file.after)
      .map((file) => file.path);
    if (previous)
      return {
        outcome: "would-refresh",
        changedPaths,
        ...base,
        proposalId: description.id,
        branch: api.headRef,
        pullNumber: previous.number,
        headSha: previous.headSha,
      };
    return {
      outcome: "would-create",
      changedPaths,
      ...base,
      proposalId: description.id,
      branch: api.headRef,
      pullNumber: null,
      headSha: initialHead,
    };
  }
  const written = await writeProposal({
    api,
    selfUpgrade: config.selfUpgrade,
    requireFresh,
    initialHead,
    completed,
    previous,
    source,
    historyHead,
    prepared,
    description,
  });
  return {
    outcome: previous ? "refreshed" : "created",
    ...base,
    proposalId: description.id,
    branch: api.headRef,
    pullNumber: written.pullNumber,
    headSha: written.headSha,
  };
}
