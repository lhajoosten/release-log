import { replayReleaseSnapshot } from "./snapshot/replay.ts";
import type { ReleaseInputConfiguration } from "./config/repository.ts";
import { deriveReleasePlan } from "./planning/derive-release-plan.ts";
import type { ReleasePlan, ReleaseVersionConfiguration } from "./planning/derive-release-plan.ts";

export { ReleasePlanError } from "./planning/derive-release-plan.ts";
export type {
  ReleasePlan,
  ReleaseBump,
  ReleaseVersionConfiguration,
} from "./planning/derive-release-plan.ts";

export async function createReleasePlan(
  serializedSnapshot: string,
  expected: ReleaseInputConfiguration,
  selectedVersion: ReleaseVersionConfiguration,
): Promise<ReleasePlan> {
  const snapshot = await replayReleaseSnapshot(serializedSnapshot, expected);
  return deriveReleasePlan(snapshot, selectedVersion);
}
