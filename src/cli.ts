#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPendingRelease } from "./git.ts";
import { collectMergedPullRequests } from "./github-association.ts";
import { renderChangelog } from "./changelog.ts";
import { createReleasePlan } from "./release-plan.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import { prepareReleaseFiles, writeReleaseFiles } from "./proposal-files.ts";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  serializeReleaseSnapshot,
} from "./release-snapshot.ts";

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
const help = `release-log (Node.js >=26.13.0 <27; Git required only for collection)

  release-log collect --config FILE --repository DIR --source SHA
      (--baseline-tag TAG | --bootstrap-sha SHA)
  release-log plan|render --config FILE --snapshot FILE
      (--current-version VERSION | --initial-version 0.1.0)
  release-log prepare --config FILE --snapshot FILE --repository DIR
      (--current-version VERSION | --initial-version 0.1.0) [--dry-run | --write]
  release-log --help | --version

collect makes bounded read-only GitHub.com requests using GITHUB_TOKEN and emits
snapshot JSON. plan emits decision JSON; render emits Markdown (empty for no
release). prepare defaults to dry-run and emits plan/files JSON; only --write
changes fixed local proposal files. It supports package.json and pyproject.toml.
No command pushes, opens PRs, publishes, or executes consumer build scripts.
Exit codes: 0 success (including no release), 1 operation failure, 2 usage error.
`;

async function readText(path: string, maximum = 16 * 1024 * 1024): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum)
    throw new UsageError("Input must be an ordinary file within its size limit.");
  const result = await readFile(path, "utf8");
  if (Buffer.byteLength(result, "utf8") > maximum)
    throw new UsageError("Input exceeds its size limit.");
  return result;
}

function required(options: ReadonlyMap<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== "string" || !value) throw new UsageError(`Missing value for --${key}.`);
  return value;
}

async function runCLI(args: readonly string[]): Promise<string> {
  if (args.length === 1 && args[0] === "--version") {
    const manifest: unknown = JSON.parse(
      await readText(fileURLToPath(new URL("../package.json", import.meta.url)), 1024 * 1024),
    );
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    )
      throw new Error("Invalid tool version manifest.");
    return manifest.version + "\n";
  }
  if (!args.length || (args.length === 1 && args[0] === "--help")) return help;
  const command = args[0];
  const allowed =
    command === "collect"
      ? ["config", "repository", "source", "baseline-tag", "bootstrap-sha"]
      : command === "plan" || command === "render"
        ? ["config", "snapshot", "current-version", "initial-version"]
        : command === "prepare"
          ? [
              "config",
              "snapshot",
              "current-version",
              "initial-version",
              "repository",
              "dry-run",
              "write",
            ]
          : [];
  if (!allowed.length) throw new UsageError("Unknown command. Use --help for supported commands.");
  const options = new Map<string, string | true>();
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    const key = argument?.startsWith("--") ? argument.slice(2) : "";
    if (!allowed.includes(key) || options.has(key))
      throw new UsageError("Unknown, duplicate, or misplaced option. Use --help.");
    if (key === "dry-run" || key === "write") options.set(key, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new UsageError(`Missing value for --${key}.`);
      options.set(key, value);
    }
  }
  if (options.has("write") && options.has("dry-run"))
    throw new UsageError("--write and --dry-run are mutually exclusive.");
  const configJSON: unknown = JSON.parse(await readText(required(options, "config"), 1024 * 1024));
  const config = parseReleaseInputConfiguration(configJSON);
  if (command === "collect") {
    if (options.has("baseline-tag") === options.has("bootstrap-sha"))
      throw new UsageError("Select exactly one --baseline-tag or --bootstrap-sha.");
    const token = process.env.GITHUB_TOKEN;
    if (!token?.trim())
      throw new UsageError("collect requires GITHUB_TOKEN with repository/PR read access.");
    const repository = required(options, "repository");
    const baseline = options.has("baseline-tag")
      ? { kind: "tag" as const, name: required(options, "baseline-tag") }
      : { kind: "bootstrap" as const, commitSha: required(options, "bootstrap-sha") };
    const range = await inspectPendingRelease(repository, baseline, required(options, "source"));
    return serializeReleaseSnapshot(
      await captureReleaseSnapshot(
        await collectMergedPullRequests({
          repository: config.repository,
          releaseBranch: config.releaseBranch,
          localRepository: repository,
          range,
          token,
        }),
        config,
      ),
    );
  }
  if (options.has("current-version") === options.has("initial-version"))
    throw new UsageError("Select exactly one --current-version or --initial-version.");
  let version: ReleaseVersionConfiguration;
  if (options.has("initial-version")) {
    if (required(options, "initial-version") !== "0.1.0")
      throw new UsageError("The approved initial version is 0.1.0.");
    version = { kind: "bootstrap", initialVersion: "0.1.0" };
  } else version = { kind: "released", currentVersion: required(options, "current-version") };
  const snapshot = await readText(required(options, "snapshot"));
  if (command === "plan")
    return JSON.stringify(await createReleasePlan(snapshot, config, version), null, 2) + "\n";
  if (command === "render") return (await renderChangelog(snapshot, config, version)) ?? "";
  const repository = required(options, "repository");
  const prepared = await prepareReleaseFiles(repository, snapshot, config, version);
  if (options.has("write")) await writeReleaseFiles(repository, prepared);
  return (
    JSON.stringify({ mode: options.has("write") ? "write" : "dry-run", ...prepared }, null, 2) +
    "\n"
  );
}

{
  try {
    process.stdout.write(await runCLI(process.argv.slice(2)));
  } catch (error) {
    const supported =
      error instanceof Error &&
      [
        "UsageError",
        "ReleasePlanError",
        "ReleaseSnapshotError",
        "ChangelogError",
        "ProposalFilesError",
        "VersionFilesError",
        "PullRequestAssociationError",
        "GitInspectionError",
      ].includes(error.name);
    process.stderr.write(
      `release-log: ${supported ? error.message : "operation failed; check input files, permissions, and repository access."}\n`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
