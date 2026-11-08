import { validateConventionalMessage } from "./conventional.ts";
import type { ConventionalMetadata } from "./conventional.ts";
import { parseReleaseContext } from "./release-context.ts";
import type { ReleaseContextV1 } from "./release-context.ts";

export interface PullRequestCommit {
  readonly sha: string;
  readonly message: string;
  readonly parentCount: number;
}

export interface ReadinessIssue {
  readonly location: "title" | "context" | "commit";
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly sha?: string;
}

export type PullRequestReadiness =
  | {
      readonly valid: true;
      readonly title: ConventionalMetadata;
      readonly context: ReleaseContextV1;
      readonly warnings: readonly ReadinessIssue[];
    }
  | {
      readonly valid: false;
      readonly errors: readonly ReadinessIssue[];
      readonly warnings: readonly ReadinessIssue[];
    };

export async function validatePullRequestMetadata(
  title: string,
  body: string,
  commits: readonly PullRequestCommit[],
): Promise<PullRequestReadiness> {
  const errors: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  const context = parseReleaseContext(body);

  if (!context.valid) {
    errors.push(...context.errors.map((issue) => ({ ...issue, location: "context" as const })));
  }

  if (Buffer.byteLength(title, "utf8") > 1024 || /[\r\n]/u.test(title)) {
    return {
      valid: false,
      errors: [
        {
          location: "title",
          code: "title-invalid",
          message: "Use a single-line scoped PR title of at most 1 KiB.",
        },
        ...errors,
      ],
      warnings,
    };
  }

  const conventional = await validateConventionalMessage(title);
  warnings.push(
    ...conventional.warnings.map((issue) => ({
      location: "title" as const,
      code: issue.rule,
      message: issue.message,
    })),
  );

  if (!conventional.valid) {
    errors.push(
      ...conventional.errors.map((issue) => ({
        location: "title" as const,
        code: issue.rule,
        message: issue.message,
      })),
    );
  } else if (!conventional.commit.scope?.trim()) {
    errors.push({
      location: "title",
      code: "scope-empty",
      message: "Add a scope to the PR title, for example feat(api): add exports.",
    });
  }

  for (const commit of commits) {
    if (commit.parentCount > 1) {
      continue;
    }

    if (Buffer.byteLength(commit.message, "utf8") > 1024 * 1024) {
      errors.push({
        location: "commit",
        sha: commit.sha,
        code: "message-too-large",
        message: "Keep each commit message within 1 MiB.",
      });
      continue;
    }

    const result = await validateConventionalMessage(commit.message);
    warnings.push(
      ...result.warnings.map((issue) => ({
        location: "commit" as const,
        sha: commit.sha,
        code: issue.rule,
        message: issue.message,
      })),
    );

    if (!result.valid) {
      errors.push(
        ...result.errors.map((issue) => ({
          location: "commit" as const,
          sha: commit.sha,
          code: issue.rule,
          message: issue.message,
        })),
      );
      continue;
    }

    if (result.commit.scope !== null) {
      errors.push({
        location: "commit",
        sha: commit.sha,
        code: "scope-empty",
        message:
          "Remove the commit subject scope; commits are unscoped, while PR titles are scoped.",
      });
    }

    if (result.commit.breaking && conventional.valid && !conventional.commit.breaking) {
      errors.push({
        location: "title",
        sha: commit.sha,
        code: "breaking-conflict",
        message:
          "A commit declares a breaking change. Add ! to the PR title and review required_action.",
      });
    }
  }

  if (
    conventional.valid &&
    conventional.commit.breaking &&
    context.valid &&
    context.context.requiredAction === null
  ) {
    errors.push({
      location: "context",
      field: "required_action",
      code: "breaking-action-required",
      message: "Describe the required action for this breaking change instead of null.",
    });
  }

  if (errors.length > 0 || !conventional.valid || !context.valid) {
    return { valid: false, errors, warnings };
  }

  return { valid: true, title: conventional.commit, context: context.context, warnings };
}
