import type { GitCommitEvidence, PendingReleaseInspection } from "../git.ts";
import type { VerifiedReleaseApproval } from "../approval/record.ts";

export interface PullRequestCommitEvidence {
  readonly sha: string;
  readonly message: string;
  readonly parentShas: readonly string[];
}

export interface CapturedPullRequest {
  readonly number: number;
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly mergedAt: string;
  readonly mergeCommitSha: string;
  readonly commitCount: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepositoryId: number | null;
  readonly baseRepositoryId: number;
  readonly authorId: number | null;
  readonly authorType: string;
  readonly authorLogin?: string | null;
}

export interface StackBase {
  readonly ref: string;
  readonly sha: string;
}

export interface SquashStackEvidence {
  readonly base: StackBase;
  readonly originalBaseTree: string;
  readonly originalHeadTree: string;
  readonly landedBaseTree: string;
  readonly landedHeadTree: string;
}

export interface AssociatedPullRequest extends CapturedPullRequest {
  readonly url: string;
  readonly landingKind: "merge" | "linear";
  readonly stackBase?: StackBase;
  readonly squashStack?: SquashStackEvidence;
  readonly originalCommits: readonly PullRequestCommitEvidence[];
  readonly landedCommits: readonly GitCommitEvidence[];
}

export interface PullRequestAssociation {
  readonly repository: string;
  readonly releaseBranch: string;
  readonly range: PendingReleaseInspection;
  readonly pullRequests: readonly AssociatedPullRequest[];
  readonly bootstrapCommits?: readonly GitCommitEvidence[];
  readonly verifiedAutomation?: readonly VerifiedReleaseApproval[];
}
