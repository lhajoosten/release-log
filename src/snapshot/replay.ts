import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import {
  ReleaseSnapshotError,
  invalid,
  isObject,
  limit,
  object,
  text,
} from "../evidence/schema.ts";
import { canonical, maximumBytes, encodeVerifiedSnapshot } from "./canonical.ts";
import { captureReleaseSnapshot } from "./capture.ts";
import { association } from "./evidence.ts";
import type { ReleaseSnapshot } from "./model.ts";
import { digest, snapshotTool } from "./runtime-identity.ts";

async function validateSnapshot(
  value: unknown,
  expected: ReleaseInputConfiguration,
): Promise<ReleaseSnapshot> {
  canonical(value);
  const item = object(
    value,
    [
      "schemaVersion",
      "tool",
      "configuration",
      "configurationId",
      "input",
      "normalized",
      "snapshotId",
      ...(isObject(value) && value.schemaVersion === 5 ? ["capturedAt"] : []),
    ],
    "snapshot envelope",
  );
  if (item.schemaVersion !== 3 && item.schemaVersion !== 4 && item.schemaVersion !== 5)
    return invalid(
      "Unsupported release snapshot schema version; no automatic migration is performed.",
    );
  const capturedTool = object(item.tool, ["version", "normalizerId"], "tool identity");
  const config = parseReleaseInputConfiguration(item.configuration);
  const expectedTool = snapshotTool(config);

  if (
    capturedTool.version !== expectedTool.version ||
    capturedTool.normalizerId !== expectedTool.normalizerId
  )
    throw new ReleaseSnapshotError(
      "normalizer-mismatch",
      "Replay requires the captured tool version, normalization policy, and runtime dependency versions.",
    );
  if (
    digest(config) !== digest(parseReleaseInputConfiguration(expected)) ||
    item.configurationId !== digest(config)
  )
    throw new ReleaseSnapshotError(
      "configuration-mismatch",
      "Replay configuration differs from the captured configuration identity.",
    );
  if (item.schemaVersion !== 5 && item.schemaVersion !== (config.automationExclusions ? 4 : 3))
    return invalid("Snapshot schema does not match its pinned exclusion policy.");

  object(
    item.input,
    [
      "repository",
      "releaseBranch",
      "range",
      "pullRequests",
      "bootstrapCommits",
      ...(config.automationExclusions ? ["verifiedAutomation"] : []),
    ],
    "versioned association evidence",
  );

  const captured = association(item.input, config, item.schemaVersion === 5);
  const recomputed = await captureReleaseSnapshot(
    captured,
    config,
    item.schemaVersion === 5 ? text(item.capturedAt, "capture time", 24) : undefined,
  );
  if (
    canonical(item.normalized) !== canonical(recomputed.normalized) ||
    item.snapshotId !== recomputed.snapshotId
  )
    throw new ReleaseSnapshotError(
      "integrity-mismatch",
      "Snapshot identity or normalized output differs from replayed inputs; refresh and review rather than accepting edits.",
    );
  return recomputed;
}

export async function serializeReleaseSnapshot(snapshot: ReleaseSnapshot): Promise<string> {
  const validated = await validateSnapshot(snapshot, snapshot.configuration);
  return encodeVerifiedSnapshot(validated);
}

export async function replayReleaseSnapshot(
  serialized: string,
  expected: ReleaseInputConfiguration,
): Promise<ReleaseSnapshot> {
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes)
    return limit("Snapshot exceeds 16 MiB in UTF-8.");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return invalid("Snapshot is not valid JSON.");
  }
  return validateSnapshot(value, expected);
}
