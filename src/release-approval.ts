import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { inspectCommit, inspectGitTree, inspectPendingRelease, readGitBlob } from "./git.ts";
import type { ResolvedReleaseBaseline } from "./git.ts";
import { GitHubProposalRepository } from "./github-proposals.ts";
import type { ProposalTree } from "./github-proposals.ts";
import type { GitHubRead } from "./github.ts";
import { prepareReleaseFileContents } from "./proposal-files.ts";
import type { ReleaseFileContents } from "./proposal-files.ts";
import { capturedIdentity, describe, verifyGeneratedTree } from "./proposal-identity.ts";
import { validateConventionalMessage } from "./conventional.ts";
import { parseReleaseInputConfiguration, replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export class ReleaseApprovalError extends Error {
  readonly code:
    | "approval-invalid"
    | "identity-mismatch"
    | "stale-source"
    | "baseline-mismatch"
    | "content-mismatch"
    | "unsupported-merge";
  constructor(code: ReleaseApprovalError["code"], message: string) {
    super(message);
    this.name = "ReleaseApprovalError";
    this.code = code;
  }
}
export interface ReleaseApprovalPolicy {
  readonly schemaVersion: 1;
  readonly botUserId: number;
  readonly approverUserIds: readonly number[];
}
export interface ReleaseApproval {
  readonly schemaVersion: 1;
  readonly repositoryId: number;
  readonly pullNumber: number;
  readonly approverUserId: number;
  readonly sourceSha: string;
  readonly headSha: string;
  readonly landingSha: string;
  readonly mergeKind: "merge" | "squash";
  readonly baseline: ResolvedReleaseBaseline;
  readonly snapshotId: string;
  readonly proposalId: string;
}
export interface VerifiedReleaseApproval extends ReleaseApproval {
  readonly releaseBranch: string;
  readonly version: string;
  readonly configurationId: string;
  readonly policyId: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly verificationId: string;
}
function invalid(message: string): never {
  throw new ReleaseApprovalError("approval-invalid", message);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return invalid("Approval records/policies require exactly the supported schema fields.");
  return Object.fromEntries(Object.entries(value));
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid("Approval identities require positive safe integer IDs.");
  return value;
}
function sha(value: unknown, digest = false): string {
  if (
    typeof value !== "string" ||
    !(digest ? /^[a-f0-9]{64}$/u : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).test(value)
  )
    return invalid("Approval records require full lowercase object IDs and SHA-256 digests.");
  return value;
}
function baseline(value: unknown): ResolvedReleaseBaseline {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return invalid("An explicit approved baseline is required.");
  if (value.kind === "bootstrap") {
    const item = object(value, ["kind", "commitSha"]);
    return { kind: "bootstrap", commitSha: sha(item.commitSha) };
  }
  const item = object(value, ["kind", "name", "objectSha", "commitSha"]);
  if (
    item.kind !== "tag" ||
    typeof item.name !== "string" ||
    item.name.length > 128 ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(item.name)
  )
    return invalid("Approved release tags require stable vMAJOR.MINOR.PATCH names.");
  return {
    kind: "tag",
    name: item.name,
    objectSha: sha(item.objectSha),
    commitSha: sha(item.commitSha),
  };
}
export function parseReleaseApprovalJSON(serialized: string): unknown {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 1024 * 1024)
    return invalid("Approval JSON must be bounded to 1 MiB UTF-8.");
  try {
    const value: unknown = JSON.parse(serialized);
    if (parseDocument(serialized, { uniqueKeys: true, strict: true, version: "1.2" }).errors.length)
      return invalid("Approval JSON must not repeat property names.");
    return value;
  } catch {
    return invalid("Approval JSON must be valid and must not repeat property names.");
  }
}

