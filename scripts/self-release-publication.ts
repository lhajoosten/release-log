import { ProposalConflictError } from "../src/github-proposals.ts";
import type { CandidateLandingPin } from "../src/config/repository.ts";
import type { PublicationClaim } from "./self-release-state.ts";

export interface ReleaseImage {
  readonly digest: string;
  readonly configDigest: string;
}

export interface PublicationOperations {
  readonly readImage: () => Promise<ReleaseImage | null>;
  readonly checkQuality: (landingSha: string) => Promise<"passed" | "pending" | "failed">;
  readonly stage: () => Promise<void>;
  readonly publishImage: (
    beforePush: (configDigest: string) => Promise<void>,
  ) => Promise<ReleaseImage>;
  readonly claim: (claim: PublicationClaim) => Promise<void>;
  readonly checkActive: () => Promise<void>;
  readonly checkGitHub: () => Promise<boolean>;
  readonly publishGitHub: (beforeWrite: () => Promise<void>) => Promise<void>;
  readonly repairAliases: (image: ReleaseImage) => Promise<void>;
}

export async function publishInternalCandidate(
  candidate: CandidateLandingPin,
  claim: PublicationClaim | null,
  operations: PublicationOperations,
) {
  const tag = `v${candidate.version}`;
  if (
    claim &&
    (claim.pullNumber !== candidate.pullNumber ||
      claim.landingSha !== candidate.landingSha ||
      claim.proposalId !== candidate.proposalId ||
      claim.tag !== tag)
  )
    throw new ProposalConflictError("Publication journal does not match the verified candidate.");

  const current = await operations.readImage();
  const githubComplete = await operations.checkGitHub();
  const requireImage = async (image: ReleaseImage) => {
    const retained = await operations.readImage();
    if (retained?.digest !== image.digest || retained.configDigest !== image.configDigest)
      throw new ProposalConflictError("Immutable release image changed during reconciliation.");
  };

  if (claim?.complete) {
    if (
      !githubComplete ||
      current?.digest !== claim.manifestDigest ||
      current.configDigest !== claim.configDigest
    )
      throw new ProposalConflictError("Completed release no longer matches its immutable outputs.");
    await operations.repairAliases(current);
    return { outcome: "unchanged" as const, image: current };
  }

  if (
    current &&
    (!claim ||
      current.configDigest !== claim.configDigest ||
      (claim.manifestDigest !== null && current.digest !== claim.manifestDigest))
  )
    throw new ProposalConflictError(
      "Existing version image does not match journaled scan evidence.",
    );

  if (claim?.manifestDigest && !current)
    throw new ProposalConflictError("The previously observed version image is missing.");

  if (!current && !githubComplete) {
    const quality = await operations.checkQuality(candidate.landingSha);
    if (quality === "pending") return { outcome: "quality-pending" as const };
    if (quality === "failed") return { outcome: "quality-failed" as const };
  }

  let saved = claim;
  // Existing images pass smoke and the current policy by digest inside publishImage.
  if (!current) await operations.stage();
  const image = await operations.publishImage(async (configDigest) => {
    await operations.checkActive();
    if (await operations.readImage())
      throw new ProposalConflictError("Version image appeared before its first publication.");
    saved = {
      pullNumber: candidate.pullNumber,
      landingSha: candidate.landingSha,
      proposalId: candidate.proposalId,
      tag,
      configDigest,
      manifestDigest: null,
      complete: false,
    };
    await operations.claim(saved);
    await operations.checkActive();
    if (await operations.readImage())
      throw new ProposalConflictError("Version image appeared before push.");
  });
  if (!saved || saved.configDigest !== image.configDigest)
    throw new ProposalConflictError("Published image differs from journaled scan evidence.");

  const retained = { ...saved, manifestDigest: image.digest };
  if (saved.manifestDigest !== image.digest) await operations.claim(retained);
  await operations.publishGitHub(async () => {
    await operations.checkActive();
    await requireImage(image);
  });
  await requireImage(image);
  if (!(await operations.checkGitHub()))
    throw new ProposalConflictError("Stable tag or GitHub Release is incomplete.");
  await operations.claim({ ...retained, complete: true });
  await operations.repairAliases(image);
  return { outcome: "published" as const, image };
}
