import { renderChangelog } from "../changelog.ts";
import { createReleasePlan } from "../release-plan.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { readVersionedInput, versionOptions } from "./versioned-input.ts";
import type { VersionedInput, VersionOptions } from "./versioned-input.ts";

interface PlanningRequest extends VersionedInput {
  readonly configuration: ReleaseInputConfiguration;
}

function planningCommand(execute: (request: PlanningRequest) => Promise<string>) {
  return {
    options: versionOptions,
    async run(options: VersionOptions, configuration: ReleaseInputConfiguration): Promise<string> {
      return execute({ configuration, ...(await readVersionedInput(options)) });
    },
  };
}

export const planningCommands = new Map([
  [
    "plan",
    planningCommand(async ({ snapshot, configuration, version }) => {
      const plan = await createReleasePlan(snapshot, configuration, version);
      return JSON.stringify(plan, null, 2) + "\n";
    }),
  ],
  [
    "render",
    planningCommand(
      async ({ snapshot, configuration, version }) =>
        (await renderChangelog(snapshot, configuration, version)) ?? "",
    ),
  ],
]);
