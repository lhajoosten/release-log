import { inspectGitTreeWithCommit, inspectPendingRelease, readGitBlob } from "../git.ts";
import type { ResolvedReleaseBaseline } from "../git.ts";
import type { ProposalTree } from "../github-proposals.ts";
import { reconstructProposal } from "../producer-runtime.ts";
import { capturedVerificationConfiguration, hasSameBumpPolicy } from "../proposal/verification.ts";
import { readReleaseContents, trackedReleaseInput } from "../version-file-inputs.ts";
import type { ReleaseFileContents } from "../version-file-inputs.ts";
import { capturedIdentity, verifyGeneratedTree } from "../proposal/identity.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { ReleaseApprovalError } from "./validation.ts";

export async function readLocalProposalTree(
  repository: string,
  commitSha: string,
): Promise<ProposalTree> {
  const { tree, commit } = await inspectGitTreeWithCommit(repository, commitSha);
  return { ...tree, message: commit.message, parents: commit.parentShas };
}
export async function readProposalContents(
  repository: string,
  tree: ProposalTree,
  includeWorkflow = false,
): Promise<ReleaseFileContents> {
  return readReleaseContents(async (path) => {
    const entry = trackedReleaseInput(
      tree.entries,
      path,
      (message) => new ReleaseApprovalError("content-mismatch", message),
    );
    return entry ? readGitBlob(repository, entry.sha) : null;
  }, includeWorkflow);
}

function requireAuditTime(deadline: number): void {
  if (Date.now() >= deadline)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Proposal history verification exceeded five minutes; no exclusion is usable.",
    );
}

function sameLanding(candidate: ProposalTree, landing: ProposalTree): boolean {
  const [source, mergedHead, ...otherParents] = landing.parents;
  return (
    source !== undefined &&
    source === candidate.parents[0] &&
    candidate.treeSha === landing.treeSha &&
    otherParents.length === 0 &&
    (mergedHead === undefined || mergedHead === candidate.commitSha)
  );
}

async function findCompletedHead(
  repository: string,
  baseline: ResolvedReleaseBaseline,
  previousShas: readonly string[],
  deadline: number,
): Promise<string> {
  let match: string | undefined;
  if (baseline.kind === "tag") {
    const landing = await readLocalProposalTree(repository, baseline.commitSha);
    for (const sha of previousShas) {
      requireAuditTime(deadline);
      const candidate = await readLocalProposalTree(repository, sha);
      if (!sameLanding(candidate, landing)) continue;

      if (match !== undefined)
        throw new ReleaseApprovalError(
          "identity-mismatch",
          "Multiple proposal heads match the tagged release landing.",
        );
      match = sha;
    }
  }
  if (match === undefined)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "A prior proposal belongs to a different baseline or bump policy without a matching tagged landing.",
    );
  return match;
}

async function replayPriorProposal(
  repository: string,
  config: ReleaseInputConfiguration,
  botUserId: number,
  marker: ReturnType<typeof capturedIdentity>,
  snapshotJSON: string,
) {
  const configuration = capturedVerificationConfiguration(snapshotJSON, config, "tagged-history");
  const source = await readLocalProposalTree(repository, marker.sourceSha);
  const replay = await reconstructProposal(
    snapshotJSON,
    configuration,
    marker.version,
    await readProposalContents(repository, source, config.selfUpgrade === true),
    botUserId,
    marker.previousHeadSha,
    marker.producerSha,
    marker.bodyFormat,
  );
  return {
    ...replay,
    source,
    marker,
    historicalBumps: !hasSameBumpPolicy(configuration, config),
  };
}

type PriorProposal = Awaited<ReturnType<typeof replayPriorProposal>>;

