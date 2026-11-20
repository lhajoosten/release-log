import { validateConventionalMessage } from "./conventional.ts";
import type { ConventionalMetadata } from "./conventional.ts";
import { isReleaseContextPolicy, parseReleaseContext } from "./release-context.ts";
import type { ReleaseContextPolicy, ReleaseContextV1 } from "./release-context.ts";

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
      readonly context: ReleaseContextV1 | null;
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
  contextPolicy: ReleaseContextPolicy = "required",
): Promise<PullRequestReadiness> {
  if (!isReleaseContextPolicy(contextPolicy))
    throw new TypeError("Context policy must be required or optional.");

  const errors: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  const context = parseReleaseContext(body);

  const missingAllowed =
    contextPolicy === "optional" &&
    !context.valid &&
    context.errors.length === 1 &&
    context.errors[0]?.code === "block-missing";

  if (!context.valid) {
    const issues = missingAllowed ? warnings : errors;
    issues.push(
      ...context.errors.map((issue) => ({
        ...issue,
        location: "context" as const,
        ...(missingAllowed
          ? {
              message:
                "Release context is missing; audience and impact are unknown. Review the linked PR.",
            }
          : {}),
      })),
    );
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

  if (missingAllowed && conventional.valid && conventional.commit.breaking) {
    warnings.push({
      location: "context",
      field: "required_action",
      code: "breaking-action-missing",
      message: "Migration instructions are missing for this breaking change; review the linked PR.",
    });
  }

  if (errors.length > 0 || !conventional.valid || (!context.valid && !missingAllowed)) {
    return { valid: false, errors, warnings };
  }

  return {
    valid: true,
    title: conventional.commit,
    context: context.valid ? context.context : null,
    warnings,
  };
}