export function parseReleaseApprovalPolicy(value: unknown): ReleaseApprovalPolicy {
  const item = object(value, ["schemaVersion", "botUserId", "approverUserIds"]);
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.approverUserIds) ||
    item.approverUserIds.length < 1 ||
    item.approverUserIds.length > 1000
  )
    return invalid(
      "Configure schemaVersion 1 and an explicit nonempty bounded list of human approver IDs.",
    );
  const botUserId = positive(item.botUserId);
  const approverUserIds = item.approverUserIds.map(positive).toSorted((a, b) => a - b);
  if (
    new Set(approverUserIds).size !== approverUserIds.length ||
    approverUserIds.includes(botUserId)
  )
    return invalid("Human approvers must be unique and must not include the automation bot.");
  return { schemaVersion: 1, botUserId, approverUserIds };
}
export function parseReleaseApproval(value: unknown): ReleaseApproval {
  const item = object(value, [
    "schemaVersion",
    "repositoryId",
    "pullNumber",
    "approverUserId",
    "sourceSha",
    "headSha",
    "landingSha",
    "mergeKind",
    "baseline",
    "snapshotId",
    "proposalId",
  ]);
  if (item.schemaVersion !== 1)
    return invalid(
      "Unsupported release approval schema; no migration or inferred approval is performed.",
    );
  if (item.mergeKind !== "merge" && item.mergeKind !== "squash")
    throw new ReleaseApprovalError(
      "unsupported-merge",
      "A trusted merge/squash method record is required; rebase or an inferred merge strategy is unsupported.",
    );
  return {
    schemaVersion: 1,
    repositoryId: positive(item.repositoryId),
    pullNumber: positive(item.pullNumber),
    approverUserId: positive(item.approverUserId),
    sourceSha: sha(item.sourceSha),
    headSha: sha(item.headSha),
    landingSha: sha(item.landingSha),
    mergeKind: item.mergeKind,
    baseline: baseline(item.baseline),
    snapshotId: sha(item.snapshotId, true),
    proposalId: sha(item.proposalId, true),
  };
}
async function localTree(repository: string, commitSha: string): Promise<ProposalTree> {
  const tree = await inspectGitTree(repository, commitSha);
  const commit = await inspectCommit(repository, commitSha);
  return { ...tree, message: commit.message, parents: commit.parentShas };
}
async function contents(repository: string, tree: ProposalTree): Promise<ReleaseFileContents> {
  const get = async (path: string): Promise<string | null> => {
    const directory = tree.entries.get(".release-log");
    if (
      path.startsWith(".release-log/") &&
      directory &&
      (directory.type !== "tree" || directory.mode !== "040000")
    )
      throw new ReleaseApprovalError(
        "content-mismatch",
        "The approved snapshot directory must not be a symlink or submodule.",
      );
    const entry = tree.entries.get(path);
    if (!entry) return null;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new ReleaseApprovalError(
        "content-mismatch",
        "Approved proposal inputs must be ordinary tracked files.",
      );
    return readGitBlob(repository, entry.sha);
  };
  return {
    "package.json": await get("package.json"),
    "pyproject.toml": await get("pyproject.toml"),
    "CHANGELOG.md": await get("CHANGELOG.md"),
    ".release-log/inputs.json": await get(".release-log/inputs.json"),
    "package-lock.json": await get("package-lock.json"),
    "npm-shrinkwrap.json": await get("npm-shrinkwrap.json"),
    "uv.lock": await get("uv.lock"),
  };
}

