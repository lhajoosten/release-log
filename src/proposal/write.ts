import { ProposalConflictError } from "../github-proposals.ts";
import type {
  GitHubProposalRepository,
  ProposalPullRequest,
  ProposalTree,
} from "../github-proposals.ts";
import { verifyToolUpgradeCandidate } from "../tool-upgrade.ts";
import { verifyGeneratedTree } from "./identity.ts";
import type { Description } from "./identity.ts";
import type { PreparedRelease } from "./prepare.ts";

function samePull(left: ProposalPullRequest, right: ProposalPullRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface WriteInput {
  readonly api: GitHubProposalRepository;
  readonly selfUpgrade: boolean | undefined;
  readonly requireFresh: () => Promise<void>;
  readonly initialHead: string | null;
  readonly completed: ProposalPullRequest | null;
  readonly previous: ProposalPullRequest | null;
  readonly source: ProposalTree;
  readonly historyHead: string | null;
  readonly prepared: PreparedRelease;
  readonly description: Description;
}

export async function writeProposal({
  api,
  selfUpgrade,
  requireFresh,
  initialHead,
  completed,
  previous,
  source,
  historyHead,
  prepared,
  description,
}: WriteInput): Promise<{ pullNumber: number; headSha: string }> {
  const sourceSha = source.commitSha;
  const unchanged = async () => {
    await requireFresh();
    if (selfUpgrade) await verifyToolUpgradeCandidate(api, sourceSha);
    if ((await api.ref("heads", api.headRef, true)) !== initialHead)
      throw new ProposalConflictError(
        "The proposal head changed during reconciliation; retry from freshly verified state.",
      );
    if (completed && !samePull(completed, await api.readPull(completed.number)))
      throw new ProposalConflictError(
        "The completed release changed during reconciliation; retry from fresh state.",
      );
    if (previous && !samePull(previous, await api.readPull(previous.number)))
      throw new ProposalConflictError(
        "PR metadata changed during reconciliation; preserve human edits and recover manually.",
      );
  };
  await unchanged();
  const head = await api.commit(source, historyHead, prepared.files, description.message);
  const generated = await api.tree(head);
  const expectedParents =
    historyHead && historyHead !== sourceSha ? [sourceSha, historyHead] : [sourceSha];
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
  return { pullNumber: pull.number, headSha: head };
}
