import type { GitCommitEvidence } from "../git.ts";
import type { AssociatedPullRequest, StackBase } from "./association.ts";

type StackPull = Pick<
  AssociatedPullRequest,
  "number" | "headRef" | "headSha" | "headRepositoryId" | "baseRepositoryId" | "originalCommits"
> & { readonly stackBase: StackBase };

function ancestors(start: string, graph: ReadonlyMap<string, GitCommitEvidence>): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const sha = pending.pop();
    if (sha === undefined || seen.has(sha)) continue;
    seen.add(sha);
    const commit = graph.get(sha);
    if (commit) pending.push(...commit.parentShas);
  }
  return seen;
}

function isLinearSequence(
  commits: readonly { readonly sha: string; readonly parentShas: readonly string[] }[],
  base: string,
  head: string,
): boolean {
  let parent = base;
  for (const commit of commits) {
    if (commit.parentShas.length !== 1 || commit.parentShas[0] !== parent) return false;
    parent = commit.sha;
  }
  return parent === head;
}

function hasTerminalBaseSync(
  pull: AssociatedPullRequest,
  preceding: AssociatedPullRequest,
  baseSha: string,
): boolean {
  const precedingBySha = new Map(preceding.originalCommits.map((commit) => [commit.sha, commit]));
  if (!precedingBySha.has(preceding.headSha)) return false;
  const priorHistory = ancestors(preceding.headSha, precedingBySha);
  const terminal = pull.originalCommits.at(-1);
  const prefix = pull.originalCommits.slice(0, -1);
  const fork = prefix[0]?.parentShas[0];
  const finalPrefixCommit = prefix.at(-1);
  return (
    terminal?.sha === pull.headSha &&
    terminal.parentShas.length === 2 &&
    terminal.parentShas[0] === finalPrefixCommit?.sha &&
    terminal.parentShas[1] === baseSha &&
    prefix.length > 0 &&
    Boolean(fork) &&
    precedingBySha.has(fork ?? "") &&
    priorHistory.has(fork ?? "") &&
    isLinearSequence(prefix, fork ?? "", finalPrefixCommit?.sha ?? "") &&
    !pull.originalCommits.some((commit) => priorHistory.has(commit.sha))
  );
}

export function stackedFootprint(
  landing: GitCommitEvidence,
  graph: ReadonlyMap<string, GitCommitEvidence>,
): ReadonlyMap<string, GitCommitEvidence> {
  const [parent, head] = landing.parentShas;
  const footprint = new Map([[landing.sha, landing]]);
  if (parent && head) {
    const prior = ancestors(parent, graph);
    for (const sha of ancestors(head, graph)) {
      const commit = graph.get(sha);
      if (commit && !prior.has(sha)) footprint.set(sha, commit);
    }
  }
  return footprint;
}

export function isFirstParentLanding(
  source: string,
  landing: string,
  graph: ReadonlyMap<string, GitCommitEvidence>,
): boolean {
  let sha: string | undefined = source;
  const seen = new Set<string>();
  while (sha && !seen.has(sha)) {
    if (sha === landing) return true;
    seen.add(sha);
    sha = graph.get(sha)?.parentShas[0];
  }
  return false;
}

export function validateSquashStackMember(
  pull: AssociatedPullRequest,
  preceding: AssociatedPullRequest,
  releaseBranch: string,
  fail: (message: string) => never,
): void {
  const evidence = pull.squashStack;
  const [landing] = pull.landedCommits;
  const [parent] = preceding.landedCommits;
  if (
    !evidence ||
    pull.stackBase ||
    preceding.stackBase ||
    pull.landingKind !== "linear" ||
    preceding.landingKind !== "linear" ||
    pull.landedCommits.length !== 1 ||
    preceding.landedCommits.length !== 1 ||
    landing?.sha !== pull.mergeCommitSha ||
    parent?.sha !== preceding.mergeCommitSha ||
    landing.parentShas.length !== 1 ||
    parent.parentShas.length !== 1 ||
    landing.parentShas[0] !== parent.sha ||
    pull.headRepositoryId !== pull.baseRepositoryId ||
    preceding.headRepositoryId !== pull.baseRepositoryId ||
    preceding.baseRepositoryId !== pull.baseRepositoryId ||
    evidence.base.ref !== preceding.headRef ||
    evidence.base.ref === releaseBranch ||
    evidence.base.sha !== preceding.headSha ||
    pull.headRef === evidence.base.ref ||
    pull.headRef === releaseBranch
  )
    return fail("requires consecutive same-repository landings and a matching previous PR head");

  const originalIds = new Set(pull.originalCommits.map((commit) => commit.sha));
  if (originalIds.size !== pull.originalCommits.length)
    return fail("the original PR commit list contains duplicate commits");
  if (originalIds.has(evidence.base.sha))
    return fail("the original PR commit list includes its captured stack base");
  if (pull.originalCommits.length !== pull.commitCount)
    return fail("the original PR sequence does not account for the captured head and commit count");

  const linearFromBase = isLinearSequence(pull.originalCommits, evidence.base.sha, pull.headSha);
  if (!linearFromBase && !hasTerminalBaseSync(pull, preceding, evidence.base.sha))
    return fail(
      "the original PR commits must be a complete linear sequence or end in an exact stack-base sync merge",
    );

  const trees = [
    evidence.originalBaseTree,
    evidence.originalHeadTree,
    evidence.landedBaseTree,
    evidence.landedHeadTree,
  ];
  if (trees.some((tree) => tree.length !== landing.sha.length))
    return fail("tree IDs mix Git object formats");
  if (
    evidence.originalBaseTree !== evidence.landedBaseTree ||
    evidence.originalHeadTree !== evidence.landedHeadTree ||
    (preceding.squashStack && preceding.squashStack.landedHeadTree !== evidence.landedBaseTree)
  )
    return fail("the original base and head trees must match the consecutive landed trees");
}

