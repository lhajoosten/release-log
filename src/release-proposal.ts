import { createHash } from "node:crypto";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "./github-proposals.ts";
import type { ProposalPullRequest, ProposalTree } from "./github-proposals.ts";
import type { GitHubRead } from "./github.ts";
import { prepareReleaseFileContents } from "./proposal-files.ts";
import type { PreparedRelease, ProposalFile } from "./proposal-files.ts";
import { validatePullRequestMetadata } from "./pr-readiness.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import { parseReleaseInputConfiguration, replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration, ReleaseSnapshot } from "./release-snapshot.ts";

export interface ReleaseAutomationConfiguration {
  readonly schemaVersion: 1;
  readonly botUserId: number;
}
export function parseReleaseAutomation(value: unknown): ReleaseAutomationConfiguration {
  const item = proposalObject(value);
  if (
    item.schemaVersion !== 1 ||
    Object.keys(item).toSorted().join(",") !== "botUserId,schemaVersion" ||
    typeof item.botUserId !== "number" ||
    !Number.isSafeInteger(item.botUserId) ||
    item.botUserId <= 0
  )
    throw new ProposalConflictError(
      "Configure exactly schemaVersion 1 and the expected positive numeric botUserId.",
    );
  return { schemaVersion: 1, botUserId: item.botUserId };
}

