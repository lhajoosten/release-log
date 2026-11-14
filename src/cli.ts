#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPendingRelease } from "./git.ts";
import { collectMergedPullRequests } from "./github-association.ts";
import { GitHubReadError } from "./github.ts";
import { renderChangelog } from "./changelog.ts";
import { createReleasePlan } from "./release-plan.ts";
import { reconcileReleaseProposal, parseReleaseAutomation } from "./release-proposal.ts";
import { reconcileReleaseTag } from "./release-tag.ts";
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
  parseReleaseExclusionAuthorities,
} from "./release-approval.ts";
import { prepareReleaseFiles, writeReleaseFiles } from "./proposal-files.ts";
import {
  inspectReleasePublication,
  publishGitHubRelease,
  parsePublicationPolicy,
  parsePublicationReceipt,
} from "./release-publication.ts";
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
      (--baseline-tag TAG | --bootstrap-sha SHA) [--exclusions FILE]
  release-log plan|render --config FILE --snapshot FILE
      (--current-version VERSION | --initial-version 0.1.0)
  release-log prepare --config FILE --snapshot FILE --repository DIR
      (--current-version VERSION | --initial-version 0.1.0) [--dry-run | --write]
  release-log propose --config FILE --snapshot FILE --automation FILE
      (--current-version VERSION | --initial-version 0.1.0) [--dry-run | --write]
  release-log tag-release --config FILE --automation FILE --pull-number NUMBER
      --landing-sha SHA [--dry-run | --write]
  release-log capture-review --config FILE --target FILE --policy FILE --repository DIR
  release-log finalize-approval --config FILE --review FILE --attestation FILE
      --policy FILE --repository DIR
  release-log verify-approval --config FILE --approval FILE --policy FILE --repository DIR
  release-log audit-exclusion --config FILE --approval FILE --policy FILE --repository DIR
      --source SHA (--baseline-tag TAG | --bootstrap-sha SHA)
  release-log inspect-publication --config FILE --approval FILE --policy FILE
      --publication-policy FILE --receipt FILE --repository DIR
  release-log publish-github --config FILE --approval FILE --policy FILE
      --publication-policy FILE --receipt FILE --repository DIR
      --asset-directory DIR [--dry-run | --write]
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
numeric bot identity. tag-release verifies a manually merged generated proposal;
only --write creates its immutable version tag at the exact supplied landing.
It requires no approval receipt, application CI evidence, or publication policy.
capture-review records the exact intended open proposal;
finalize-approval binds that stored review to an explicit trusted merge action.
Both are read-only, require GITHUB_TOKEN and do not authenticate the caller or
provision trusted storage. verify-approval performs read-only GitHub/Git checks
using GITHUB_TOKEN and independently trusted approval/policy files; it emits evidence,
not publication permission. Approval policy 2 additionally requires the intended
human's actual head-specific review and successful pinned workflow/job/App checks.
audit-exclusion verifies the complete generated Git
footprint and reports excluded/retained commit IDs. collect --exclusions requires
independently trusted approval authorities and matching configuration pins;
it freshly verifies exclusions while retaining the complete raw graph in schema-4 snapshots.
inspect-publication reads tag/Release/artifact state and emits a reconciliation
plan without writes. Images require a separate GHCR_READ_TOKEN registry bearer.
publish-github defaults to dry-run; only explicit --write creates the approved
GitHub tag, draft Release, assets and published Release. It requires independently
trusted host inputs and exact local asset bytes. It never pushes images; configured
image roots must already match. No workflow enables it automatically.
No command merges or runs consumer build scripts.
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
    ["collect", ["config", "repository", "source", "baseline-tag", "bootstrap-sha", "exclusions"]],
    ["plan", versionOptions],
    ["render", versionOptions],
    ["prepare", [...versionOptions, "repository", "dry-run", "write"]],
    ["propose", [...versionOptions, "automation", "dry-run", "write"]],
    ["tag-release", ["config", "automation", "pull-number", "landing-sha", "dry-run", "write"]],
    ["capture-review", ["config", "target", "policy", "repository"]],
    ["finalize-approval", ["config", "review", "attestation", "policy", "repository"]],
    ["verify-approval", ["config", "approval", "policy", "repository"]],
    [
      "inspect-publication",
      ["config", "approval", "policy", "publication-policy", "receipt", "repository"],
    ],
    [
      "publish-github",
      [
        "config",
        "approval",
        "policy",
        "publication-policy",
        "receipt",
        "repository",
        "asset-directory",
        "dry-run",
        "write",
      ],
    ],
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
  if (command === "tag-release") {
    const numberText = required(options, "pull-number");
    const pullNumber = Number(numberText);
    if (!/^[1-9][0-9]*$/u.test(numberText) || !Number.isSafeInteger(pullNumber))
      throw new UsageError("--pull-number must be a positive safe integer.");
    const landingSha = required(options, "landing-sha");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(landingSha))
      throw new UsageError("--landing-sha must be a complete lowercase commit ID.");
    const automationJSON: unknown = JSON.parse(
      await readText(required(options, "automation"), 1024 * 1024),
    );
    const automation = parseReleaseAutomation(automationJSON);
    const token = process.env.GITHUB_TOKEN;
    if (!token?.trim())
      throw new UsageError("tag-release requires a repository-limited GITHUB_TOKEN.");
    const result = await reconcileReleaseTag({
      configuration: config,
      automation,
      pullNumber,
      landingSha,
      token,
      write: options.has("write"),
    });
    return (
      JSON.stringify({ mode: options.has("write") ? "write" : "dry-run", ...result }, null, 2) +
      "\n"
    );
  }
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

    if (options.has("exclusions") !== (config.automationExclusions !== undefined))
      throw new UsageError(
        "Exclusion collection requires both trusted configuration pins and --exclusions approval authorities.",
      );

    const automation = options.has("exclusions")
      ? parseReleaseExclusionAuthorities(
          parseReleaseApprovalJSON(await readText(required(options, "exclusions"), 1024 * 1024)),
        )
      : undefined;
    const range = await inspectPendingRelease(repository, baseline, required(options, "source"));
    return serializeReleaseSnapshot(
      await captureReleaseSnapshot(
        await collectMergedPullRequests({
          repository: config.repository,
          releaseBranch: config.releaseBranch,
          localRepository: repository,
          range,
          token,
          ...(automation === undefined ? {} : { automation }),
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

  if (
    command === "verify-approval" ||
    command === "audit-exclusion" ||
    command === "inspect-publication" ||
    command === "publish-github"
  ) {
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

    if (command === "inspect-publication" || command === "publish-github") {
      const publicationPolicy = parsePublicationPolicy(
        parseReleaseApprovalJSON(
          await readText(required(options, "publication-policy"), 1024 * 1024),
        ),
      );
      const receipt = parsePublicationReceipt(
        parseReleaseApprovalJSON(await readText(required(options, "receipt"), 1024 * 1024)),
      );
      const registryToken = process.env.GHCR_READ_TOKEN;

      const request = {
        repository,
        configuration: config,
        approvalPolicy: policy,
        approval,
        publicationPolicy,
        receipt,
        token,
        ...(registryToken === undefined ? {} : { registryToken }),
      };
      const result =
        command === "inspect-publication"
          ? await inspectReleasePublication(request)
          : await publishGitHubRelease({
              ...request,
              assetDirectory: required(options, "asset-directory"),
              write: options.has("write"),
            });

      return JSON.stringify(result, null, 2) + "\n";
    }

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
          "ReleasePublicationError",
        ].includes(error.name));
    process.stderr.write(
      `release-log: ${supported ? error.message : "operation failed; check input files, permissions, and repository access."}\n`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
