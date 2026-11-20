import type { ReleaseInputConfiguration } from "../config/repository.ts";
import type { ConventionalMetadata } from "../conventional.ts";
import type { ReadinessIssue } from "../evidence/readiness-issue.ts";
import type { GitCommitEvidence } from "../git.ts";
import type { ReleaseContextV1 } from "../release-context.ts";
import type { PullRequestAssociation } from "./association.ts";

export interface NormalizedBootstrapCommit {
  readonly sha: string;
  readonly url: string;
  readonly metadata: ConventionalMetadata;
}

export interface HistoricalReleaseEntry {
  readonly source:
    | { readonly kind: "pull-request"; readonly number: number; readonly url: string }
    | { readonly kind: "commit"; readonly sha: string; readonly url: string };
  readonly title: string;
  readonly context: ReleaseContextV1 | null;
  readonly breakingChanges: readonly string[];
  readonly warnings: readonly ReadinessIssue[];
}

export interface NormalizedReleaseInputs {
  readonly repository: string;
  readonly releaseBranch: string;
  readonly baselineCommitSha: string;
  readonly sourceCommitSha: string;
  readonly bootstrapCommits: readonly NormalizedBootstrapCommit[];
  readonly historicalEntries: readonly HistoricalReleaseEntry[];
  readonly excludedPullRequests?: readonly {
    readonly number: number;
    readonly url: string;
    readonly verificationId: string;
    readonly commitShas: readonly string[];
  }[];
  readonly pullRequests: readonly {
    readonly number: number;
    readonly url: string;
    readonly title: ConventionalMetadata;
    readonly context: ReleaseContextV1 | null;
    readonly rawBlock: string | null;
    readonly breakingChanges: readonly string[];
    readonly commits: readonly {
      readonly source: "original" | "landed";
      readonly sha: string;
      readonly metadata: ConventionalMetadata;
    }[];
    readonly validation: { readonly valid: true; readonly warnings: readonly ReadinessIssue[] };
  }[];
}

export interface ReleaseSnapshot {
  readonly schemaVersion: 3 | 4 | 5;
  readonly capturedAt?: string;
  readonly tool: { readonly version: string; readonly normalizerId: string };
  readonly configuration: ReleaseInputConfiguration;
  readonly configurationId: string;
  readonly input: PullRequestAssociation & {
    readonly bootstrapCommits: readonly GitCommitEvidence[];
  };
  readonly normalized: NormalizedReleaseInputs;
  readonly snapshotId: string;
}
