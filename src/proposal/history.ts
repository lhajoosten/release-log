import { ProposalConflictError } from "../github-proposals.ts";
import type { GitHubProposalRepository, ProposalPullRequest } from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { selectReleaseCycle } from "../cycle/select.ts";
import { verifyPrevious } from "./verification.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseAutomationConfiguration } from "../config/automation.ts";
import type { ReleaseVersionConfiguration } from "../planning/derive-release-plan.ts";
import type { ReleaseSnapshot } from "../snapshot/model.ts";

export interface CandidateProposalHistory {
  readonly latestLanding: ProposalPullRequest;
  readonly assertCurrent: () => Promise<void>;
}

interface HistoryInput {
  readonly api: Pick<
    GitHubProposalRepository,
    "verifyRepository" | "pulls" | "readPull" | "tree" | "contents"
  >;
  readonly config: ReleaseInputConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly token: string;
  readonly sourceSha: string;
  readonly baseline: ReleaseSnapshot["input"]["range"]["baseline"];
  readonly selectedVersion: ReleaseVersionConfiguration;
  readonly transport: GitHubRead;
  readonly candidateHistory?: CandidateProposalHistory;
}

export async function inspectProposalHistory({
  api,
  config,
  automation,
  token,
  sourceSha,
  baseline,
  selectedVersion,
  transport,
  candidateHistory,
}: HistoryInput): Promise<{
  previous: ProposalPullRequest | null;
  completed: ProposalPullRequest | null;
}> {
  await api.verifyRepository();
  const pulls = await api.pulls();
  const open = pulls.filter((pull) => pull.state === "open" && !pull.merged);
  if (open.length > 1 || pulls.some((pull) => pull.state === "closed" && !pull.merged))
    throw new ProposalConflictError(
      "A closed/merged or competing proposal exists; explicit recovery or completed-cycle verification is required before reuse.",
    );
  const previous = open[0] ?? null;
  if (config.internalPublication !== (candidateHistory ? true : undefined))
    throw new ProposalConflictError(
      "Internal proposals require the self-publication history controller.",
    );
  if (candidateHistory) {
    await candidateHistory.assertCurrent();
    return { previous, completed: candidateHistory.latestLanding };
  }
  let completed: ProposalPullRequest | null = null;
  if (pulls.some((pull) => pull.merged)) {
    const cycle = await selectReleaseCycle(
      { configuration: config, automation, token, sourceSha },
      transport,
    );
    if (cycle.outcome === "release-tag-pending")
      throw new ProposalConflictError(
        `release-tag-pending: rerun tag-release for PR #${cycle.pullNumber} at ${cycle.landingSha}.`,
      );
    if (cycle.outcome !== "selected" || cycle.baseline.kind !== "tag")
      throw new ProposalConflictError("Release history requires explicit recovery before reuse.");
    if (
      baseline.kind !== "tag" ||
      baseline.name !== cycle.baseline.name ||
      baseline.objectSha !== cycle.baseline.objectSha ||
      baseline.commitSha !== cycle.baseline.commitSha ||
      selectedVersion.kind !== "released" ||
      cycle.version.kind !== "released" ||
      selectedVersion.currentVersion !== cycle.version.currentVersion
    )
      throw new ProposalConflictError(
        "The captured baseline or version is not the latest verified release; collect again.",
      );
    completed = await api.readPull(cycle.baseline.pullNumber);
    if (cycle.baseline.adopted) {
      if (
        !completed.merged ||
        completed.state !== "closed" ||
        completed.headSha !== config.adoptedRelease?.headSha ||
        completed.mergeCommitSha !== config.adoptedRelease.landingSha
      )
        throw new ProposalConflictError("The superseded PR changed during adoption.");
    } else {
      if (!completed.merged || completed.mergeCommitSha !== cycle.baseline.commitSha)
        throw new ProposalConflictError(
          "The completed release changed during reconciliation; retry from fresh state.",
        );
      const verified = await verifyPrevious(api, completed, config, automation.botUserId);
      const landing = await api.tree(cycle.baseline.commitSha);
      const mergeParents = [verified.source.commitSha, verified.head.commitSha];
      const squashParents = [verified.source.commitSha];
      if (
        landing.treeSha !== verified.head.treeSha ||
        (JSON.stringify(landing.parents) !== JSON.stringify(mergeParents) &&
          JSON.stringify(landing.parents) !== JSON.stringify(squashParents))
      )
        throw new ProposalConflictError(
          "The completed proposal no longer matches its verified landing; retry from fresh state.",
        );
    }
  }
  return { previous, completed };
}
