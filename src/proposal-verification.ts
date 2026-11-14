import { describe, capturedIdentity, verifyGeneratedTree } from "./proposal-identity.ts";
import type { Description } from "./proposal-identity.ts";
import { ProposalConflictError } from "./github-proposals.ts";
import type {
  GitHubProposalRepository,
  ProposalPullRequest,
  ProposalTree,
} from "./github-proposals.ts";
import { prepareReleaseFileContents } from "./proposal-files.ts";
import { replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export interface VerifiedProposal extends Description {
  readonly source: ProposalTree;
  readonly head: ProposalTree;
  readonly nextVersion: string;
}

export async function verifyPrevious(
  api: GitHubProposalRepository,
  pull: ProposalPullRequest,
  expected: ReleaseInputConfiguration,
  botUserId: number,
): Promise<VerifiedProposal> {
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
  const nextVersion = prepared.plan.nextVersion;
  if (nextVersion === null)
    throw new ProposalConflictError("The verified proposal no longer has a release version.");
  return { ...description, source, head, nextVersion };
}
