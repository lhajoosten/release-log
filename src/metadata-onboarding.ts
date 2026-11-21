import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

import {
  parseReleaseInputConfiguration,
  type ReleaseInputConfiguration,
} from "./config/repository.ts";
import { isObject } from "./evidence/schema.ts";
import { GitHubReadError, readGitHubJson, type GitHubRead } from "./github.ts";
import { workflowPath as rollingCaller } from "./proposal-paths.ts";

const metadataCaller = ".github/workflows/release-metadata-caller.yml";
const check = "release-log / metadata";
const actionsAppId = 15368;
const fullSha = /^[a-f0-9]{40}$/u;
const events = ["opened", "synchronize", "reopened", "edited", "ready_for_review"];

type Status = "verified" | "incomplete" | "insufficient-evidence";
type Read = ReturnType<typeof repositoryReader>;

class OnboardingDiagnostic extends Error {
  readonly status: Exclude<Status, "verified">;

  constructor(status: Exclude<Status, "verified">, message: string) {
    super(message);
    this.status = status;
  }
}

function incomplete(message: string): never {
  throw new OnboardingDiagnostic("incomplete", message);
}

function insufficient(message: string): never {
  throw new OnboardingDiagnostic("insufficient-evidence", message);
}

function repositoryReader(repository: string, token: string, read: GitHubRead) {
  const base = `https://api.github.com/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
  return (path: string) => readGitHubJson(base + path, token, read);
}

async function loadWorkflow(get: Read, path: string, sha: string) {
  let data: unknown;
  try {
    ({ data } = await get(`/contents/${path}?ref=${sha}`));
  } catch (error) {
    if (!(error instanceof GitHubReadError) || error.status !== 404) throw error;

    const { data: entries } = await get(`/contents/.github/workflows?ref=${sha}`);
    if (
      !Array.isArray(entries) ||
      entries.length >= 1000 ||
      !entries.every((entry: unknown) => isObject(entry) && typeof entry.path === "string") ||
      entries.some((entry: unknown) => isObject(entry) && entry.path === path)
    )
      insufficient(`Check Contents read access for ${path} on the release branch.`);
    incomplete(`Install ${path} on the release branch.`);
  }
  if (
    !isObject(data) ||
    data.type !== "file" ||
    data.path !== path ||
    data.encoding !== "base64" ||
    typeof data.content !== "string"
  )
    insufficient(`GitHub did not return readable workflow contents for ${path}.`);

  try {
    const workflow: unknown = parse(Buffer.from(data.content, "base64").toString("utf8"), {
      maxAliasCount: 0,
    });
    if (isObject(workflow)) return workflow;
  } catch {
    // A malformed or unsupported workflow cannot establish a working caller.
  }
  return incomplete(`Replace ${path} with the supported caller template.`);
}

function withPinnedSource(job: unknown, workflow: string) {
  if (!isObject(job) || !isObject(job.with) || typeof job.uses !== "string") return undefined;
  const prefix = `lhajoosten/release-log/.github/workflows/${workflow}@`;
  if (!job.uses.startsWith(prefix)) return undefined;
  const pin = job.uses.slice(prefix.length);
  return fullSha.test(pin) && job.with["tool-sha"] === pin ? job.with : undefined;
}

function samePolicy(value: unknown, config: ReleaseInputConfiguration) {
  try {
    if (typeof value !== "string") return false;
    const actual = parseReleaseInputConfiguration(JSON.parse(value));
    return (
      actual.repository === config.repository &&
      actual.repositoryId === config.repositoryId &&
      actual.releaseBranch === config.releaseBranch &&
      actual.releasePolicy === config.releasePolicy &&
      (actual.contextPolicy ?? "required") === (config.contextPolicy ?? "required")
    );
  } catch {
    return false;
  }
}

async function verifyCallers(get: Read, config: ReleaseInputConfiguration, sha: string) {
  // The API reads both callers at the same release-branch commit.
  const rolling = await loadWorkflow(get, rollingCaller, sha);
  const release = withPinnedSource(
    isObject(rolling.jobs) && rolling.jobs.release,
    "rolling-release.yml",
  );
  // GitHub treats these characters as glob syntax even in quoted YAML.
  const filter = config.releaseBranch.replace(/[+*?[\]!\\]/gu, "\\$&");
  const mergedPull = { pull_request_target: { types: ["closed"], branches: [filter] } };
  if (
    (!isDeepStrictEqual(rolling.on, mergedPull) &&
      !isDeepStrictEqual(rolling.on, { ...mergedPull, workflow_dispatch: null })) ||
    release?.["release-branch"] !== config.releaseBranch ||
    !samePolicy(release.configuration, config)
  )
    incomplete(
      `Align the pinned rolling-release caller in ${rollingCaller} with the supplied repository, release branch and context policy.`,
    );

  const metadata = await loadWorkflow(get, metadataCaller, sha);
  const job = isObject(metadata.jobs) && metadata.jobs["release-log"];
  const input = withPinnedSource(job, "release-metadata.yml");

  if (
    !isObject(job) ||
    !input ||
    Object.keys(input).length !== 2 ||
    Object.keys(job).some((key) => !["uses", "with"].includes(key)) ||
    !isObject(metadata.jobs) ||
    Object.keys(metadata.jobs).length !== 1 ||
    Object.keys(metadata).some(
      (key) => !["name", "on", "permissions", "concurrency", "jobs"].includes(key),
    ) ||
    !isDeepStrictEqual(metadata.on, {
      pull_request_target: { types: events, branches: [filter] },
    }) ||
    !isDeepStrictEqual(metadata.permissions, { contents: "read", "pull-requests": "read" }) ||
    !isDeepStrictEqual(metadata.concurrency, {
      group: "release-log-pr-metadata-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    })
  )
    incomplete(
      `Use the supported pinned, read-only template in ${metadataCaller} with the exact release-branch filter and all five PR events.`,
    );

  if (!samePolicy(input.configuration, config))
    incomplete(
      `Copy the rolling-release configuration JSON into ${metadataCaller} to align repository, release branch and context policy.`,
    );

  const { data } = await get(`/actions/workflows/${metadataCaller.split("/").at(-1)}`);
  if (!isObject(data) || data.path !== metadataCaller || typeof data.state !== "string")
    insufficient("GitHub did not return the metadata caller's Actions state.");
  if (data.state !== "active") incomplete(`Enable the Actions workflow at ${metadataCaller}.`);
}

type Protection = "enforced" | "bypassed" | "absent" | "unreadable";

async function classicProtection(
  get: Read,
  branch: string,
  protectedBranch: boolean,
): Promise<Protection> {
  try {
    const { data } = await get(`/branches/${branch}/protection`);
    if (!isObject(data)) return "unreadable";
    const required = data.required_status_checks;
    if (required === undefined || required === null) return "absent";
    if (!isObject(required)) return "unreadable";
    if (!Array.isArray(required.checks))
      return Array.isArray(required.contexts) ? "absent" : "unreadable";

    if (
      !required.checks.some(
        (entry: unknown) =>
          isObject(entry) && entry.context === check && entry.app_id === actionsAppId,
      )
    )
      return "absent";

    const admins = data.enforce_admins;
    if (!isObject(admins) || typeof admins.enabled !== "boolean") return "unreadable";
    return admins.enabled ? "enforced" : "bypassed";
  } catch (error) {
    if (error instanceof GitHubReadError && error.status === 404 && !protectedBranch)
      return "absent";
    return "unreadable";
  }
}

async function branchRules(get: Read, branch: string) {
  const rules: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, next } = await get(`/rules/branches/${branch}?per_page=100&page=${page}`);
    if (!Array.isArray(data) || !data.every(isObject) || (next && data.length !== 100))
      return insufficient("GitHub returned incomplete effective branch rules.");
    rules.push(...data);
    if (!next) return rules;
  }
  return insufficient("Effective branch rules exceeded ten pages.");
}

function hasRulesetCheck(parameters: unknown): boolean {
  return (
    isObject(parameters) &&
    Array.isArray(parameters.required_status_checks) &&
    parameters.required_status_checks.some(
      (entry: unknown) =>
        isObject(entry) && entry.context === check && entry.integration_id === actionsAppId,
    )
  );
}

async function rulesetProtection(
  get: Read,
  rules: readonly Record<string, unknown>[],
): Promise<Protection> {
  const ids = new Set<number>();
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    const parameters = rule.parameters;
    if (!isObject(parameters) || !Array.isArray(parameters.required_status_checks))
      return "unreadable";
    if (!hasRulesetCheck(parameters)) continue;

    const id = rule.ruleset_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return "unreadable";
    ids.add(id);
  }

  let result: Protection = "absent";
  for (const id of ids) {
    try {
      const { data } = await get(`/rulesets/${id}?includes_parents=true`);
      if (
        !isObject(data) ||
        data.id !== id ||
        data.enforcement !== "active" ||
        !Array.isArray(data.bypass_actors) ||
        !Array.isArray(data.rules) ||
        !data.rules.some(
          (rule: unknown) =>
            isObject(rule) &&
            rule.type === "required_status_checks" &&
            hasRulesetCheck(rule.parameters),
        )
      )
        result = "unreadable";
      else if (data.bypass_actors.length === 0) return "enforced";
      else if (result === "absent") result = "bypassed";
    } catch (error) {
      if (!(error instanceof GitHubReadError)) throw error;
      result = "unreadable";
    }
  }
  return result;
}

export async function verifyMetadataOnboarding(
  config: ReleaseInputConfiguration,
  token: string,
  read: GitHubRead = fetch,
): Promise<{
  readonly status: Status;
  readonly branch: string;
  readonly check: string;
  readonly message: string;
}> {
  const branch = config.releaseBranch;
  const encoded = encodeURIComponent(branch);
  const get = repositoryReader(config.repository, token, read);
  const setup = `Require "${check}" from GitHub Actions on "${branch}"`;

  try {
    if (!token.trim())
      insufficient("Supply GITHUB_TOKEN for the read-only onboarding verification.");
    const { data: repository } = await get("");
    if (
      !isObject(repository) ||
      repository.id !== config.repositoryId ||
      repository.full_name !== config.repository
    )
      incomplete(
        "Use the GitHub repository name and numeric ID from the rolling-release configuration.",
      );

    const { data: target } = await get(`/branches/${encoded}`);
    if (
      !isObject(target) ||
      target.name !== branch ||
      !isObject(target.commit) ||
      typeof target.commit.sha !== "string" ||
      !fullSha.test(target.commit.sha) ||
      typeof target.protected !== "boolean"
    )
      insufficient("GitHub did not return complete release-branch evidence.");

    await verifyCallers(get, config, target.commit.sha);

    const rules = await branchRules(get, encoded);
    if (rules.some((rule) => rule.type === "merge_queue"))
      incomplete("The branch uses a merge queue, which requires a separate merge-group check.");

    const classic = await classicProtection(get, encoded, target.protected);
    const ruleset = await rulesetProtection(get, rules);
    if (classic === "enforced" || ruleset === "enforced")
      return {
        status: "verified",
        branch,
        check,
        message: `GitHub requires "${check}" on "${branch}" without a bypass in the enforcing rule.`,
      };

    if (classic === "unreadable" || ruleset === "unreadable")
      insufficient(
        "Read the effective branch protection and ruleset bypass lists with an authorized repository administrator.",
      );
    if (classic === "bypassed" || ruleset === "bypassed")
      incomplete(
        "Enable enforcement for administrators or use a matching active ruleset without bypass actors.",
      );
    return incomplete(
      "The check is missing or has a different source in effective branch protection and rulesets.",
    );
  } catch (error) {
    if (!(error instanceof OnboardingDiagnostic || error instanceof GitHubReadError)) throw error;
    return {
      status: error instanceof OnboardingDiagnostic ? error.status : "insufficient-evidence",
      branch,
      check,
      message: `${setup}. ${error.message}`,
    };
  }
}
