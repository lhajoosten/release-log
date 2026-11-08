import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  conventionalPolicyId,
  readHistoricalBreakingChanges,
  validateConventionalMessage,
} from "./conventional.ts";
import type { ConventionalMetadata } from "./conventional.ts";
import type { AssociatedPullRequest, PullRequestAssociation } from "./github-association.ts";
import type {
  GitCommitEvidence,
  PendingReleaseInspection,
  ResolvedReleaseBaseline,
} from "./git.ts";
import { validatePullRequestMetadata } from "./pr-readiness.ts";
import type { ReadinessIssue } from "./pr-readiness.ts";
import { parseReleaseContext } from "./release-context.ts";
import type { ReleaseContextV1 } from "./release-context.ts";

const maximumBytes = 16 * 1024 * 1024;

export class ReleaseSnapshotError extends Error {
  readonly code:
    | "schema-invalid"
    | "resource-limit"
    | "metadata-invalid"
    | "integrity-mismatch"
    | "configuration-mismatch"
    | "normalizer-mismatch";
  readonly issues: readonly ReadinessIssue[];
  constructor(
    code: ReleaseSnapshotError["code"],
    message: string,
    issues: readonly ReadinessIssue[] = [],
  ) {
    super(message);
    this.name = "ReleaseSnapshotError";
    this.code = code;
    this.issues = issues;
  }
}

interface ReleaseRepositoryConfiguration {
  readonly repository: string;
  readonly repositoryId: number;
  readonly releaseBranch: string;
  readonly releasePolicy: "release-policy-v1";
}

export type ReleaseInputConfiguration = ReleaseRepositoryConfiguration &
  (
    | { readonly schemaVersion: 1 }
    | {
        readonly schemaVersion: 2;
        readonly bootstrap: {
          readonly baselineSha: string;
          readonly onboardingSha: string;
        };
      }
  );

export interface NormalizedBootstrapCommit {
  readonly sha: string;
  readonly url: string;
  readonly metadata: ConventionalMetadata;
}

export interface HistoricalReleaseEntry {
  readonly source:
    | { readonly kind: "pull-request"; readonly number: number; readonly url: string }
    | { readonly kind: "commit"; readonly sha: string; readonly url: string };
  readonly title: string;
  readonly context: ReleaseContextV1 | null;
  readonly breakingChanges: readonly string[];
  readonly warnings: readonly ReadinessIssue[];
}

export interface NormalizedReleaseInputs {
  readonly repository: string;
  readonly releaseBranch: string;
  readonly baselineCommitSha: string;
  readonly sourceCommitSha: string;
  readonly bootstrapCommits: readonly NormalizedBootstrapCommit[];
  readonly historicalEntries: readonly HistoricalReleaseEntry[];
  readonly pullRequests: readonly {
    readonly number: number;
    readonly url: string;
    readonly title: ConventionalMetadata;
    readonly context: ReleaseContextV1;
    readonly rawBlock: string;
    readonly breakingChanges: readonly string[];
    readonly commits: readonly {
      readonly source: "original" | "landed";
      readonly sha: string;
      readonly metadata: ConventionalMetadata;
    }[];
    readonly validation: { readonly valid: true; readonly warnings: readonly ReadinessIssue[] };
  }[];
}

export interface ReleaseSnapshot {
  readonly schemaVersion: 3;
  readonly tool: { readonly version: string; readonly normalizerId: string };
  readonly configuration: ReleaseInputConfiguration;
  readonly configurationId: string;
  readonly input: PullRequestAssociation & {
    readonly bootstrapCommits: readonly GitCommitEvidence[];
  };
  readonly normalized: NormalizedReleaseInputs;
  readonly snapshotId: string;
}

function invalid(message: string): never {
  throw new ReleaseSnapshotError("schema-invalid", message);
}

