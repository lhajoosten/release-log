import { ProposalConflictError, proposalObject, proposalSha } from "../github-proposals.ts";
import type {
  GitHubProposalRepository,
  RepositoryEvidenceReader,
  ProposalPullRequest,
  ProposalTree,
} from "../github-proposals.ts";
import { GitHubReadError } from "../github.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import type { ResolvedReleaseBaseline } from "../git.ts";

export function samePull(left: ProposalPullRequest, right: ProposalPullRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameTree(left: ProposalTree, right: ProposalTree): boolean {
  if (left.treeSha !== right.treeSha || left.entries.size !== right.entries.size) return false;
  for (const [path, entry] of left.entries) {
    const other = right.entries.get(path);
    if (!other || JSON.stringify(entry) !== JSON.stringify(other)) return false;
  }
  return true;
}

export async function requireUnusedReleaseVersions(api: RepositoryEvidenceReader): Promise<void> {
  const releases = await api.request("/releases?per_page=1");
  if (!Array.isArray(releases.data) || releases.data.length !== 0 || releases.next)
    throw new ProposalConflictError(
      "Fresh-series bootstrap requires an empty GitHub Release listing.",
    );

  for (let page = 1; page <= 10; page++) {
    const tags = await api.request(`/tags?per_page=100&page=${page}`);
    if (
      !Array.isArray(tags.data) ||
      tags.data.length > 100 ||
      (tags.next && tags.data.length !== 100)
    )
      throw new ProposalConflictError(
        "Fresh-series bootstrap could not verify the complete tag listing.",
      );

    for (const item of tags.data as unknown[]) {
      const name = proposalObject(item).name;
      if (typeof name !== "string")
        throw new ProposalConflictError("Fresh-series bootstrap received an invalid tag listing.");
      if (/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(name))
        throw new ProposalConflictError(
          `Fresh-series bootstrap requires removal of existing stable tag ${name}.`,
        );
    }
    if (!tags.next) return;
  }
  throw new ProposalConflictError("Fresh-series tag discovery exceeded ten pages.");
}

export async function readTagTarget(
  api: RepositoryEvidenceReader,
  tag: string,
): Promise<string | null> {
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

export async function requireBaselineUnchanged(
  api: Pick<GitHubProposalRepository, "ref">,
  baseline: ResolvedReleaseBaseline,
): Promise<void> {
  if (baseline.kind !== "tag") return;
  if ((await api.ref("tags", baseline.name)) !== baseline.objectSha)
    throw new ProposalConflictError(
      "The captured baseline tag moved; review the completed release record.",
    );
}

export async function requireLandingOnCurrentMain(
  api: Pick<GitHubProposalRepository, "ref" | "requireDescendant">,
  configuration: ReleaseInputConfiguration,
  landingSha: string,
): Promise<void> {
  const currentMain = await api.ref("heads", configuration.releaseBranch);
  if (currentMain === null)
    throw new ProposalConflictError("The configured release branch no longer exists.");
  await api.requireDescendant(landingSha, currentMain);
}
