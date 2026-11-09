#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPendingRelease } from "./git.ts";
import { collectMergedPullRequests } from "./github-association.ts";
import { GitHubReadError } from "./github.ts";
import { renderChangelog } from "./changelog.ts";
import { createReleasePlan } from "./release-plan.ts";
import { reconcileReleaseProposal, parseReleaseAutomation } from "./release-proposal.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import {
  parseReleaseApproval,
  parseReleaseApprovalJSON,
  parseReleaseApprovalPolicy,
  captureReleaseReview,
  finalizeReleaseApproval,
  parseReleaseReviewTarget,
  parseReleaseReview,
  parseReleaseMergeAttestation,
  verifyReleaseApproval,
  auditReleaseExclusion,
} from "./release-approval.ts";
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
const help = `release-log (Node.js >=26.13.0 <27; Git required for collection/approval verification)

  release-log collect --config FILE --repository DIR --source SHA
      (--baseline-tag TAG | --bootstrap-sha SHA)
  release-log plan|render --config FILE --snapshot FILE
      (--current-version VERSION | --initial-version 0.1.0)
  release-log prepare --config FILE --snapshot FILE --repository DIR
      (--current-version VERSION | --initial-version 0.1.0) [--dry-run | --write]
  release-log propose --config FILE --snapshot FILE --automation FILE
      (--current-version VERSION | --initial-version 0.1.0) [--dry-run | --write]
  release-log capture-review --config FILE --target FILE --policy FILE --repository DIR
  release-log finalize-approval --config FILE --review FILE --attestation FILE
      --policy FILE --repository DIR
  release-log verify-approval --config FILE --approval FILE --policy FILE --repository DIR
  release-log audit-exclusion --config FILE --approval FILE --policy FILE --repository DIR
      --source SHA (--baseline-tag TAG | --bootstrap-sha SHA)
  release-log --help | --version

collect makes bounded read-only GitHub.com requests using GITHUB_TOKEN and emits
snapshot JSON. Initial adoption requires a version 2 config with a fixed
bootstrap baselineSha/onboardingSha record; old metadata becomes review warnings.
plan emits decision JSON; render emits Markdown (empty for no
release). prepare defaults to dry-run and emits plan/files JSON; only --write
changes fixed local proposal files. It supports package.json and pyproject.toml.
Configure changelog.verbosity as detailed (default), concise, or one-liner;
all modes preserve breaking warnings and required actions.
propose makes explicit GitHub reads; only propose --write creates/refreshes the
reserved release branch and draft PR. It requires GITHUB_TOKEN and an expected
numeric bot identity. capture-review records the exact intended open proposal;
finalize-approval binds that stored review to an explicit trusted merge action.
Both are read-only, require GITHUB_TOKEN and do not authenticate the caller or
provision trusted storage. verify-approval performs read-only GitHub/Git checks
using GITHUB_TOKEN and independently trusted approval/policy files; it emits evidence,
not publication permission. audit-exclusion verifies the complete generated Git
footprint and reports excluded/retained commit IDs without changing collection
or snapshots. No command merges, publishes, or runs consumer build scripts.
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
  const versionOptions = ["config", "snapshot", "current-version", "initial-version"];
  const commandOptions = new Map<string, readonly string[]>([
    ["collect", ["config", "repository", "source", "baseline-tag", "bootstrap-sha"]],
    ["plan", versionOptions],
    ["render", versionOptions],
    ["prepare", [...versionOptions, "repository", "dry-run", "write"]],
    ["propose", [...versionOptions, "automation", "dry-run", "write"]],
    ["capture-review", ["config", "target", "policy", "repository"]],
    ["finalize-approval", ["config", "review", "attestation", "policy", "repository"]],
    ["verify-approval", ["config", "approval", "policy", "repository"]],
    [
      "audit-exclusion",
      ["config", "approval", "policy", "repository", "source", "baseline-tag", "bootstrap-sha"],
    ],
  ]);
  const allowed = commandOptions.get(command ?? "");
  if (!allowed) throw new UsageError("Unknown command. Use --help for supported commands.");
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
    if (baseline.kind === "bootstrap" && config.schemaVersion !== 2)
      throw new UsageError(
        "Initial adoption requires a version 2 configuration with a fixed bootstrap baselineSha/onboardingSha record.",
      );

    if (
      baseline.kind === "bootstrap" &&
      config.schemaVersion === 2 &&
      config.bootstrap.baselineSha !== baseline.commitSha
    )
      throw new UsageError(
        "The bootstrap baseline must match the fixed onboarding record in configuration.",
      );

    const range = await inspectPendingRelease(repository, baseline, required(options, "source"));
    return serializeReleaseSnapshot(
      await captureReleaseSnapshot(
        await collectMergedPullRequests({
          repository: config.repository,
          releaseBranch: config.releaseBranch,
          localRepository: repository,
          range,
          token,
          ...(baseline.kind === "bootstrap" && config.schemaVersion === 2
            ? { onboardingSha: config.bootstrap.onboardingSha }
            : {}),
        }),
        config,
      ),
    );
  }

  if (command === "capture-review" || command === "finalize-approval") {
    const policy = parseReleaseApprovalPolicy(
      parseReleaseApprovalJSON(await readText(required(options, "policy"), 1024 * 1024)),
    );
    const repository = required(options, "repository");
    const token = process.env.GITHUB_TOKEN;

    if (!token?.trim())
      throw new UsageError(`${command} requires GITHUB_TOKEN with repository/PR read access.`);

    if (command === "capture-review") {
      const target = parseReleaseReviewTarget(
        parseReleaseApprovalJSON(await readText(required(options, "target"), 1024 * 1024)),
      );

      return (
        JSON.stringify(
          await captureReleaseReview({ repository, configuration: config, policy, target, token }),
          null,
          2,
        ) + "\n"
      );
    }

    const review = parseReleaseReview(
      parseReleaseApprovalJSON(await readText(required(options, "review"), 1024 * 1024)),
    );
    const attestation = parseReleaseMergeAttestation(
      parseReleaseApprovalJSON(await readText(required(options, "attestation"), 1024 * 1024)),
    );

    return (
      JSON.stringify(
        await finalizeReleaseApproval({
          repository,
          configuration: config,
          policy,
          review,
          attestation,
          token,
        }),
        null,
        2,
      ) + "\n"
    );
  }

  if (command === "verify-approval" || command === "audit-exclusion") {
    const approval = parseReleaseApproval(
      parseReleaseApprovalJSON(await readText(required(options, "approval"), 1024 * 1024)),
    );
    const policy = parseReleaseApprovalPolicy(
      parseReleaseApprovalJSON(await readText(required(options, "policy"), 1024 * 1024)),
    );
    const repository = required(options, "repository");
    const token = process.env.GITHUB_TOKEN;
    if (!token?.trim())
      throw new UsageError(`${command} requires GITHUB_TOKEN with repository/PR read access.`);

    if (command === "audit-exclusion") {
      if (options.has("baseline-tag") === options.has("bootstrap-sha"))
        throw new UsageError("Select exactly one --baseline-tag or --bootstrap-sha.");

      const baseline = options.has("baseline-tag")
        ? { kind: "tag" as const, name: required(options, "baseline-tag") }
        : { kind: "bootstrap" as const, commitSha: required(options, "bootstrap-sha") };
      const range = await inspectPendingRelease(repository, baseline, required(options, "source"));

      return (
        JSON.stringify(
          await auditReleaseExclusion({
            repository,
            configuration: config,
            policy,
            approval,
            range,
            token,
          }),
          null,
          2,
        ) + "\n"
      );
    }

    return (
      JSON.stringify(
        await verifyReleaseApproval({ repository, configuration: config, policy, approval, token }),
        null,
        2,
      ) + "\n"
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
  if (command === "propose") {
    const automationJSON: unknown = JSON.parse(
      await readText(required(options, "automation"), 1024 * 1024),
    );
    const automation = parseReleaseAutomation(automationJSON);
    const token = process.env.GITHUB_TOKEN;
    if (!token?.trim())
      throw new UsageError(
        "propose requires a repository-limited GITHUB_TOKEN; writes require explicit approval and contents/PR write access.",
      );
    const result = await reconcileReleaseProposal({
      snapshot,
      configuration: config,
      version,
      automation,
      token,
      write: options.has("write"),
    });
    return (
      JSON.stringify({ mode: options.has("write") ? "write" : "dry-run", ...result }, null, 2) +
      "\n"
    );
  }
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
      error instanceof GitHubReadError ||
      (error instanceof Error &&
        [
          "UsageError",
          "ReleasePlanError",
          "ReleaseSnapshotError",
          "ChangelogError",
          "ProposalFilesError",
          "VersionFilesError",
          "PullRequestAssociationError",
          "GitInspectionError",
          "ProposalConflictError",
          "ReleaseApprovalError",
        ].includes(error.name));
    process.stderr.write(
      `release-log: ${supported ? error.message : "operation failed; check input files, permissions, and repository access."}\n`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