function limit(message: string): never {
  throw new ReleaseSnapshotError("resource-limit", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) return invalid(`Expected ${label} to be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    return invalid(`Unexpected or missing fields in ${label}.`);
  return value;
}

function text(value: unknown, label: string, bytes = 1024 * 1024): string {
  if (typeof value !== "string") return invalid(`Expected ${label} to be text.`);
  if (Buffer.byteLength(value, "utf8") > bytes) return limit(`${label} exceeds its text limit.`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid(`Expected a positive integer for ${label}.`);
  return value;
}

function sha(value: unknown): string {
  const result = text(value, "object ID", 64);
  if (result.trim() !== result || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result))
    return invalid("Expected a complete lowercase SHA-1 or SHA-256 object ID.");
  return result;
}

function array(value: unknown, size: number, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(`Expected ${label} to be an array.`);
  if (value.length > size) return limit(`${label} exceeds its entry limit.`);
  return value;
}

function unique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate entries in ${label}.`);
}

function canonical(value: unknown): string {
  const chunks: string[] = [];
  const visiting = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  function emit(part: string): void {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > maximumBytes) limit("Snapshot exceeds 16 MiB in UTF-8.");
    chunks.push(part);
  }
  function walk(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 32)
      limit("Snapshot exceeds the 100000-node or 32-level nesting limit.");
    if (item === null) {
      emit("null");
      return;
    }
    if (typeof item === "string") {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item === "boolean") {
      emit(String(item));
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object")
      return invalid(
        "Snapshots contain only JSON data; unsupported values are not silently discarded.",
      );
    if (visiting.has(item)) return invalid("Snapshot data must not contain cycles.");
    visiting.add(item);
    if (Array.isArray(item)) {
      emit("[");
      for (const [index, child] of item.entries()) {
        if (index) emit(",");
        walk(child, depth + 1);
      }
      emit("]");
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return invalid("Snapshot objects must be plain JSON objects.");
      const entries = Object.entries(item).toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      emit("{");
      for (const [index, [key, child]] of entries.entries()) {
        if (index) emit(",");
        emit(JSON.stringify(key));
        emit(":");
        walk(child, depth + 1);
      }
      emit("}");
    }
    visiting.delete(item);
  }
  walk(value, 0);
  return chunks.join("");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function runtimeIdentity(): { version: string; normalizerId: string } {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
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
      normalizationVersion: 3,
      conventionalPolicyId,
      dependencies: manifest.dependencies,
      lockfileId: createHash("sha256")
        .update(
          readFileSync(
            new URL(
              import.meta.url.endsWith(".ts") ? "../pnpm-lock.yaml" : "../dependency-lock.txt",
              import.meta.url,
            ),
          ),
        )
        .digest("hex"),
    }),
  };
}

const tool = runtimeIdentity();

export function parseReleaseInputConfiguration(value: unknown): ReleaseInputConfiguration {
  const item = object(
    value,
    [
      "schemaVersion",
      "repository",
      "repositoryId",
      "releaseBranch",
      "releasePolicy",
      ...(isObject(value) && value.schemaVersion === 2 ? ["bootstrap"] : []),
    ],
    "release configuration",
  );
  const repository = text(item.repository, "repository", 256);
  const releaseBranch = text(item.releaseBranch, "release branch", 1024);

  if (
    (item.schemaVersion !== 1 && item.schemaVersion !== 2) ||
    item.releasePolicy !== "release-policy-v1"
  )
    return invalid("Unsupported release configuration schema or policy revision.");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/u.test(repository) ||
    repository.trim() !== repository ||
    [".", ".."].includes(repository.split("/")[1] ?? "") ||
    !releaseBranch.trim() ||
    /[\0\r\n]/u.test(releaseBranch)
  )
    return invalid("Invalid repository identity or release branch in configuration.");
  const common: ReleaseRepositoryConfiguration = {
    repository,
    repositoryId: positive(item.repositoryId, "repository ID"),
    releaseBranch,
    releasePolicy: "release-policy-v1",
  };

  if (item.schemaVersion === 2) {
    const bootstrap = object(
      item.bootstrap,
      ["baselineSha", "onboardingSha"],
      "trusted onboarding record",
    );

    return {
      ...common,
      schemaVersion: 2,
      bootstrap: {
        baselineSha: sha(bootstrap.baselineSha),
        onboardingSha: sha(bootstrap.onboardingSha),
      },
    };
  }

  return { ...common, schemaVersion: 1 };
}