async function verifyHistoryRange(
  repository: string,
  prior: PriorProposal,
  sourceSha: string,
): Promise<void> {
  const { snapshot, marker } = prior;
  const baseline = snapshot.input.range.baseline;
  const range = await inspectPendingRelease(
    repository,
    baseline.kind === "tag" ? { kind: "tag", name: baseline.name } : baseline,
    marker.sourceSha,
  );
  if (
    snapshot.normalized.sourceCommitSha !== marker.sourceSha ||
    JSON.stringify(range.baseline) !== JSON.stringify(baseline) ||
    JSON.stringify(range.commitShas.toSorted()) !==
      JSON.stringify(snapshot.input.range.commitShas.toSorted())
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "A prior proposal snapshot has inconsistent source, baseline or Git membership.",
    );

  await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: marker.sourceSha },
    sourceSha,
  );
}

function verifyHistoryOutputs(
  prior: PriorProposal,
  head: ProposalTree,
  files: ReleaseFileContents,
): void {
  const { marker, description, source, prepared } = prior;
  const parents = [marker.sourceSha];
  if (marker.previousHeadSha && marker.previousHeadSha !== marker.sourceSha)
    parents.push(marker.previousHeadSha);

  if (
    head.message !== description.message ||
    JSON.stringify(head.parents) !== JSON.stringify(parents)
  )
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "A prior proposal commit does not match its generated identity and parents.",
    );

  verifyGeneratedTree(source, head, prepared.files);
  if (prepared.files.some((file) => files[file.path] !== file.after))
    throw new ReleaseApprovalError(
      "content-mismatch",
      "A prior proposal contains edited generated outputs; do not exclude it.",
    );
}

function requirePriorSnapshot(files: ReleaseFileContents, bytesSoFar: number): string {
  const snapshot = files[".release-log/inputs.json"];
  if (snapshot === null)
    throw new ReleaseApprovalError(
      "content-mismatch",
      "A prior proposal head is missing its captured inputs; do not exclude its history.",
    );
  if (bytesSoFar + Buffer.byteLength(snapshot, "utf8") > 16 * 1024 * 1024)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Prior proposal snapshots exceed the 16 MiB audit budget.",
    );
  return snapshot;
}

function verifyCompletedVersion(prior: PriorProposal, baseline: ResolvedReleaseBaseline): void {
  if (baseline.kind !== "tag" || `v${prior.prepared.plan.nextVersion}` !== baseline.name)
    throw new ReleaseApprovalError(
      "identity-mismatch",
      "The completed proposal version does not match its tagged landing.",
    );
}

export async function verifyProposalHistory(
  repository: string,
  config: ReleaseInputConfiguration,
  botUserId: number,
  sourceSha: string,
  headSha: string,
  expectedBaseline: ResolvedReleaseBaseline,
): Promise<readonly string[]> {
  const history = await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: sourceSha },
    headSha,
  );

  if (history.commitShas.length > 100)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Proposal history exceeds 100 generated commits; explicit recovery is required.",
    );

  const deadline = Date.now() + 300_000;
  const previousShas = history.commitShas.filter((sha) => sha !== headSha);
  let snapshotBytes = 0;
  let completedHead: string | undefined;

  // The caller has already checked the current head; replay each older parent.
  for (const commitSha of previousShas) {
    requireAuditTime(deadline);
    const head = await readLocalProposalTree(repository, commitSha);
    const marker = capturedIdentity(head.message);
    const files = await readProposalContents(repository, head, config.selfUpgrade === true);
    const snapshotJSON = requirePriorSnapshot(files, snapshotBytes);
    snapshotBytes += Buffer.byteLength(snapshotJSON, "utf8");

    const prior = await replayPriorProposal(repository, config, botUserId, marker, snapshotJSON);
    const capturedBaseline = prior.snapshot.input.range.baseline;
    if (
      prior.historicalBumps ||
      JSON.stringify(capturedBaseline) !== JSON.stringify(expectedBaseline)
    ) {
      completedHead ??= await findCompletedHead(
        repository,
        expectedBaseline,
        previousShas,
        deadline,
      );
      await inspectPendingRelease(repository, { kind: "bootstrap", commitSha }, completedHead);
    }

    await verifyHistoryRange(repository, prior, sourceSha);
    if (commitSha === completedHead) verifyCompletedVersion(prior, expectedBaseline);
    verifyHistoryOutputs(prior, head, files);
  }

  requireAuditTime(deadline);
  return history.commitShas;
}
