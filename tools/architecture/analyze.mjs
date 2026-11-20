import { cruise } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import config, { runtimeRules } from "./dependency-cruiser.config.mjs";

export async function analyzeSource() {
  const tsConfig = extractTSConfig(config.options.tsConfig.fileName);
  /** @param {import("dependency-cruiser").IForbiddenRuleType[]} forbidden
   * @param {boolean} includeTypes
   */
  async function run(forbidden, includeTypes) {
    const ruleSet = {
      ...config,
      forbidden,
    };
    const result = await cruise(
      ["src"],
      { ...config.options, tsPreCompilationDeps: includeTypes, validate: true, ruleSet },
      undefined,
      { tsConfig },
    );
    if (typeof result.output === "string") throw new Error("Expected an architecture graph");
    return result.output;
  }
  return { ownership: await run(config.forbidden, true), runtime: await run(runtimeRules, false) };
}
