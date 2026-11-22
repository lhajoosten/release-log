import { isDeepStrictEqual } from "node:util";
import { candidateLandingPin } from "./candidate.ts";
import { reconcileTaggedGitHubRelease, taggedReleaseNotes } from "../github-release.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { parseReleaseAutomation } from "../config/automation.ts";
import { hasSameBumpPolicy, verifyPrevious } from "../proposal/verification.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { CandidateLandingPin } from "../config/repository.ts";
import type { ProposalPullRequest } from "../github-proposals.ts";
import {
  samePull,
  sameTree,
  readTagTarget,
  requireBaselineUnchanged,
  requireLandingOnCurrentMain,
  requireUnusedReleaseVersions,
} from "./evidence.ts";
import type { ReleaseTagRequest, ReleaseTagResult } from "./types.ts";

type CandidateEvidence = Map<
  number,
  { readonly pull: ProposalPullRequest; readonly pin: CandidateLandingPin }
>;

export function createReleaseLandingVerifier(
  scope: Pick<ReleaseTagRequest, "configuration" | "automation">,
  transport: GitHubRead = fetch,
) {
  const { configuration, automation } = structuredClone(scope);
  const candidates: CandidateEvidence = new Map();
  return (request: Omit<ReleaseTagRequest, "configuration" | "automation">) =>
    verifyLanding({ ...request, configuration, automation }, transport, candidates);
}

export function verifyReleaseLanding(request: ReleaseTagRequest, transport: GitHubRead = fetch) {
  return verifyLanding(request, transport);
}

async function verifyLanding(
  request: ReleaseTagRequest,
  transport: GitHubRead,
  candidates?: CandidateEvidence,
) {
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

  const deadline = AbortSignal.timeout(300_000);
  const repository = () =>
    new GitHubProposalRepository(configuration, automation.botUserId, token, transport, deadline);
  const api = repository();
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

  const verified = await verifyPrevious(
    api,
    pull,
    configuration,
    automation.botUserId,
    "tagged-history",
  );
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

  const captured = verified.snapshot.configuration;
  const historicalBumps = !hasSameBumpPolicy(captured, configuration);
  if (historicalBumps && (await readTagTarget(api, `v${verified.nextVersion}`)) !== landingSha)
    throw new ProposalConflictError(
      "A changed bump policy requires the original release tag at the verified landing. Finish the pending release with its original configuration.",
    );
  if (captured.candidateStableNotes !== undefined) {
    if (baseline.kind !== "tag")
      throw new ProposalConflictError("Stable notes recovery requires a verified stable tag.");
    const contents = await api.contents(await api.tree(baseline.commitSha));
    if (
      taggedReleaseNotes(contents["CHANGELOG.md"] ?? "", baseline.name.slice(1)) !==
      captured.candidateStableNotes
    )
      throw new ProposalConflictError("Recovered stable notes differ from the verified baseline.");
  }
  if (captured.candidateLandings) {
    // A verified stable landing pins the candidate chain produced under its policy.
    const { releaseBumps: _releaseBumps, ...current } = configuration;
    const candidateConfiguration = {
      ...current,
      releasePolicy: captured.releasePolicy,
      ...(captured.releaseBumps === undefined ? {} : { releaseBumps: captured.releaseBumps }),
    };
    let previous = baseline.commitSha;
    for (const pin of captured.candidateLandings) {
      const earlierPull = await api.readPull(pin.pullNumber);
      if (
        earlierPull.state !== "closed" ||
        !earlierPull.merged ||
        earlierPull.mergeCommitSha !== pin.landingSha
      )
        throw new ProposalConflictError(
          "A prior candidate exclusion no longer matches its merged proposal.",
        );

      const cached = candidates?.get(pin.pullNumber);
      let earlierPin: CandidateLandingPin;
      if (cached && samePull(cached.pull, earlierPull)) {
        earlierPin = cached.pin;
      } else {
        // Each replay has its own request cap under the shared reconciliation deadline.
        const history = repository();
        const earlier = await verifyPrevious(
          history,
          earlierPull,
          candidateConfiguration,
          automation.botUserId,
        );
        const earlierLanding = await history.tree(pin.landingSha);
        if (
          !sameTree(earlierLanding, earlier.head) ||
          (JSON.stringify(earlierLanding.parents) !== JSON.stringify([earlier.source.commitSha]) &&
            JSON.stringify(earlierLanding.parents) !==
              JSON.stringify([earlier.source.commitSha, earlier.head.commitSha]))
        )
          throw new ProposalConflictError(
            "A prior candidate exclusion no longer matches its merged proposal.",
          );
        earlierPin = candidateLandingPin(earlierPull, pin.landingSha, earlier);
      }
      if (!isDeepStrictEqual(pin, earlierPin))
        throw new ProposalConflictError(
          "A prior candidate exclusion no longer matches its merged proposal.",
        );

      if (previous === pin.landingSha)
        throw new ProposalConflictError("Candidate exclusion repeats the stable baseline.");
      await api.requireDescendant(previous, pin.landingSha);
      candidates?.set(pin.pullNumber, { pull: earlierPull, pin: earlierPin });
      previous = pin.landingSha;
    }
    await api.requireDescendant(previous, sourceSha);
  }

  candidates?.set(pullNumber, {
    pull: { ...pull },
    pin: candidateLandingPin(pull, landingSha, verified),
  });

  return {
    api,
    configuration,
    verified,
    baseline,
    pull,
    landingSha,
    pullNumber,
    write,
    historicalBumps,
  };
}

export async function reconcileReleaseTag(
  request: ReleaseTagRequest,
  transport: GitHubRead = fetch,
  beforePublication?: () => Promise<void>,
): Promise<ReleaseTagResult> {
  const {
    api,
    configuration,
    verified,
    baseline,
    pull,
    landingSha,
    pullNumber,
    write,
    historicalBumps,
  } = await verifyReleaseLanding(request, transport);
  if (configuration.internalPublication && write && !beforePublication)
    throw new ProposalConflictError(
      "Internal stable publication requires the container publisher.",
    );

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
      write && !historicalBumps,
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
        await beforePublication?.();
      },
      configuration.internalPublication === true,
    );
    if (historicalBumps && write && release.outcome === "would-create")
      throw new ProposalConflictError(
        "Finish the pending GitHub Release with its original bump policy.",
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

  if (historicalBumps)
    throw new ProposalConflictError("The historical release tag disappeared during verification.");
  const freshBootstrap = configuration.freshSeries !== undefined && baseline.kind === "bootstrap";
  if (!write) {
    if (freshBootstrap) await requireUnusedReleaseVersions(api);
    return finish("would-create");
  }

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

  if (freshBootstrap) await requireUnusedReleaseVersions(api);
  await beforePublication?.();
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
