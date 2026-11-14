import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "./github-proposals.ts";
import type { ProposalPullRequest, ProposalTree } from "./github-proposals.ts";
import { GitHubReadError } from "./github.ts";
import type { GitHubRead } from "./github.ts";
import { parseReleaseAutomation } from "./release-proposal.ts";
import type { ReleaseAutomationConfiguration } from "./release-proposal.ts";
import { verifyPrevious } from "./proposal-verification.ts";
import { parseReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ResolvedReleaseBaseline } from "./git.ts";

export interface ReleaseTagRequest {
  readonly configuration: ReleaseInputConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly pullNumber: number;
  readonly landingSha: string;
  readonly token: string;
  readonly write?: boolean;
}

export interface ReleaseTagResult {
  readonly outcome: "would-create" | "created" | "unchanged";
  readonly tag: string;
  readonly landingSha: string;
  readonly pullNumber: number;
}

function samePull(left: ProposalPullRequest, right: ProposalPullRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTree(left: ProposalTree, right: ProposalTree): boolean {
  if (left.treeSha !== right.treeSha || left.entries.size !== right.entries.size) return false;
  for (const [path, entry] of left.entries) {
    const other = right.entries.get(path);
    if (!other || JSON.stringify(entry) !== JSON.stringify(other)) return false;
  }
  return true;
}

async function readTagTarget(api: GitHubProposalRepository, tag: string): Promise<string | null> {
  let response: { data: unknown; next: boolean };
  try {
    response = await api.request(`/git/ref/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error instanceof GitHubReadError && error.status === 404) return null;
    throw error;
  }

  const ref = proposalObject(response.data);
  if (ref.ref !== `refs/tags/${tag}`)
    throw new ProposalConflictError("GitHub returned a different version tag than requested.");

  let target = proposalObject(ref.object);
  let targetSha = proposalSha(target.sha);
  const seen = new Set<string>();
  while (target.type === "tag") {
    if (seen.has(targetSha) || seen.size >= 10)
      throw new ProposalConflictError(
        "The version tag is cyclic or exceeds ten annotation levels.",
      );
    seen.add(targetSha);
    const annotation = proposalObject(
      (await api.request(`/git/tags/${encodeURIComponent(targetSha)}`)).data,
    );
    if (annotation.sha !== targetSha)
      throw new ProposalConflictError("The annotated version tag identity is inconsistent.");
    target = proposalObject(annotation.object);
    targetSha = proposalSha(target.sha);
  }
  if (target.type !== "commit")
    throw new ProposalConflictError("The version tag must resolve to a commit.");
  return targetSha;
}

async function requireBaselineUnchanged(
  api: GitHubProposalRepository,
  baseline: ResolvedReleaseBaseline,
): Promise<void> {
  if (baseline.kind !== "tag") return;
  if ((await api.ref("tags", baseline.name)) !== baseline.objectSha)
    throw new ProposalConflictError(
      "The captured baseline tag moved; review the completed release record.",
    );
}

async function requireLandingOnCurrentMain(
  api: GitHubProposalRepository,
  configuration: ReleaseInputConfiguration,
  landingSha: string,
): Promise<void> {
  const currentMain = await api.ref("heads", configuration.releaseBranch);
  if (currentMain === null)
    throw new ProposalConflictError("The configured release branch no longer exists.");
  await api.requireDescendant(landingSha, currentMain);
}

export async function reconcileReleaseTag(
  request: ReleaseTagRequest,
  transport: GitHubRead = fetch,
): Promise<ReleaseTagResult> {
  const configuration = parseReleaseInputConfiguration(structuredClone(request.configuration));
  const automation = parseReleaseAutomation(structuredClone(request.automation));
  const pullNumber = request.pullNumber;
  const landingSha = request.landingSha;
  const token = request.token;
  const requestedWrite = request.write;
  const write = requestedWrite === true;
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)
    throw new ProposalConflictError("A positive release pull request number is required.");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(landingSha))
    throw new ProposalConflictError("Supply a complete lowercase release landing commit ID.");
  if (typeof token !== "string" || !token.trim())
    throw new ProposalConflictError("A repository-limited GitHub token is required.");
  if (requestedWrite !== undefined && typeof requestedWrite !== "boolean")
    throw new ProposalConflictError("An explicit boolean write option is required.");

  const api = new GitHubProposalRepository(configuration, automation.botUserId, token, transport);
  await api.verifyRepository();

  const pull = await api.readPull(pullNumber);
  if (
    pull.number !== pullNumber ||
    pull.state !== "closed" ||
    !pull.merged ||
    pull.mergeCommitSha === null
  )
    throw new ProposalConflictError("The release proposal must be a closed, merged pull request.");
  if (pull.mergeCommitSha !== landingSha)
    throw new ProposalConflictError(
      "The supplied landing SHA differs from the merged release pull request.",
    );

  const verified = await verifyPrevious(api, pull, configuration, automation.botUserId);
  const sourceSha = verified.source.commitSha;
  const proposalHeadSha = verified.head.commitSha;
  const landing = await api.tree(landingSha);
  if (!sameTree(landing, verified.head))
    throw new ProposalConflictError(
      "The release landing tree differs from the verified generated proposal tree.",
    );
  const expectedMergeParents = [sourceSha, proposalHeadSha];
  const expectedSquashParents = [sourceSha];
  if (
    JSON.stringify(landing.parents) !== JSON.stringify(expectedMergeParents) &&
    JSON.stringify(landing.parents) !== JSON.stringify(expectedSquashParents)
  )
    throw new ProposalConflictError(
      "The release landing must be a verified merge or squash of the proposal; rebase landings are unsupported.",
    );

  const baseline = verified.identity.baseline;
  await requireBaselineUnchanged(api, baseline);
  await requireLandingOnCurrentMain(api, configuration, landingSha);

  const tag = `v${verified.nextVersion}`;
  const existingTarget = await readTagTarget(api, tag);
  if (existingTarget !== null) {
    if (existingTarget !== landingSha)
      throw new ProposalConflictError(
        "The version tag already points to another commit; never move or overwrite it.",
      );
    return { outcome: "unchanged", tag, landingSha, pullNumber };
  }

  if (!write) return { outcome: "would-create", tag, landingSha, pullNumber };

  const currentPull = await api.readPull(pullNumber);
  if (!samePull(pull, currentPull))
    throw new ProposalConflictError(
      "The merged release pull request changed during tag reconciliation; inspect before retrying.",
    );
  await requireBaselineUnchanged(api, baseline);
  await requireLandingOnCurrentMain(api, configuration, landingSha);

  const latestTarget = await readTagTarget(api, tag);
  if (latestTarget !== null) {
    if (latestTarget !== landingSha)
      throw new ProposalConflictError(
        "The version tag changed during reconciliation and points elsewhere; never move or overwrite it.",
      );
    return { outcome: "unchanged", tag, landingSha, pullNumber };
  }

  const created = proposalObject(
    (
      await api.request("/git/refs", "POST", {
        ref: `refs/tags/${tag}`,
        sha: landingSha,
      })
    ).data,
  );
  const createdObject = proposalObject(created.object);
  if (
    created.ref !== `refs/tags/${tag}` ||
    createdObject.type !== "commit" ||
    proposalSha(createdObject.sha) !== landingSha
  )
    throw new ProposalConflictError(
      "GitHub returned an unexpected tag creation response; inspect remote state before retrying.",
    );

  return { outcome: "created", tag, landingSha, pullNumber };
}
