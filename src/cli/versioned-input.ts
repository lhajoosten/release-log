import type { ReleaseVersionConfiguration } from "../planning/derive-release-plan.ts";
import { readText, required, UsageError } from "./input.ts";

export const versionOptions = ["config", "snapshot", "current-version", "initial-version"] as const;
export type VersionOptions = Pick<
  ReadonlyMap<(typeof versionOptions)[number], string | true>,
  "get" | "has"
>;

export interface VersionedInput {
  readonly snapshot: string;
  readonly version: ReleaseVersionConfiguration;
}

export async function readVersionedInput(options: VersionOptions): Promise<VersionedInput> {
  if (options.has("current-version") === options.has("initial-version"))
    throw new UsageError("Select exactly one --current-version or --initial-version.");
  let version: ReleaseVersionConfiguration;
  if (options.has("initial-version")) {
    if (required(options, "initial-version") !== "0.1.0")
      throw new UsageError("The approved initial version is 0.1.0.");
    version = { kind: "bootstrap", initialVersion: "0.1.0" };
  } else version = { kind: "released", currentVersion: required(options, "current-version") };

  const snapshot = await readText(required(options, "snapshot"));
  return { snapshot, version };
}