export interface ReleaseProposalRequest {
  readonly snapshot: string;
  readonly configuration: ReleaseInputConfiguration;
  readonly version: ReleaseVersionConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly token: string;
  readonly write?: boolean;
}
export interface ReleaseProposalResult {
  readonly outcome:
    | "no-release"
    | "unchanged"
    | "would-create"
    | "would-refresh"
    | "created"
    | "refreshed";
  readonly sourceSha: string;
  readonly baselineSha: string;
  readonly snapshotId: string;
  readonly proposalId: string | null;
  readonly branch: string;
  readonly pullNumber: number | null;
  readonly headSha: string | null;
}
interface ProposalIdentity {
  readonly schemaVersion: 1;
  readonly repositoryId: number;
  readonly releaseBranch: string;
  readonly botUserId: number;
  readonly sourceSha: string;
  readonly baseline: ReleaseSnapshot["input"]["range"]["baseline"];
  readonly snapshotId: string;
  readonly configurationId: string;
  readonly version: ReleaseVersionConfiguration;
  readonly previousHeadSha: string | null;
  readonly files: readonly { path: string; sha256: string }[];
}
interface Description {
  readonly identity: ProposalIdentity;
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly message: string;
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function describe(
  snapshot: ReleaseSnapshot,
  prepared: PreparedRelease,
  botUserId: number,
  previousHeadSha: string | null,
): Description {
  const nextVersion = prepared.plan.nextVersion;
  if (nextVersion === null)
    throw new ProposalConflictError("A no-release plan cannot be described as a release proposal.");
  for (const file of prepared.files)
    if (Buffer.byteLength(file.after, "utf8") > 2 * 1024 * 1024)
      throw new ProposalConflictError("Controller output files exceed the 2 MiB per-file limit.");
  const identity: ProposalIdentity = {
    schemaVersion: 1,
    repositoryId: snapshot.configuration.repositoryId,
    releaseBranch: snapshot.configuration.releaseBranch,
    botUserId,
    sourceSha: prepared.plan.sourceCommitSha,
    baseline: snapshot.input.range.baseline,
    snapshotId: snapshot.snapshotId,
    configurationId: snapshot.configurationId,
    version: prepared.plan.version,
    previousHeadSha,
    files: prepared.files.map((file) => ({ path: file.path, sha256: digest(file.after) })),
  };
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64url");
  const id = digest(JSON.stringify(identity));
  const title = `chore(release): prepare v${nextVersion}`;
  const markerLines = encoded.match(/.{1,72}/gu) ?? [];
  const message = `chore: prepare v${nextVersion}\n\nRelease-Log-Proposal:\n${markerLines.join("\n")}\n`;
  const body = [
    `<!-- release-log:proposal:v1 ${encoded} -->`,
    "",
    `## Proposed release v${nextVersion}`,
    "",
    `Source: ${identity.sourceSha}`,
    `Baseline: ${identity.baseline.commitSha}`,
    `Snapshot: ${identity.snapshotId}`,
    `Proposal: ${id}`,
    "",
    "Review the generated version fields, changelog and captured inputs before merging. This PR does not publish a release.",
    "",
    "```release-log",
    "version: 1",
    "audience: internal",
    `summary: Prepare the proposed v${nextVersion} release.`,
    "impact: Propose the captured version, changelog and release inputs for review.",
    "required_action: Review the version, changelog and captured snapshot before merging.",
    "```",
    "",
  ].join("\n");
  return { identity, id, title, body, message };
}
function capturedIdentity(message: string): {
  sourceSha: string;
  version: ReleaseVersionConfiguration;
  previousHeadSha: string | null;
} {
  const match = /\n\nRelease-Log-Proposal:\n((?:[A-Za-z0-9_-]{1,72}\n)+)$/u.exec(message);
  if (!match?.[1] || match[1].length > 32_768)
    throw new ProposalConflictError(
      "The reserved branch does not contain a supported generated proposal commit.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(match[1].replaceAll("\n", ""), "base64url").toString("utf8"));
  } catch {
    throw new ProposalConflictError("The generated proposal marker is malformed.");
  }
  const object = proposalObject(raw);
  const version = proposalObject(object.version);
  let selected: ReleaseVersionConfiguration;
  if (version.kind === "bootstrap" && version.initialVersion === "0.1.0")
    selected = { kind: "bootstrap", initialVersion: "0.1.0" };
  else if (version.kind === "released" && typeof version.currentVersion === "string")
    selected = { kind: "released", currentVersion: version.currentVersion };
  else throw new ProposalConflictError("Unsupported proposal version configuration.");
  return {
    sourceSha: proposalSha(object.sourceSha),
    version: selected,
    previousHeadSha: object.previousHeadSha === null ? null : proposalSha(object.previousHeadSha),
  };
}
function samePull(left: ProposalPullRequest, right: ProposalPullRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function verifyGeneratedTree(
  source: ProposalTree,
  head: ProposalTree,
  files: readonly ProposalFile[],
): void {
  const owned = new Set<string>(files.map((file) => file.path));
  for (const path of new Set([...source.entries.keys(), ...head.entries.keys()])) {
    const before = source.entries.get(path);
    const after = head.entries.get(path);
    if (path === ".release-log") {
      if (
        !after ||
        after.type !== "tree" ||
        after.mode !== "040000" ||
        (before && (before.type !== "tree" || before.mode !== "040000"))
      )
        throw new ProposalConflictError("Unexpected snapshot directory changes in the proposal.");
    } else if (owned.has(path)) {
      if (!after || after.type !== "blob" || after.mode !== (before?.mode ?? "100644"))
        throw new ProposalConflictError("Unexpected generated file type or mode in the proposal.");
    } else if (!before || !after || JSON.stringify(before) !== JSON.stringify(after))
      throw new ProposalConflictError(
        "The proposal branch contains unrelated file changes; preserve them and recover manually.",
      );
  }
  for (const file of files)
    if (!head.entries.has(file.path))
      throw new ProposalConflictError("A generated proposal file is missing.");
}
async function verifyPrevious(
  api: GitHubProposalRepository,
  pull: ProposalPullRequest,
  expected: ReleaseInputConfiguration,
  botUserId: number,
): Promise<Description> {
  const head = await api.tree(pull.headSha);
  const marker = capturedIdentity(head.message);
  const contents = await api.contents(head);
  const capturedJSON = contents[".release-log/inputs.json"];
  if (capturedJSON === null) throw new ProposalConflictError("The proposal snapshot is missing.");
  const snapshot = await replayReleaseSnapshot(capturedJSON, expected);
  if (snapshot.normalized.sourceCommitSha !== marker.sourceSha)
    throw new ProposalConflictError(
      "The proposal snapshot source differs from its commit identity.",
    );
  const source = await api.tree(marker.sourceSha);
  const prepared = await prepareReleaseFileContents(
    capturedJSON,
    expected,
    marker.version,
    await api.contents(source),
  );
  const description = describe(snapshot, prepared, botUserId, marker.previousHeadSha);
  const parents =
    marker.previousHeadSha && marker.previousHeadSha !== marker.sourceSha
      ? [marker.sourceSha, marker.previousHeadSha]
      : [marker.sourceSha];
  if (
    head.message !== description.message ||
    JSON.stringify(head.parents) !== JSON.stringify(parents) ||
    pull.title !== description.title ||
    pull.body !== description.body
  )
    throw new ProposalConflictError(
      "Proposal metadata, ancestry or generated identity was edited or only partially saved; review and recover explicitly.",
    );
  verifyGeneratedTree(source, head, prepared.files);
  for (const file of prepared.files)
    if (contents[file.path] !== file.after)
      throw new ProposalConflictError(
        "Generated proposal content was edited; review rather than overwrite it.",
      );
  return description;
}

export async function reconcileReleaseProposal(
  request: ReleaseProposalRequest,
  transport: GitHubRead = fetch,
): Promise<ReleaseProposalResult> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const automation = parseReleaseAutomation(request.automation);
  const snapshotJSON = request.snapshot;
  const selectedVersion = structuredClone(request.version);
  const token = request.token;
  const write = request.write === true;
  if (request.write !== undefined && typeof request.write !== "boolean")
    throw new ProposalConflictError("An explicit boolean write option is required.");
  const snapshot = await replayReleaseSnapshot(snapshotJSON, config);
  const api = new GitHubProposalRepository(config, automation.botUserId, token, transport);
  const sourceSha = snapshot.normalized.sourceCommitSha;
  const baseline = snapshot.input.range.baseline;
  const requireFresh = async () => {
    if ((await api.ref("heads", config.releaseBranch)) !== sourceSha)
      throw new ProposalConflictError(
        "Main changed after capture; collect and review the complete range again.",
      );
    if (baseline.kind === "tag" && (await api.ref("tags", baseline.name)) !== baseline.objectSha)
      throw new ProposalConflictError(
        "The captured baseline tag moved; review the completed release record.",
      );
  };
  await api.verifyRepository();
  await requireFresh();
  const pulls = await api.pulls();
  if (pulls.length > 1 || pulls.some((pull) => pull.state !== "open" || pull.merged))
    throw new ProposalConflictError(
      "A closed/merged or competing proposal exists; explicit recovery or completed-cycle verification is required before reuse.",
    );
  const previous = pulls[0] ?? null;
  const initialHead = await api.ref("heads", api.headRef, true);
  if (previous ? initialHead !== previous.headSha : initialHead !== null)
    throw new ProposalConflictError(
      "The proposal branch was deleted, moved, or exists without a verified PR; do not recreate or overwrite it automatically.",
    );
  const prior = previous ? await verifyPrevious(api, previous, config, automation.botUserId) : null;
  if (prior && JSON.stringify(prior.identity.baseline) !== JSON.stringify(baseline))
    throw new ProposalConflictError(
      "The proposal belongs to another baseline; review the release lifecycle before refreshing.",
    );
  if (prior) await api.requireDescendant(prior.identity.sourceSha, sourceSha);
  const source = await api.tree(sourceSha);
  const prepared = await prepareReleaseFileContents(
    snapshotJSON,
    config,
    selectedVersion,
    await api.contents(source),
  );
  const result = (
    outcome: ReleaseProposalResult["outcome"],
    proposalId: string | null,
    pullNumber = previous?.number ?? null,
    headSha = initialHead,
  ): ReleaseProposalResult => ({
    outcome,
    sourceSha,
    baselineSha: baseline.commitSha,
    snapshotId: snapshot.snapshotId,
    proposalId,
    branch: api.headRef,
    pullNumber,
    headSha,
  });
  if (!prepared.plan.release) {
    if (previous)
      throw new ProposalConflictError(
        "A proposal is open but the new plan has no release; do not silently close or remove it.",
      );
    return result("no-release", null);
  }
  if (
    prior?.identity.snapshotId === snapshot.snapshotId &&
    JSON.stringify(prior.identity.version) === JSON.stringify(prepared.plan.version)
  )
    return result("unchanged", prior.id);
  const description = describe(snapshot, prepared, automation.botUserId, initialHead);
  const readiness = await validatePullRequestMetadata(description.title, description.body, [
    { sha: sourceSha, message: description.message, parentCount: 1 },
  ]);
  if (!readiness.valid)
    throw new ProposalConflictError(
      `Generated proposal metadata does not satisfy contribution/readiness policy: ${readiness.errors.map((issue) => issue.code).join(", ")}.`,
    );
  if (!write) return result(previous ? "would-refresh" : "would-create", description.id);
  const unchanged = async () => {
    await requireFresh();
    if ((await api.ref("heads", api.headRef, true)) !== initialHead)
      throw new ProposalConflictError(
        "The proposal head changed during reconciliation; retry from freshly verified state.",
      );
    if (previous && !samePull(previous, await api.readPull(previous.number)))
      throw new ProposalConflictError(
        "PR metadata changed during reconciliation; preserve human edits and recover manually.",
      );
  };
  await unchanged();
  const head = await api.commit(source, initialHead, prepared.files, description.message);
  const generated = await api.tree(head);
  const expectedParents =
    initialHead && initialHead !== sourceSha ? [sourceSha, initialHead] : [sourceSha];
  if (
    generated.message !== description.message ||
    JSON.stringify(generated.parents) !== JSON.stringify(expectedParents)
  )
    throw new ProposalConflictError(
      "GitHub created unexpected proposal commit evidence; no branch update is permitted.",
    );
  verifyGeneratedTree(source, generated, prepared.files);
  const generatedContents = await api.contents(generated);
  if (prepared.files.some((file) => generatedContents[file.path] !== file.after))
    throw new ProposalConflictError(
      "GitHub created unexpected generated file content; no branch update is permitted.",
    );
  await unchanged();
  await api.setRef(head, initialHead !== null);
  await requireFresh();
  if ((await api.ref("heads", api.headRef)) !== head)
    throw new ProposalConflictError(
      "The proposal ref changed before PR save; reconcile remote state before retrying.",
    );
  if (
    previous &&
    !samePull(previous, { ...(await api.readPull(previous.number)), headSha: previous.headSha })
  )
    throw new ProposalConflictError(
      "PR metadata changed before save; recover the partially updated branch explicitly.",
    );
  const pull = await api.savePull(previous, description.title, description.body);
  if (
    pull.state !== "open" ||
    pull.merged ||
    pull.headSha !== head ||
    pull.title !== description.title ||
    pull.body !== description.body
  )
    throw new ProposalConflictError(
      "GitHub did not save the exact expected proposal; reconcile before retrying.",
    );
  await requireFresh();
  if (
    (await api.ref("heads", api.headRef)) !== head ||
    !samePull(pull, await api.readPull(pull.number))
  )
    throw new ProposalConflictError(
      "Proposal state changed after save; no approval or publication is authorized.",
    );
  return result(previous ? "refreshed" : "created", description.id, pull.number, head);
}
