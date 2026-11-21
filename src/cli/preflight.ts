import { fileURLToPath } from "node:url";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import { GitInspectionError, inspectBranchSource } from "../git.ts";
import { activeProducerSha } from "../producer-runtime.ts";
import { preflightRelease } from "../release-preflight.ts";
import { readText, required, UsageError } from "./input.ts";

export async function runPreflight(options: ReadonlyMap<string, string | true>): Promise<string> {
  const repository = required(options, "repository");
  const producerSha = required(options, "producer-sha");
  const initialVersion = required(options, "initial-version");
  if (initialVersion !== "0.1.0" || !/^[a-f0-9]{40}$/u.test(producerSha))
    throw new UsageError("Select initial version 0.1.0 and a reviewed full producer SHA.");
  const active =
    activeProducerSha() ??
    (await inspectBranchSource(fileURLToPath(new URL("../", import.meta.url)), "HEAD"));
  if (producerSha !== active)
    throw new UsageError(
      "The running producer does not match --producer-sha. Run the CLI from the selected reviewed revision.",
    );

  const configPath = options.get("config");
  const fixed = typeof configPath === "string";
  if (
    fixed &&
    ["target", "repository-id", "release-branch", "baseline-sha", "onboarding-sha"].some((name) =>
      options.has(name),
    )
  )
    throw new UsageError(
      "Use --config by itself for a fixed range, or supply the target and optional boundaries.",
    );
  const configuration = fixed
    ? parseReleaseInputConfiguration(JSON.parse(await readText(configPath, 1024 * 1024)) as unknown)
    : parseReleaseInputConfiguration({
        schemaVersion: 1,
        repository: required(options, "target"),
        repositoryId: Number(required(options, "repository-id")),
        releaseBranch: required(options, "release-branch"),
        releasePolicy: "release-policy-v1",
        contextPolicy: "required",
        changelog: { verbosity: "concise", format: "compact" },
      });
  if (fixed && configuration.schemaVersion !== 2)
    throw new UsageError("A fixed initialization range requires a schema version 2 configuration.");
  if (
    /[\s~^:?*[\\]/u.test(configuration.releaseBranch) ||
    configuration.releaseBranch.includes("${{")
  )
    throw new UsageError("Select a literal Git release branch.");
  const source = options.get("source");
  const candidate = options.get("candidate-sha");
  const baseline =
    configuration.schemaVersion === 2
      ? configuration.bootstrap.baselineSha
      : options.get("baseline-sha");
  const onboarding =
    configuration.schemaVersion === 2
      ? configuration.bootstrap.onboardingSha
      : options.get("onboarding-sha");
  const sha = /^[a-f0-9]{40}$/u;
  if (
    [source, candidate, baseline, onboarding].some(
      (value) => value !== undefined && (typeof value !== "string" || !sha.test(value)),
    )
  )
    throw new UsageError(
      "Preflight source, candidate, baseline and onboarding options require full GitHub commit SHAs.",
    );

  let sourceSha = typeof source === "string" ? source : null;
  if (sourceSha === null) {
    try {
      sourceSha = await inspectBranchSource(
        repository,
        `refs/heads/${configuration.releaseBranch}`,
      );
    } catch (error) {
      if (error instanceof GitInspectionError)
        throw new UsageError(
          "The release branch has no accessible commit. Fetch it, or create a first commit with a root package.json, pyproject.toml or Cargo.toml with a static release version.",
        );
      throw error;
    }
  }
  const appToken = process.env.RELEASE_LOG_APP_TOKEN;
  const installationToken = process.env.RELEASE_LOG_PREFLIGHT_INSTALLATION_TOKEN;
  const token = process.env.GITHUB_TOKEN;
  const actions = process.env.RELEASE_LOG_PREFLIGHT_ACTIONS === "true";
  if (
    actions &&
    (!fixed ||
      candidate ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.GITHUB_REF !== `refs/heads/${configuration.releaseBranch}` ||
      process.env.GITHUB_SHA !== sourceSha ||
      process.env.GITHUB_REPOSITORY !== configuration.repository ||
      Number(process.env.GITHUB_REPOSITORY_ID) !== configuration.repositoryId)
  )
    throw new UsageError(
      "App verification requires the reviewed manual caller on the captured release branch.",
    );

  const result = await preflightRelease({
    repository,
    configuration,
    initialVersion,
    producerSha,
    sourceSha,
    ...(typeof baseline === "string" ? { baselineSha: baseline } : {}),
    ...(typeof onboarding === "string" ? { onboardingSha: onboarding } : {}),
    ...(typeof candidate === "string" ? { candidateSha: candidate } : {}),
    ...(token ? { token } : {}),
    ...(actions
      ? {
          app: {
            appId: process.env.RELEASE_LOG_PREFLIGHT_APP_ID ?? "",
            botUserId: process.env.RELEASE_LOG_PREFLIGHT_BOT_ID ?? "",
            hasPrivateKey: process.env.RELEASE_LOG_PREFLIGHT_HAS_KEY === "true",
            installation: process.env.RELEASE_LOG_PREFLIGHT_INSTALLATION ?? "skipped",
            permissions: process.env.RELEASE_LOG_PREFLIGHT_PERMISSIONS ?? "skipped",
            slug: process.env.RELEASE_LOG_PREFLIGHT_APP_SLUG ?? "",
            ...(appToken ? { token: appToken } : {}),
            ...(installationToken ? { installationToken } : {}),
          },
        }
      : {}),
  });
  if (result.status === "blocked" || result.findings.history?.status !== "passed")
    process.exitCode = 1;
  return JSON.stringify(result, null, 2) + "\n";
}
