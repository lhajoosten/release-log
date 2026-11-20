import { renderPlannedChangelog } from "./changelog/render.ts";
import { deriveReleasePlan } from "./planning/derive-release-plan.ts";
import type { ReleaseVersionConfiguration } from "./planning/derive-release-plan.ts";
import type { ReleaseInputConfiguration } from "./config/repository.ts";
import { replayReleaseSnapshot } from "./snapshot/replay.ts";

export { ChangelogError } from "./changelog/bounds.ts";
export { updateChangelog } from "./changelog/history.ts";
export { sectionEmojis, encodeComparisonRef, contributorAttribution } from "./changelog/render.ts";

export async function renderChangelog(
  serializedSnapshot: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
): Promise<string | null> {
  const snapshot = await replayReleaseSnapshot(serializedSnapshot, expected);
  return renderPlannedChangelog(snapshot, deriveReleasePlan(snapshot, version));
}