function commitEvidence(value: unknown): GitCommitEvidence {
  const item = object(value, ["sha", "message", "parentShas"], "commit evidence");
  const parentShas = array(item.parentShas, 32, "commit parents").map(sha);
  unique(parentShas, "commit parents");
  return { sha: sha(item.sha), message: text(item.message, "commit message"), parentShas };
}

function rangeEvidence(value: unknown): PendingReleaseInspection {
  const item = object(
    value,
    ["baseline", "sourceCommitSha", "baselineIsAncestor", "commitShas"],
    "captured range",
  );
  if (item.baselineIsAncestor !== true)
    return invalid("Snapshot ranges require baseline ancestry.");
  if (typeof item.baseline !== "object" || item.baseline === null || !("kind" in item.baseline))
    return invalid("A snapshot needs an explicit baseline kind.");
  let baseline: ResolvedReleaseBaseline;
  if (item.baseline.kind === "bootstrap") {
    const base = object(item.baseline, ["kind", "commitSha"], "bootstrap baseline");
    baseline = { kind: "bootstrap", commitSha: sha(base.commitSha) };
  } else if (item.baseline.kind === "tag") {
    const base = object(item.baseline, ["kind", "name", "objectSha", "commitSha"], "tag baseline");
    const name = text(base.name, "release tag", 128);
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(name) || name.trim() !== name)
      return invalid("Release baselines require a stable vMAJOR.MINOR.PATCH tag.");
    baseline = {
      kind: "tag",
      name,
      objectSha: sha(base.objectSha),
      commitSha: sha(base.commitSha),
    };
  } else return invalid("Unknown snapshot baseline kind.");
  const commitShas = array(item.commitShas, 1000, "range commits").map(sha).toSorted();
  unique(commitShas, "range commits");
  const sourceCommitSha = sha(item.sourceCommitSha);
  if (
    commitShas.includes(baseline.commitSha) ||
    (commitShas.length === 0
      ? sourceCommitSha !== baseline.commitSha
      : !commitShas.includes(sourceCommitSha))
  )
    return invalid("Snapshot range endpoints disagree with the exclusive commit set.");
  return { baseline, sourceCommitSha, baselineIsAncestor: true, commitShas };
}

function pullEvidence(value: unknown): AssociatedPullRequest {
  const item = object(
    value,
    [
      "number",
      "id",
      "title",
      "body",
      "updatedAt",
      "mergedAt",
      "mergeCommitSha",
      "commitCount",
      "headSha",
      "headRef",
      "headRepositoryId",
      "baseRepositoryId",
      "authorId",
      "authorType",
      "url",
      "landingKind",
      "originalCommits",
      "landedCommits",
    ],
    "PR evidence",
  );
  const originalCommits = array(item.originalCommits, 250, "original PR commits").map(
    commitEvidence,
  );
  const landedCommits = array(item.landedCommits, 1000, "landed PR commits")
    .map(commitEvidence)
    .toSorted((left, right) => (left.sha < right.sha ? -1 : left.sha > right.sha ? 1 : 0));
  unique(
    originalCommits.map((entry) => entry.sha),
    "original PR commits",
  );
  unique(
    landedCommits.map((entry) => entry.sha),
    "landed PR commits",
  );
  const commitCount = positive(item.commitCount, "original PR commit count");
  const headSha = sha(item.headSha);
  if (
    commitCount !== originalCommits.length ||
    originalCommits.at(-1)?.sha !== headSha ||
    landedCommits.length === 0
  )
    return invalid("PR commit counts or original head evidence are incomplete.");
  if (item.landingKind !== "merge" && item.landingKind !== "linear")
    return invalid("Unknown PR landing kind.");
  return {
    number: positive(item.number, "PR number"),
    id: positive(item.id, "PR ID"),
    title: text(item.title, "PR title", 1024),
    body: text(item.body, "PR body"),
    updatedAt: text(item.updatedAt, "PR update timestamp", 128),
    mergedAt: text(item.mergedAt, "PR merge timestamp", 128),
    mergeCommitSha: sha(item.mergeCommitSha),
    commitCount,
    headSha,
    headRef: text(item.headRef, "PR head ref", 1024),
    headRepositoryId:
      item.headRepositoryId === null ? null : positive(item.headRepositoryId, "head repository ID"),
    baseRepositoryId: positive(item.baseRepositoryId, "base repository ID"),
    authorId: positive(item.authorId, "author ID"),
    authorType: text(item.authorType, "author type", 64),
    url: text(item.url, "PR URL", 1024),
    landingKind: item.landingKind,
    originalCommits,
    landedCommits,
  };
}

