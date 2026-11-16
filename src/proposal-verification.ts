import { isDeepStrictEqual } from "node:util";
import { reconstructProposal } from "./producer-runtime.ts";
import { capturedIdentity, verifyGeneratedTree } from "./proposal-identity.ts";
import type { Description } from "./proposal-identity.ts";
import { ProposalConflictError, proposalObject } from "./github-proposals.ts";
import type {
  GitHubProposalRepository,
  ProposalPullRequest,
  ProposalTree,
} from "./github-proposals.ts";
import { parseReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration, ReleaseSnapshot } from "./release-snapshot.ts";

export interface VerifiedProposal extends Description {
  readonly source: ProposalTree;
  readonly head: ProposalTree;
  readonly nextVersion: string;
  readonly snapshot: ReleaseSnapshot;
  readonly changelog: string;
}

function withoutTransitionOptions(config: ReleaseInputConfiguration) {
  const { selfUpgrade: _selfUpgrade, githubRelease: _githubRelease, ...rest } = config;
  return { ...rest, changelog: { verbosity: config.changelog?.verbosity ?? "detailed" } };
}

export function capturedVerificationConfiguration(
  serialized: string,
  expected: ReleaseInputConfiguration,
): ReleaseInputConfiguration {
  const current = parseReleaseInputConfiguration(expected);
  if (current.changelog?.format === undefined && !current.selfUpgrade && !current.githubRelease)
    return current;

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ProposalConflictError("The proposal snapshot is not valid JSON.");
  }
  const captured = parseReleaseInputConfiguration(proposalObject(value).configuration);
  if (
    (captured.selfUpgrade && !current.selfUpgrade) ||
    (captured.githubRelease && !current.githubRelease)
  )
    return current;
  // Trusted output/presentation opt-ins retain the original proposal rules.
  // Membership and normalization policies must still match.
  return isDeepStrictEqual(withoutTransitionOptions(captured), withoutTransitionOptions(current))
    ? captured
    : current;
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
  const capturedConfiguration = capturedVerificationConfiguration(capturedJSON, expected);
  const source = await api.tree(marker.sourceSha);
  const { snapshot, prepared, description } = await reconstructProposal(
    capturedJSON,
    capturedConfiguration,
    marker.version,
    await api.contents(source),
    botUserId,
    marker.previousHeadSha,
    marker.producerSha,
  );
  if (snapshot.normalized.sourceCommitSha !== marker.sourceSha)
    throw new ProposalConflictError(
      "The proposal snapshot source differs from its commit identity.",
    );
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
  const changelog = prepared.files.find((file) => file.path === "CHANGELOG.md")?.after;
  if (changelog === undefined)
    throw new ProposalConflictError("The verified proposal has no generated changelog.");
  return { ...description, source, head, nextVersion, snapshot, changelog };
}
