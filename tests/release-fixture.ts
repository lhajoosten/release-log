import { captureReleaseSnapshot, serializeReleaseSnapshot } from "../src/release-snapshot.ts";
import type { ReleaseInputConfiguration } from "../src/release-snapshot.ts";

export const fixtureConfiguration: ReleaseInputConfiguration = {
  schemaVersion: 1,
  repository: "example/project",
  repositoryId: 17,
  releaseBranch: "main",
  releasePolicy: "release-policy-v1",
};

export async function releaseFixture(
  changes: readonly {
    title: string;
    audience?: "internal" | "users";
    action?: string | null;
    message?: string;
    summary?: string;
    impact?: string;
  }[],
  releasedVersion: string | null = "1.2.3",
  bootstrapMessages: readonly string[] = [],
) {
  const baseline = "0".repeat(40);
  const bootstrapCommits = bootstrapMessages.map((message, index) => ({
    sha: (index + 1).toString(16).padStart(40, "0"),
    parentShas: [index.toString(16).padStart(40, "0")],
    message,
  }));

  const pulls = changes.map((change, index) => {
    const sha = (bootstrapCommits.length + index + 1).toString(16).padStart(40, "0");
    const parent = (bootstrapCommits.length + index).toString(16).padStart(40, "0");

    const commit = {
      sha,
      parentShas: [parent],
      message: change.message ?? "chore: retain source evidence\n",
    };

    return {
      number: index + 1,
      id: index + 1001,
      title: change.title,
      body: [
        "```release-log",
        "version: 1",
        `audience: ${change.audience ?? "users"}`,
        `summary: ${JSON.stringify(change.summary ?? "Preserve selected rows.")}`,
        `impact: ${JSON.stringify(change.impact ?? "Keep the selection.")}`,
        `required_action: ${JSON.stringify(change.action ?? null)}`,
        "```",
      ].join("\n"),
      updatedAt: "2026-11-08T10:00:00Z",
      mergedAt: "2026-11-08T09:00:00Z",
      mergeCommitSha: sha,
      commitCount: 1,
      headSha: sha,
      headRef: "feature",
      headRepositoryId: 23,
      baseRepositoryId: 17,
      authorId: 7,
      authorType: "User",
      url: `https://github.com/example/project/pull/${index + 1}`,
      landingKind: "linear" as const,
      originalCommits: [commit],
      landedCommits: [commit],
    };
  });

  const snapshot = await captureReleaseSnapshot(
    {
      repository: "example/project",
      releaseBranch: "main",
      range: {
        baseline:
          releasedVersion === null
            ? { kind: "bootstrap", commitSha: baseline }
            : {
                kind: "tag",
                name: `v${releasedVersion}`,
                objectSha: baseline,
                commitSha: baseline,
              },
        sourceCommitSha: pulls.at(-1)?.mergeCommitSha ?? bootstrapCommits.at(-1)?.sha ?? baseline,
        baselineIsAncestor: true,
        commitShas: [
          ...bootstrapCommits.map((entry) => entry.sha),
          ...pulls.map((pull) => pull.mergeCommitSha),
        ],
      },
      pullRequests: pulls,
      bootstrapCommits,
    },
    fixtureConfiguration,
  );

  return { snapshot, serialized: await serializeReleaseSnapshot(snapshot) };
}
