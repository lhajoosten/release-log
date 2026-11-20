import { reconcileTaggedGitHubRelease, taggedReleaseNotes } from "../github-release.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { parseReleaseAutomation } from "../config/automation.ts";
import { verifyPrevious } from "../proposal/verification.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import {
  samePull,
  sameTree,
  readTagTarget,
  requireBaselineUnchanged,
  requireLandingOnCurrentMain,
} from "./evidence.ts";
import type { ReleaseTagRequest, ReleaseTagResult } from "./types.ts";

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
  const finish = async (outcome: ReleaseTagResult["outcome"]): Promise<ReleaseTagResult> => {
    const result = { outcome, tag, landingSha, pullNumber };
    if (!configuration.githubRelease) return result;
    const release = await reconcileTaggedGitHubRelease(
      api,
      configuration.repository,
      tag,
      landingSha,
      taggedReleaseNotes(verified.changelog, verified.nextVersion),
      write,
      async () => {
        if (
          !samePull(pull, await api.readPull(pullNumber)) ||
          (await readTagTarget(api, tag)) !== landingSha
        )
          throw new ProposalConflictError(
            "The verified release PR or tag changed before GitHub Release creation.",
          );
        await requireBaselineUnchanged(api, baseline);
        await requireLandingOnCurrentMain(api, configuration, landingSha);
      },
    );
    return { ...result, release };
  };
  const existingTarget = await readTagTarget(api, tag);
  if (existingTarget !== null) {
    if (existingTarget !== landingSha)
      throw new ProposalConflictError(
        "The version tag already points to another commit; never move or overwrite it.",
      );
    return finish("unchanged");
  }

  if (!write) return finish("would-create");

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
    return finish("unchanged");
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

  return finish("created");
}