// The same graph rules assign live ownership and verify the assignment on replay.
export function stackedLandingOwners(
  landing: GitCommitEvidence,
  releaseBranch: string,
  pulls: readonly StackPull[],
  footprint: ReadonlyMap<string, GitCommitEvidence>,
  fail: (message: string) => never,
): ReadonlyMap<string, number> {
  const [firstParent, finalHead] = landing.parentShas;
  const root = pulls.find((pull) => pull.stackBase.ref === releaseBranch);
  if (landing.parentShas.length !== 2 || !firstParent || !finalHead || !root || pulls.length < 2)
    return fail("requires a release-branch PR and a two-parent landing with a complete stack");

  const byBase = new Map<string, StackPull>();
  const headRefs = new Set<string>();
  for (const pull of pulls) {
    const { ref } = pull.stackBase;
    if (
      pull.baseRepositoryId !== root.baseRepositoryId ||
      pull.headRepositoryId !== root.baseRepositoryId ||
      byBase.has(ref) ||
      headRefs.has(pull.headRef) ||
      pull.headRef === releaseBranch
    )
      return fail(`PR #${pull.number} has competing branch or repository evidence`);
    byBase.set(ref, pull);
    headRefs.add(pull.headRef);
  }

  const owners = new Map([[landing.sha, root.number]]);
  let base = { ref: releaseBranch, sha: firstParent };
  const visited = new Set<number>();
  while (base.sha !== finalHead) {
    const pull = byBase.get(base.ref);
    if (!pull || visited.has(pull.number))
      return fail("branches do not form a single chain to the landing head");
    if (
      pull.stackBase.sha !== base.sha ||
      !footprint.has(pull.headSha) ||
      pull.headSha === landing.sha
    )
      return fail(`PR #${pull.number} base/head does not match the landing history`);
    visited.add(pull.number);

    const headHistory = ancestors(pull.headSha, footprint);
    const baseHistory = ancestors(base.sha, footprint);
    if (pull !== root && !headHistory.has(base.sha))
      return fail(`PR #${pull.number} head does not descend from its stack base`);

    const introduced = new Set(
      [...headHistory].filter((sha) => footprint.has(sha) && !baseHistory.has(sha)),
    );
    for (const original of pull.originalCommits) {
      const local = footprint.get(original.sha);
      if (owners.has(original.sha))
        return fail(`PR #${pull.number} makes a competing claim for commit ${original.sha}`);
      if (!local || !introduced.delete(original.sha))
        return fail(`PR #${pull.number} claims commit ${original.sha} outside its Git footprint`);
      if (
        original.message.trimEnd() !== local.message.trimEnd() ||
        JSON.stringify(original.parentShas) !== JSON.stringify(local.parentShas)
      )
        return fail(
          `PR #${pull.number} has contradictory GitHub evidence for commit ${original.sha}`,
        );
      owners.set(original.sha, pull.number);
    }
    if (introduced.size > 0)
      return fail(
        `PR #${pull.number} commit list omits Git footprint commit ${introduced.values().next().value}`,
      );
    base = { ref: pull.headRef, sha: pull.headSha };
  }
  if (visited.size !== pulls.length) return fail("contains a PR outside the verified branch chain");
  if (owners.size !== footprint.size)
    return fail("commit lists do not cover the complete landing footprint");
  return owners;
}
