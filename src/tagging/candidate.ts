import { createHash } from "node:crypto";
import type { CandidateLandingPin } from "../config/repository.ts";
import { taggedReleaseNotes } from "../github-release.ts";
import type { ProposalPullRequest } from "../github-proposals.ts";
import type { VerifiedProposal } from "../proposal/verification.ts";

export function candidateLandingPin(
  pull: ProposalPullRequest,
  landingSha: string,
  verified: VerifiedProposal,
): CandidateLandingPin {
  return {
    pullNumber: pull.number,
    botUserId: verified.identity.botUserId,
    headSha: verified.head.commitSha,
    landingSha,
    proposalId: verified.id,
    version: verified.nextVersion,
    changelogDigest: createHash("sha256")
      .update(taggedReleaseNotes(verified.changelog, verified.nextVersion))
      .digest("hex"),
  };
}
