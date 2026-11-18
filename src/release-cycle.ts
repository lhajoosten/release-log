import { updateCargoVersions } from "./cargo-version.ts";
import { updatePackageVersion, updatePyprojectVersion } from "./version-files.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "./github-proposals.ts";
import type { ProposalPullRequest } from "./github-proposals.ts";
import type { GitHubRead } from "./github.ts";
import { parseReleaseAutomation } from "./release-proposal.ts";
import type { ReleaseAutomationConfiguration } from "./release-proposal.ts";
import { reconcileReleaseTag } from "./release-tag.ts";
import { parseReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";

export type ReleaseCycleErrorCode =
  | "github-release-pending"
  | "ambiguous-open-proposals"
  | "ambiguous-release-history"
  | "baseline-unavailable"
  | "inconsistent-comparison"
  | "invalid-release-tag"
  | "source-not-current"
  | "source-not-descendant"
  | "tag-changed";

export class ReleaseCycleError extends Error {
  readonly code: ReleaseCycleErrorCode;

  constructor(code: ReleaseCycleErrorCode, message: string) {
    super(message);
    this.name = "ReleaseCycleError";
    this.code = code;
  }
}

export interface ReleaseCycleRequest {
  readonly configuration: ReleaseInputConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly token: string;
  readonly sourceSha: string;
}

export type ReleaseCycleBaseline =
  | {
      readonly kind: "tag";
      readonly name: string;
      readonly objectSha: string;
      readonly commitSha: string;
      readonly pullNumber: number;
      readonly adopted?: true;
    }
  | { readonly kind: "bootstrap"; readonly commitSha: string };

export type ReleaseCycleResult =
  | {
      readonly outcome: "selected";
      readonly sourceSha: string;
      readonly baseline: ReleaseCycleBaseline;
      readonly version: ReleaseVersionConfiguration;
    }
  | {
      readonly outcome: "release-tag-pending";
      readonly sourceSha: string;
      readonly tag: string;
      readonly landingSha: string;
      readonly pullNumber: number;
    }
  | {
      readonly outcome: "closed-unmerged";
      readonly sourceSha: string;
      readonly pullNumbers: readonly number[];
    };

interface Comparison {
  readonly status: unknown;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly mergeBaseSha: string;
}

function cycleError(code: ReleaseCycleErrorCode, message: string): never {
  throw new ReleaseCycleError(code, message);
}

async function readComparison(
  api: GitHubProposalRepository,
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

async function verifyCommit(api: GitHubProposalRepository, sha: string): Promise<void> {
  const commit = proposalObject((await api.request(`/git/commits/${proposalSha(sha)}`)).data);
  if (commit.sha !== sha || typeof commit.message !== "string" || !Array.isArray(commit.parents))
    return cycleError(
      "inconsistent-comparison",
      "GitHub did not return complete commit evidence for an identical ancestry comparison.",
    );
  proposalSha(proposalObject(commit.tree).sha);
  for (const parent of commit.parents) proposalSha(proposalObject(parent).sha);
}

function ancestry(api: GitHubProposalRepository) {
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

async function latestMergedProposal(
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

function releasedVersion(tag: string): string {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag))
    return cycleError(
      "invalid-release-tag",
      "The verified release proposal produced an unsupported version tag.",
    );
  return tag.slice(1);
}

export async function selectReleaseCycle(
  request: ReleaseCycleRequest,
  transport: GitHubRead = fetch,
): Promise<ReleaseCycleResult> {
  const configuration = parseReleaseInputConfiguration(structuredClone(request.configuration));
  const automation = parseReleaseAutomation(structuredClone(request.automation));
  const { token, sourceSha } = request;
  if (typeof sourceSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceSha))
    throw new ProposalConflictError("Supply a complete lowercase release source commit ID.");

  const api = new GitHubProposalRepository(configuration, automation.botUserId, token, transport);
  await api.verifyRepository();
  const pulls = await api.pulls();
  const open = pulls.filter((pull) => pull.state === "open");
  if (open.length > 1)
    return cycleError(
      "ambiguous-open-proposals",
      "Multiple reserved release proposals are open; review proposal history before selecting a cycle.",
    );
  for (const pull of open) {
    if (pull.merged)
      return cycleError(
        "ambiguous-release-history",
        "GitHub returned an open release proposal marked as merged.",
      );
  }

  const isAncestor = ancestry(api);
  const latest = await latestMergedProposal(pulls, isAncestor);
  const closedUnmerged = pulls
    .filter((pull) => pull.state === "closed" && !pull.merged)
    .map((pull) => pull.number)
    .toSorted((left, right) => left - right);

  if (latest === null) {
    if (closedUnmerged.length > 0)
      return { outcome: "closed-unmerged", sourceSha, pullNumbers: closedUnmerged };
    if (configuration.schemaVersion !== 2)
      return cycleError(
        "baseline-unavailable",
        "No verified tagged release proposal or explicit bootstrap baseline is available; refusing to infer a tag.",
      );

    if ((await api.ref("heads", configuration.releaseBranch)) !== sourceSha)
      return cycleError(
        "source-not-current",
        "The captured bootstrap source is no longer the configured release-branch tip; capture the current branch before selecting a baseline.",
      );

    const commitSha = proposalSha(configuration.bootstrap.baselineSha);
    if (!(await isAncestor(commitSha, sourceSha)))
      return cycleError(
        "source-not-descendant",
        "The explicit bootstrap baseline is not an ancestor of the captured release source.",
      );
    return {
      outcome: "selected",
      sourceSha,
      baseline: { kind: "bootstrap", commitSha },
      version: { kind: "bootstrap", initialVersion: "0.1.0" },
    };
  }

  const landingSha = latest.mergeCommitSha;
  if (landingSha === null)
    return cycleError(
      "ambiguous-release-history",
      "The latest merged release proposal has no exact landing commit.",
    );
  if (!(await isAncestor(landingSha, sourceSha)))
    return cycleError(
      "source-not-descendant",
      "The latest merged release landing is not an ancestor of the captured source; refusing to fall back to an older release tag.",
    );

  const adoption = configuration.adoptedRelease;
  if (adoption && latest.number === adoption.pullNumber) {
    const current = await api.readPull(latest.number);
    if (
      latest.headSha !== adoption.headSha ||
      landingSha !== adoption.landingSha ||
      current.headSha !== adoption.headSha ||
      current.mergeCommitSha !== landingSha ||
      current.state !== "closed" ||
      !current.merged ||
      !(await isAncestor(landingSha, adoption.commitSha)) ||
      !(await isAncestor(adoption.commitSha, sourceSha))
    )
      return cycleError(
        "baseline-unavailable",
        "The reviewed release adoption does not match merged history.",
      );

    const files = await api.contents(await api.tree(adoption.commitSha));
    const changelog = files["CHANGELOG.md"];
    const manifestVersion = { currentVersion: releasedVersion(adoption.tag), nextVersion: null };
    const nodeManifest = files["package.json"];
    const pythonManifest = files["pyproject.toml"];
    if (
      (nodeManifest === null && pythonManifest === null && files["Cargo.toml"] == null) ||
      !changelog ||
      changelog.includes("<!-- release-log:pending:") ||
      !changelog.split("\n").some((line) => line.startsWith(`## ${adoption.tag} (`))
    )
      return cycleError(
        "baseline-unavailable",
        "The adopted commit must contain the finalized changelog and matching package version.",
      );
    if (nodeManifest !== null) updatePackageVersion(nodeManifest, manifestVersion);
    if (pythonManifest !== null) updatePyprojectVersion(pythonManifest, manifestVersion);
    updateCargoVersions(files, manifestVersion);
    if (configuration.githubRelease) {
      const release = proposalObject((await api.request(`/releases/tags/${adoption.tag}`)).data);
      if (
        release.tag_name !== adoption.tag ||
        release.draft !== false ||
        release.prerelease !== false ||
        typeof release.published_at !== "string"
      )
        return cycleError(
          "github-release-pending",
          "The adopted boundary requires its published stable GitHub Release.",
        );
    }
    if ((await api.ref("tags", adoption.tag, true)) !== adoption.commitSha)
      return cycleError(
        "tag-changed",
        "The adopted lightweight tag is missing or points to a different commit.",
      );
    if ((await api.ref("heads", configuration.releaseBranch)) !== sourceSha)
      return cycleError("source-not-current", "The release branch advanced during adoption.");
    if (closedUnmerged.length > 0)
      return { outcome: "closed-unmerged", sourceSha, pullNumbers: closedUnmerged };
    return {
      outcome: "selected",
      sourceSha,
      baseline: {
        kind: "tag",
        adopted: true,
        name: adoption.tag,
        objectSha: adoption.commitSha,
        commitSha: adoption.commitSha,
        pullNumber: latest.number,
      },
      version: { kind: "released", currentVersion: releasedVersion(adoption.tag) },
    };
  }

  const tagResult = await reconcileReleaseTag(
    {
      configuration,
      automation,
      pullNumber: latest.number,
      landingSha,
      token,
      write: false,
    },
    transport,
  );
  if (tagResult.pullNumber !== latest.number || tagResult.landingSha !== landingSha)
    return cycleError(
      "ambiguous-release-history",
      "Release-tag reconciliation returned a different proposal or landing commit.",
    );
  if (tagResult.outcome === "would-create")
    return {
      outcome: "release-tag-pending",
      sourceSha,
      tag: tagResult.tag,
      landingSha,
      pullNumber: latest.number,
    };
  if (tagResult.release?.outcome === "would-create")
    return cycleError(
      "github-release-pending",
      `The verified tag has no GitHub Release; rerun tag-release for PR #${latest.number} at ${landingSha} before the next cycle.`,
    );
  if (tagResult.outcome !== "unchanged")
    return cycleError(
      "tag-changed",
      "Read-only release-tag reconciliation returned an unexpected write outcome.",
    );

  if (closedUnmerged.length > 0)
    return { outcome: "closed-unmerged", sourceSha, pullNumbers: closedUnmerged };

  const objectShaBefore = await api.ref("tags", tagResult.tag);
  if (objectShaBefore === null)
    return cycleError("tag-changed", "The verified release tag disappeared during selection.");
  const rechecked = await reconcileReleaseTag(
    {
      configuration,
      automation,
      pullNumber: latest.number,
      landingSha,
      token,
      write: false,
    },
    transport,
  );
  if (rechecked.release?.outcome === "would-create")
    return cycleError(
      "github-release-pending",
      "The GitHub Release disappeared during cycle selection; rerun tag-release before continuing.",
    );
  const objectShaAfter = await api.ref("tags", tagResult.tag);
  if (
    rechecked.outcome !== "unchanged" ||
    rechecked.tag !== tagResult.tag ||
    rechecked.landingSha !== landingSha ||
    objectShaBefore !== objectShaAfter
  )
    return cycleError(
      "tag-changed",
      "The exact release tag changed during cycle selection; retry from fresh GitHub state.",
    );

  return {
    outcome: "selected",
    sourceSha,
    baseline: {
      kind: "tag",
      name: tagResult.tag,
      objectSha: objectShaAfter,
      commitSha: landingSha,
      pullNumber: latest.number,
    },
    version: { kind: "released", currentVersion: releasedVersion(tagResult.tag) },
  };
}