export async function verifyReleaseApproval(
  request: {
    readonly repository: string;
    readonly configuration: ReleaseInputConfiguration;
    readonly policy: ReleaseApprovalPolicy;
    readonly approval: ReleaseApproval;
    readonly token: string;
  },
  transport: GitHubRead = fetch,
): Promise<VerifiedReleaseApproval> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const policy = parseReleaseApprovalPolicy(request.policy);
  const approval = parseReleaseApproval(request.approval);
  const repository = request.repository;
  if (
    approval.repositoryId !== config.repositoryId ||
    !policy.approverUserIds.includes(approval.approverUserId)
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The approval repository or human approver is not allowed by trusted policy.",
    );
  const api = new GitHubProposalRepository(config, policy.botUserId, request.token, transport);
  await api.verifyRepository();
  const pull = await api.readPull(approval.pullNumber);
  if (
    pull.number !== approval.pullNumber ||
    pull.state !== "closed" ||
    !pull.merged ||
    pull.headSha !== approval.headSha ||
    pull.mergeCommitSha !== approval.landingSha ||
    pull.mergedByUserId !== approval.approverUserId
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "GitHub must confirm the exact merged PR, reviewed head, actual landing and allowed human merger.",
    );
  const current = await api.ref("heads", config.releaseBranch);
  if (current === null)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The configured release branch is unavailable.",
    );
  await api.requireDescendant(approval.landingSha, current);
  if (
    approval.baseline.kind === "tag" &&
    (await api.ref("tags", approval.baseline.name)) !== approval.baseline.objectSha
  )
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The approved baseline tag moved after capture; do not publish from cached checks.",
    );
  const selectedBaseline =
    approval.baseline.kind === "tag"
      ? { kind: "tag" as const, name: approval.baseline.name }
      : { kind: "bootstrap" as const, commitSha: approval.baseline.commitSha };
  const sourceRange = await inspectPendingRelease(repository, selectedBaseline, approval.sourceSha);
  if (JSON.stringify(sourceRange.baseline) !== JSON.stringify(approval.baseline))
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The local resolved baseline differs from the approved immutable baseline.",
    );
  await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: approval.sourceSha },
    approval.landingSha,
  );
  const source = await localTree(repository, approval.sourceSha);
  const head = await localTree(repository, approval.headSha);
  const landing = await localTree(repository, approval.landingSha);
  const expectedLandingParents =
    approval.mergeKind === "merge" ? [approval.sourceSha, approval.headSha] : [approval.sourceSha];
  if (JSON.stringify(landing.parents) !== JSON.stringify(expectedLandingParents))
    throw new ReleaseApprovalError(
      "stale-source",
      "The actual release landing parents differ from the captured source/reviewed head; refresh and review rather than publishing a stale proposal.",
    );
  if (landing.treeSha !== head.treeSha)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The actual landing tree differs from the reviewed proposal tree.",
    );
  const files = await contents(repository, head);
  const snapshotJSON = files[".release-log/inputs.json"];
  if (snapshotJSON === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "The reviewed head does not contain its captured inputs.",
    );
  const snapshot = await replayReleaseSnapshot(snapshotJSON, config);
  const marker = capturedIdentity(head.message);
  if (
    snapshot.snapshotId !== approval.snapshotId ||
    snapshot.normalized.sourceCommitSha !== approval.sourceSha ||
    marker.sourceSha !== approval.sourceSha ||
    JSON.stringify(snapshot.input.range.baseline) !== JSON.stringify(approval.baseline) ||
    JSON.stringify(snapshot.input.range.commitShas.toSorted()) !==
      JSON.stringify(sourceRange.commitShas.toSorted())
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The reviewed snapshot/source/baseline or actual Git membership does not match the independent approval record.",
    );
  const prepared = await prepareReleaseFileContents(
    snapshotJSON,
    config,
    marker.version,
    await contents(repository, source),
  );
  const description = describe(snapshot, prepared, policy.botUserId, marker.previousHeadSha);
  const expectedHeadParents =
    marker.previousHeadSha && marker.previousHeadSha !== approval.sourceSha
      ? [approval.sourceSha, marker.previousHeadSha]
      : [approval.sourceSha];
  if (
    description.id !== approval.proposalId ||
    head.message !== description.message ||
    JSON.stringify(head.parents) !== JSON.stringify(expectedHeadParents) ||
    pull.title !== description.title ||
    pull.body !== description.body
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Reviewed commit, proposal identity or PR metadata differs from recomputed approved inputs.",
    );
  verifyGeneratedTree(source, head, prepared.files);
  if (prepared.files.some((file) => files[file.path] !== file.after))
    throw new ReleaseApprovalError(
      "content-mismatch",
      "Reviewed generated file content differs from recomputation.",
    );
  if (approval.mergeKind === "squash") {
    const message = await validateConventionalMessage(landing.message);
    if (
      !message.valid ||
      message.commit.type !== "chore" ||
      message.commit.scope !== null ||
      message.commit.description !== `prepare v${prepared.plan.nextVersion}` ||
      message.commit.breaking
    )
      throw new ReleaseApprovalError(
        "content-mismatch",
        "The release squash commit must retain the approved unscoped conventional subject without breaking declarations.",
      );
  }
  if (prepared.plan.nextVersion === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "A no-release plan cannot be approved for publication.",
    );
  if (JSON.stringify(await api.readPull(approval.pullNumber)) !== JSON.stringify(pull))
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "Merged PR metadata changed during verification; obtain fresh evidence.",
    );
  if (
    approval.baseline.kind === "tag" &&
    (await api.ref("tags", approval.baseline.name)) !== approval.baseline.objectSha
  )
    throw new ReleaseApprovalError(
      "baseline-mismatch",
      "The baseline changed during verification; do not reuse stale approval.",
    );
  const latest = await api.ref("heads", config.releaseBranch);
  if (latest === null)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The release branch became unavailable during verification.",
    );
  await api.requireDescendant(approval.landingSha, latest);
  const result = {
    ...approval,
    releaseBranch: config.releaseBranch,
    version: prepared.plan.nextVersion,
    configurationId: snapshot.configurationId,
    policyId: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    files: description.identity.files,
  };
  return {
    ...result,
    verificationId: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  };
}
