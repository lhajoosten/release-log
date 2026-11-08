import { createHash } from "node:crypto";
import { ProposalConflictError, proposalObject, proposalSha } from "./github-proposals.ts";
import type { ProposalTree } from "./github-proposals.ts";
import type { PreparedRelease, ProposalFile } from "./proposal-files.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import type { ReleaseSnapshot } from "./release-snapshot.ts";

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
export interface Description {
  readonly identity: ProposalIdentity;
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly message: string;
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function describe(
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
export function capturedIdentity(message: string): {
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
export function verifyGeneratedTree(
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
