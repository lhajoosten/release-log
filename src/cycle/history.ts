import { proposalObject, proposalSha } from "../github-proposals.ts";
import type { RepositoryEvidenceReader, ProposalPullRequest } from "../github-proposals.ts";
import { cycleError } from "./types.ts";

interface Comparison {
  readonly status: unknown;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly mergeBaseSha: string;
}

async function readComparison(
  api: RepositoryEvidenceReader,
  baseSha: string,
  targetSha: string,
): Promise<Comparison> {
  const comparison = proposalObject(
    (await api.request(`/compare/${proposalSha(baseSha)}...${proposalSha(targetSha)}?per_page=1`))
      .data,
  );
  if (proposalObject(comparison.base_commit).sha !== baseSha)
    return cycleError(
      "inconsistent-comparison",
      "GitHub compared a different base commit; release-cycle selection is unsafe.",
    );

  const mergeBaseSha = proposalSha(proposalObject(comparison.merge_base_commit).sha);
  const aheadBy = comparison.ahead_by;
  const behindBy = comparison.behind_by;
  if (
    typeof aheadBy !== "number" ||
    !Number.isSafeInteger(aheadBy) ||
    aheadBy < 0 ||
    typeof behindBy !== "number" ||
    !Number.isSafeInteger(behindBy) ||
    behindBy < 0
  )
    return cycleError(
      "inconsistent-comparison",
      "GitHub returned incomplete commit ancestry evidence; release-cycle selection is unsafe.",
    );

  return { status: comparison.status, aheadBy, behindBy, mergeBaseSha };
}

async function verifyCommit(api: RepositoryEvidenceReader, sha: string): Promise<void> {
  const commit = proposalObject((await api.request(`/git/commits/${proposalSha(sha)}`)).data);
  if (commit.sha !== sha || typeof commit.message !== "string" || !Array.isArray(commit.parents))
    return cycleError(
      "inconsistent-comparison",
      "GitHub did not return complete commit evidence for an identical ancestry comparison.",
    );
  proposalSha(proposalObject(commit.tree).sha);
  for (const parent of commit.parents) proposalSha(proposalObject(parent).sha);
}

export function ancestry(api: RepositoryEvidenceReader) {
  const results = new Map<string, boolean>();

  return async (ancestorSha: string, descendantSha: string): Promise<boolean> => {
    const ancestor = proposalSha(ancestorSha);
    const descendant = proposalSha(descendantSha);
    const key = `${ancestor}\0${descendant}`;
    const previous = results.get(key);
    if (previous !== undefined) return previous;

    if (ancestor === descendant) {
      await verifyCommit(api, ancestor);
      results.set(key, true);
      return true;
    }

    const comparison = await readComparison(api, ancestor, descendant);
    let isAncestor: boolean;
    if (comparison.status === "ahead") {
      if (
        comparison.aheadBy <= 0 ||
        comparison.behindBy !== 0 ||
        comparison.mergeBaseSha !== ancestor
      )
        return cycleError(
          "inconsistent-comparison",
          "GitHub returned inconsistent ancestry counts; release-cycle selection is unsafe.",
        );
      isAncestor = true;
    } else if (comparison.status === "behind") {
      if (
        comparison.aheadBy !== 0 ||
        comparison.behindBy <= 0 ||
        comparison.mergeBaseSha !== descendant
      )
        return cycleError(
          "inconsistent-comparison",
          "GitHub returned inconsistent ancestry counts; release-cycle selection is unsafe.",
        );
      isAncestor = false;
    } else if (comparison.status === "diverged") {
      if (comparison.aheadBy <= 0 || comparison.behindBy <= 0)
        return cycleError(
          "inconsistent-comparison",
          "GitHub returned inconsistent divergence counts; release-cycle selection is unsafe.",
        );
      isAncestor = false;
    } else {
      return cycleError(
        "inconsistent-comparison",
        "GitHub returned an unsupported ancestry status; release-cycle selection is unsafe.",
      );
    }

    results.set(key, isAncestor);
    return isAncestor;
  };
}

export async function latestMergedProposal(
  pulls: readonly ProposalPullRequest[],
  isAncestor: (ancestorSha: string, descendantSha: string) => Promise<boolean>,
): Promise<ProposalPullRequest | null> {
  const merged = pulls.filter((pull) => pull.merged);
  if (merged.length === 0) return null;

  const landingShas = new Set<string>();
  const frontier: ProposalPullRequest[] = [];
  for (const candidate of merged) {
    if (candidate.state !== "closed" || candidate.mergeCommitSha === null)
      return cycleError(
        "ambiguous-release-history",
        "GitHub returned a merged proposal that is not closed at an exact landing commit.",
      );
    if (landingShas.has(candidate.mergeCommitSha))
      return cycleError(
        "ambiguous-release-history",
        "Multiple merged release proposals claim the same landing commit.",
      );
    landingShas.add(candidate.mergeCommitSha);

    let candidateIsOlder = false;
    const nextFrontier: ProposalPullRequest[] = [];
    for (const current of frontier) {
      const currentSha = current.mergeCommitSha;
      if (currentSha === null)
        return cycleError(
          "ambiguous-release-history",
          "A merged release proposal has no exact landing commit.",
        );
      if (await isAncestor(currentSha, candidate.mergeCommitSha)) continue;
      if (await isAncestor(candidate.mergeCommitSha, currentSha)) candidateIsOlder = true;
      nextFrontier.push(current);
    }
    if (!candidateIsOlder) nextFrontier.push(candidate);
    frontier.splice(0, frontier.length, ...nextFrontier);
  }

  if (frontier.length !== 1)
    return cycleError(
      "ambiguous-release-history",
      "Merged release landings do not form one ancestry-ordered cycle; no tag is selected.",
    );
  return frontier[0] ?? null;
}