function association(value: unknown, config: ReleaseInputConfiguration): ReleaseSnapshot["input"] {
  const item = object(
    value,
    [
      "repository",
      "releaseBranch",
      "range",
      "pullRequests",
      ...(isObject(value) && Object.hasOwn(value, "bootstrapCommits") ? ["bootstrapCommits"] : []),
    ],
    "association evidence",
  );

  if (item.repository !== config.repository || item.releaseBranch !== config.releaseBranch)
    throw new ReleaseSnapshotError(
      "configuration-mismatch",
      "Collected repository/branch identity does not match the supplied configuration.",
    );

  const range = rangeEvidence(item.range);
  const pullRequests = array(item.pullRequests, 1000, "associated PRs")
    .map(pullEvidence)
    .toSorted((left, right) => left.number - right.number);

  const bootstrapCommits = array(
    Object.hasOwn(item, "bootstrapCommits") ? item.bootstrapCommits : [],
    1000,
    "bootstrap commits",
  )
    .map(commitEvidence)
    .toSorted((left, right) => (left.sha < right.sha ? -1 : left.sha > right.sha ? 1 : 0));

  unique(
    bootstrapCommits.map((entry) => entry.sha),
    "bootstrap commits",
  );

  if (bootstrapCommits.length && range.baseline.kind !== "bootstrap")
    return invalid("Commit-only evidence is permitted only with an explicit bootstrap baseline.");

  unique(
    pullRequests.map((entry) => entry.number),
    "PR numbers",
  );
  unique(
    pullRequests.map((entry) => entry.id),
    "PR IDs",
  );
  const graph = new Map<string, GitCommitEvidence>();
  const parentsByCommit = new Map<string, readonly string[]>();
  let evidenceCount = 0;
  for (const pull of pullRequests) {
    evidenceCount += pull.originalCommits.length + pull.landedCommits.length;
    if (evidenceCount > 5000)
      limit("Snapshot exceeds 5000 original/landed commit evidence entries.");
    if (
      pull.baseRepositoryId !== config.repositoryId ||
      pull.url !== `https://github.com/${config.repository}/pull/${pull.number}`
    )
      return invalid("PR repository ID or constructed source URL does not match configuration.");
    if (
      pull.authorType === "Bot" &&
      pull.headRepositoryId === config.repositoryId &&
      pull.headRef === `release-log/${config.releaseBranch}`
    )
      return invalid("Unverified release automation cannot enter a usable snapshot.");
    const landed = new Map(pull.landedCommits.map((entry) => [entry.sha, entry]));
    const landing = landed.get(pull.mergeCommitSha);
    if (!landing) return invalid("PR landing evidence is absent from its footprint.");
    if (pull.landingKind === "merge") {
      if (
        landing.parentShas.length !== 2 ||
        landing.parentShas[1] !== pull.headSha ||
        canonical(
          pull.landedCommits
            .filter((entry) => entry.sha !== landing.sha)
            .map((entry) => entry.sha)
            .toSorted(),
        ) !== canonical(pull.originalCommits.map((entry) => entry.sha).toSorted())
      )
        return invalid("Merge footprint does not account for the original PR head/commits.");
    } else {
      const seen = new Set<string>();
      let current: GitCommitEvidence | undefined = landing;
      while (current) {
        if (seen.has(current.sha) || current.parentShas.length !== 1)
          return invalid("Linear PR footprint is cyclic or contains a merge.");
        seen.add(current.sha);
        current = landed.get(current.parentShas[0] ?? "");
      }
      if (seen.size !== landed.size || (seen.size !== 1 && seen.size !== pull.commitCount))
        return invalid("Linear footprint does not account for the complete landed sequence.");
    }
    for (const entry of pull.landedCommits) {
      if (graph.has(entry.sha)) return invalid("A landed commit has competing PR owners.");
      graph.set(entry.sha, entry);
    }
    for (const entry of [...pull.originalCommits, ...pull.landedCommits]) {
      const previousParents = parentsByCommit.get(entry.sha);
      if (previousParents && canonical(previousParents) !== canonical(entry.parentShas))
        return invalid("The same commit has contradictory original/landed parent evidence.");
      parentsByCommit.set(entry.sha, entry.parentShas);
      if ([entry.sha, ...entry.parentShas].some((id) => id.length !== range.sourceCommitSha.length))
        return invalid("Snapshot commit IDs mix object formats.");
    }
  }

  for (const entry of bootstrapCommits) {
    const adopting = config.schemaVersion === 2 && range.baseline.kind === "bootstrap";

    if ((!adopting && entry.parentShas.length !== 1) || graph.has(entry.sha))
      return invalid(
        "Bootstrap commit evidence must be single-parent and must not overlap a PR footprint.",
      );

    const previousParents = parentsByCommit.get(entry.sha);
    if (previousParents && canonical(previousParents) !== canonical(entry.parentShas))
      return invalid("The same commit has contradictory original/bootstrap parent evidence.");

    if ([entry.sha, ...entry.parentShas].some((id) => id.length !== range.sourceCommitSha.length))
      return invalid("Snapshot commit IDs mix object formats.");

    if (++evidenceCount > 5000) limit("Snapshot exceeds 5000 commit evidence entries.");

    graph.set(entry.sha, entry);
  }

  if (canonical([...graph.keys()].toSorted()) !== canonical(range.commitShas))
    return invalid("Associated footprints do not cover exactly the captured commit set.");
  if (
    range.baseline.commitSha.length !== range.sourceCommitSha.length ||
    (range.baseline.kind === "tag" &&
      range.baseline.objectSha.length !== range.sourceCommitSha.length)
  )
    return invalid("Snapshot endpoints mix object formats.");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: { sha: string; leaving: boolean }[] = [
    { sha: range.sourceCommitSha, leaving: false },
  ];
  let reachedBaseline = range.sourceCommitSha === range.baseline.commitSha;
  while (stack.length) {
    const frame = stack.pop();
    if (!frame) break;
    if (frame.leaving) {
      visiting.delete(frame.sha);
      visited.add(frame.sha);
      continue;
    }
    if (visited.has(frame.sha)) continue;
    const entry = graph.get(frame.sha);
    if (!entry) continue;
    if (visiting.has(frame.sha)) return invalid("Captured landed graph contains a cycle.");
    visiting.add(frame.sha);
    stack.push({ sha: frame.sha, leaving: true });
    for (const parent of entry.parentShas) {
      if (parent === range.baseline.commitSha) reachedBaseline = true;
      if (graph.has(parent)) stack.push({ sha: parent, leaving: false });
    }
  }
  if (!reachedBaseline || visited.size !== graph.size)
    return invalid(
      "Captured graph does not reach the baseline or contains commits outside the source history.",
    );
  const captured = {
    repository: config.repository,
    releaseBranch: config.releaseBranch,
    range,
    pullRequests,
    bootstrapCommits,
  };
  const historical = onboardingCommits(captured, config);

  if (
    config.schemaVersion === 2 &&
    range.baseline.kind === "bootstrap" &&
    bootstrapCommits.some((entry) => !historical.has(entry.sha))
  )
    return invalid("New changes after onboarding require verified merged-PR evidence.");

  return captured;
}

