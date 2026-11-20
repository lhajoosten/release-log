import type { ReleaseAutomationConfiguration } from "../config/automation.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseVersionConfiguration } from "../planning/derive-release-plan.ts";

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

export function cycleError(code: ReleaseCycleErrorCode, message: string): never {
  throw new ReleaseCycleError(code, message);
}
