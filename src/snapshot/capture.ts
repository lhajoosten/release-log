import { readHistoricalBreakingChanges, validateConventionalMessage } from "../conventional.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { ReleaseSnapshotError, invalid } from "../evidence/schema.ts";
import { validatePullRequestMetadata } from "../pr-readiness.ts";
import { parseReleaseContext } from "../release-context.ts";
import type { PullRequestAssociation } from "./association.ts";
import { canonical } from "./canonical.ts";
import { association } from "./evidence.ts";
import { onboardingCommits } from "./graph.ts";
import type {
  HistoricalReleaseEntry,
  NormalizedBootstrapCommit,
  NormalizedReleaseInputs,
  ReleaseSnapshot,
} from "./model.ts";
import { digest, snapshotTool } from "./runtime-identity.ts";

export async function captureReleaseSnapshot(
  input: PullRequestAssociation,
  config: ReleaseInputConfiguration,
  capturedAt?: string,
): Promise<ReleaseSnapshot> {
  if (
    capturedAt !== undefined &&
    (typeof capturedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(capturedAt) ||
      !Number.isFinite(Date.parse(capturedAt)) ||
      new Date(capturedAt).toISOString() !== capturedAt)
  )
    return invalid("Capture time must be a canonical UTC ISO timestamp with milliseconds.");
  canonical(input);
  const selected = parseReleaseInputConfiguration(config);
  const captured = association(input, selected, capturedAt !== undefined);
  const pullRequests: NormalizedReleaseInputs["pullRequests"][number][] = [];
  const historicalEntries: HistoricalReleaseEntry[] = [];
  const excludedPullRequests: NonNullable<
    NormalizedReleaseInputs["excludedPullRequests"]
  >[number][] = [];
  const historical = onboardingCommits(captured, selected);

  for (const pull of captured.pullRequests) {
    const proof = captured.verifiedAutomation?.find((entry) => entry.pullNumber === pull.number);

    if (proof) {
      excludedPullRequests.push({
        number: pull.number,
        url: pull.url,
        verificationId: proof.verificationId,
        commitShas: proof.automationCommitShas,
      });
      continue;
    }

    const sourceCommits = [
      ...pull.originalCommits.map((entry) => ({ source: "original" as const, ...entry })),
      ...pull.landedCommits.map((entry) => ({ source: "landed" as const, ...entry })),
    ];
    // Historical adoption keeps its own warning-bearing normalization contract.
    const historicalPull = pull.landedCommits.every((entry) => historical.has(entry.sha));
    const readiness = await validatePullRequestMetadata(
      pull.title,
      pull.body,
      sourceCommits.map((entry) => ({
        sha: entry.sha,
        message: entry.message,
        parentCount: entry.parentShas.length,
      })),
      historicalPull ? "required" : selected.contextPolicy,
    );
    if (!readiness.valid && historicalPull) {
      const context = parseReleaseContext(pull.body);
      const explanations = await Promise.all([
        readHistoricalBreakingChanges(pull.title),
        ...sourceCommits
          .filter((entry) => entry.parentShas.length < 2)
          .map((entry) => readHistoricalBreakingChanges(entry.message)),
      ]);

      historicalEntries.push({
        source: { kind: "pull-request", number: pull.number, url: pull.url },
        title: pull.title,
        context: context.valid ? context.context : null,
        breakingChanges: [...new Set(explanations.flat())].toSorted(),
        warnings: [...readiness.errors, ...readiness.warnings],
      });

      continue;
    }

    if (!readiness.valid)
      throw new ReleaseSnapshotError(
        "metadata-invalid",
        `PR #${pull.number} release metadata must be repaired before snapshot capture.`,
        readiness.errors,
      );
    const context = parseReleaseContext(pull.body);
    const commits: NormalizedReleaseInputs["pullRequests"][number]["commits"][number][] = [];
    for (const entry of sourceCommits) {
      if (entry.parentShas.length > 1) continue;
      const metadata = await validateConventionalMessage(entry.message);
      if (!metadata.valid)
        throw new ReleaseSnapshotError(
          "metadata-invalid",
          `PR #${pull.number} commit validation did not succeed.`,
        );
      commits.push({ source: entry.source, sha: entry.sha, metadata: metadata.commit });
    }
    pullRequests.push({
      number: pull.number,
      url: pull.url,
      title: readiness.title,
      context: readiness.context,
      rawBlock: context.valid ? context.rawBlock : null,
      breakingChanges: [
        ...new Set([
          ...readiness.title.breakingChanges,
          ...commits.flatMap((entry) => entry.metadata.breakingChanges),
        ]),
      ].toSorted(),
      commits,
      validation: { valid: true, warnings: readiness.warnings },
    });
  }

  const bootstrapCommits: NormalizedBootstrapCommit[] = [];

  for (const entry of captured.bootstrapCommits) {
    if (historical.has(entry.sha)) {
      historicalEntries.push({
        source: {
          kind: "commit",
          sha: entry.sha,
          url: `https://github.com/${selected.repository}/commit/${entry.sha}`,
        },
        title: entry.message.split(/\r\n|\n|\r/u)[0] || "(empty historical commit message)",
        context: null,
        breakingChanges: await readHistoricalBreakingChanges(entry.message),
        warnings: [
          {
            location: "commit",
            sha: entry.sha,
            code: entry.parentShas.length > 1 ? "historical-merge" : "historical-commit",
            message:
              "Retained historical Git evidence without structured PR release context; review before the initial release.",
          },
        ],
      });

      continue;
    }

    const metadata = await validateConventionalMessage(entry.message);

    if (!metadata.valid)
      throw new ReleaseSnapshotError(
        "metadata-invalid",
        `Bootstrap commit ${entry.sha} requires a valid conventional message; no type or release context is inferred.`,
        metadata.errors.map((issue) => ({
          location: "commit",
          sha: entry.sha,
          code: issue.rule,
          message: issue.message,
        })),
      );

    bootstrapCommits.push({
      sha: entry.sha,
      url: `https://github.com/${selected.repository}/commit/${entry.sha}`,
      metadata: metadata.commit,
    });
  }

  const payload = {
    schemaVersion:
      capturedAt !== undefined
        ? (5 as const)
        : selected.automationExclusions
          ? (4 as const)
          : (3 as const),
    ...(capturedAt !== undefined ? { capturedAt } : {}),
    tool: snapshotTool(selected),
    configuration: selected,
    configurationId: digest(selected),
    input: captured,
    normalized: {
      repository: selected.repository,
      releaseBranch: selected.releaseBranch,
      baselineCommitSha: captured.range.baseline.commitSha,
      sourceCommitSha: captured.range.sourceCommitSha,
      pullRequests,
      bootstrapCommits,
      historicalEntries,
      ...(selected.automationExclusions ? { excludedPullRequests } : {}),
    },
  };
  const snapshot = { ...payload, snapshotId: digest(payload) };
  canonical(snapshot);
  return snapshot;
}