function onboardingCommits(
  input: ReleaseSnapshot["input"],
  config: ReleaseInputConfiguration,
): ReadonlySet<string> {
  if (config.schemaVersion !== 2 || input.range.baseline.kind !== "bootstrap") return new Set();

  const { baselineSha, onboardingSha } = config.bootstrap;

  if (baselineSha !== input.range.baseline.commitSha)
    return invalid("The captured bootstrap baseline differs from the trusted onboarding record.");

  const historical = new Set<string>();
  const graph = new Map(
    [...input.pullRequests.flatMap((pull) => pull.landedCommits), ...input.bootstrapCommits].map(
      (entry) => [entry.sha, entry],
    ),
  );
  const stack = [onboardingSha];
  let reachedBaseline = onboardingSha === baselineSha;

  while (stack.length) {
    const current = stack.pop();

    if (!current || current === baselineSha || historical.has(current)) continue;

    const entry = graph.get(current);

    if (!entry)
      return invalid(
        "The pinned onboarding SHA must belong to the captured baseline-to-source graph.",
      );

    historical.add(current);

    for (const parent of entry.parentShas) {
      if (parent === baselineSha) reachedBaseline = true;
      if (graph.has(parent)) stack.push(parent);
    }
  }

  if (!reachedBaseline)
    return invalid("The pinned onboarding SHA must descend from the approved bootstrap baseline.");

  return historical;
}

