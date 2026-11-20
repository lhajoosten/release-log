import type { ReleaseAutomationConfiguration } from "../config/automation.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import type { TaggedGitHubReleaseResult } from "../github-release.ts";

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
  readonly release?: TaggedGitHubReleaseResult;
}
