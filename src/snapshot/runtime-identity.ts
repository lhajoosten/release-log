import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { conventionalPolicyId } from "../conventional.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { canonical } from "./canonical.ts";

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function runtimeIdentity(): { version: string; normalizerId: string } {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !("dependencies" in manifest) ||
    typeof manifest.dependencies !== "object" ||
    manifest.dependencies === null
  )
    throw new Error(
      "The trusted tool manifest must supply its version and pinned runtime dependencies.",
    );
  return {
    version: manifest.version,
    normalizerId: digest({
      normalizationVersion: 4,
      conventionalPolicyId,
      dependencies: manifest.dependencies,
      lockfileId: createHash("sha256")
        .update(
          readFileSync(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "../../pnpm-lock.yaml"
                : "../../dependency-lock.txt",
              import.meta.url,
            ),
          ),
        )
        .digest("hex"),
    }),
  };
}

const tool = runtimeIdentity();
const exclusionTool = {
  ...tool,
  normalizerId: digest({ baseNormalizerId: tool.normalizerId, exclusionNormalizationVersion: 1 }),
};

export function snapshotTool(config: ReleaseInputConfiguration): typeof tool {
  const base = config.automationExclusions ? exclusionTool : tool;

  // Keep prior strict captures replayable; explicit policy opts into this revision.
  return config.contextPolicy === undefined
    ? { ...base }
    : {
        ...base,
        normalizerId: digest({
          baseNormalizerId: base.normalizerId,
          contextPolicyNormalizationVersion: 1,
        }),
      };
}