export async function captureReleaseSnapshot(
  input: PullRequestAssociation,
  config: ReleaseInputConfiguration,
): Promise<ReleaseSnapshot> {
  canonical(input);
  const selected = parseReleaseInputConfiguration(config);
  const captured = association(input, selected);
  const pullRequests: NormalizedReleaseInputs["pullRequests"][number][] = [];
  const historicalEntries: HistoricalReleaseEntry[] = [];
  const historical = onboardingCommits(captured, selected);

  for (const pull of captured.pullRequests) {
    const sourceCommits = [
      ...pull.originalCommits.map((entry) => ({ source: "original" as const, ...entry })),
      ...pull.landedCommits.map((entry) => ({ source: "landed" as const, ...entry })),
    ];
    const readiness = await validatePullRequestMetadata(
      pull.title,
      pull.body,
      sourceCommits.map((entry) => ({
        sha: entry.sha,
        message: entry.message,
        parentCount: entry.parentShas.length,
      })),
    );
    if (!readiness.valid && pull.landedCommits.every((entry) => historical.has(entry.sha))) {
      const context = parseReleaseContext(pull.body);
      const explanations = await Promise.all([
        readHistoricalBreakingChanges(pull.title),
        ...sourceCommits
          .filter((entry) => entry.parentShas.length < 2)
          .map((entry) => readHistoricalBreakingChanges(entry.message)),
      ]);

      historicalEntries.push({
        source: { kind: "pull-request", number: pull.number, url: pull.url },
        title: pull.title,
        context: context.valid ? context.context : null,
        breakingChanges: [...new Set(explanations.flat())].toSorted(),
        warnings: [...readiness.errors, ...readiness.warnings],
      });

      continue;
    }

    if (!readiness.valid)
      throw new ReleaseSnapshotError(
        "metadata-invalid",
        `PR #${pull.number} release metadata must be repaired before snapshot capture.`,
        readiness.errors,
      );
    const context = parseReleaseContext(pull.body);
    if (!context.valid)
      throw new ReleaseSnapshotError(
        "metadata-invalid",
        `PR #${pull.number} context could not be captured.`,
        context.errors.map((issue) => ({ ...issue, location: "context" })),
      );
    const commits: NormalizedReleaseInputs["pullRequests"][number]["commits"][number][] = [];
    for (const entry of sourceCommits) {
      if (entry.parentShas.length > 1) continue;
      const metadata = await validateConventionalMessage(entry.message);
      if (!metadata.valid)
        throw new ReleaseSnapshotError(
          "metadata-invalid",
          `PR #${pull.number} commit validation did not succeed.`,
        );
      commits.push({ source: entry.source, sha: entry.sha, metadata: metadata.commit });
    }
    pullRequests.push({
      number: pull.number,
      url: pull.url,
      title: readiness.title,
      context: readiness.context,
      rawBlock: context.rawBlock,
      breakingChanges: [
        ...new Set([
          ...readiness.title.breakingChanges,
          ...commits.flatMap((entry) => entry.metadata.breakingChanges),
        ]),
      ].toSorted(),
      commits,
      validation: { valid: true, warnings: readiness.warnings },
    });
  }

  const bootstrapCommits: NormalizedBootstrapCommit[] = [];

  for (const entry of captured.bootstrapCommits) {
    if (historical.has(entry.sha)) {
      historicalEntries.push({
        source: {
          kind: "commit",
          sha: entry.sha,
          url: `https://github.com/${selected.repository}/commit/${entry.sha}`,
        },
        title: entry.message.split(/\r\n|\n|\r/u)[0] || "(empty historical commit message)",
        context: null,
        breakingChanges: await readHistoricalBreakingChanges(entry.message),
        warnings: [
          {
            location: "commit",
            sha: entry.sha,
            code: entry.parentShas.length > 1 ? "historical-merge" : "historical-commit",
            message:
              "Retained historical Git evidence without structured PR release context; review before the initial release.",
          },
        ],
      });

      continue;
    }

    const metadata = await validateConventionalMessage(entry.message);

    if (!metadata.valid)
      throw new ReleaseSnapshotError(
        "metadata-invalid",
        `Bootstrap commit ${entry.sha} requires a valid conventional message; no type or release context is inferred.`,
        metadata.errors.map((issue) => ({
          location: "commit",
          sha: entry.sha,
          code: issue.rule,
          message: issue.message,
        })),
      );

    bootstrapCommits.push({
      sha: entry.sha,
      url: `https://github.com/${selected.repository}/commit/${entry.sha}`,
      metadata: metadata.commit,
    });
  }

  const payload = {
    schemaVersion: 3 as const,
    tool: { ...tool },
    configuration: selected,
    configurationId: digest(selected),
    input: captured,
    normalized: {
      repository: selected.repository,
      releaseBranch: selected.releaseBranch,
      baselineCommitSha: captured.range.baseline.commitSha,
      sourceCommitSha: captured.range.sourceCommitSha,
      pullRequests,
      bootstrapCommits,
      historicalEntries,
    },
  };
  const snapshot = { ...payload, snapshotId: digest(payload) };
  canonical(snapshot);
  return snapshot;
}

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
    ],
    "snapshot envelope",
  );
  if (item.schemaVersion !== 3)
    return invalid(
      "Unsupported release snapshot schema version; no automatic migration is performed.",
    );
  const capturedTool = object(item.tool, ["version", "normalizerId"], "tool identity");
  if (capturedTool.version !== tool.version || capturedTool.normalizerId !== tool.normalizerId)
    throw new ReleaseSnapshotError(
      "normalizer-mismatch",
      "Replay requires the captured tool version, normalization policy, and runtime dependency versions.",
    );
  const config = parseReleaseInputConfiguration(item.configuration);
  if (
    digest(config) !== digest(parseReleaseInputConfiguration(expected)) ||
    item.configurationId !== digest(config)
  )
    throw new ReleaseSnapshotError(
      "configuration-mismatch",
      "Replay configuration differs from the captured configuration identity.",
    );
  object(
    item.input,
    ["repository", "releaseBranch", "range", "pullRequests", "bootstrapCommits"],
    "version 3 association evidence",
  );

  const captured = association(item.input, config);
  const recomputed = await captureReleaseSnapshot(captured, config);
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
  const serialized = canonical(validated) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes)
    return limit("Snapshot exceeds 16 MiB including its final newline.");
  return serialized;
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
