import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { invalid, limit } from "../evidence/schema.ts";
import type { GitCommitEvidence } from "../git.ts";
import type { AssociatedPullRequest, StackBase } from "./association.ts";
import { isFirstParentLanding, stackedFootprint, stackedLandingOwners } from "./stacked-landing.ts";
import { canonical } from "./canonical.ts";
import type { ReleaseSnapshot } from "./model.ts";

export function validateCommitGraph(
  input: Pick<ReleaseSnapshot["input"], "range" | "pullRequests" | "bootstrapCommits"> & {
    verifiedAutomation: ReleaseSnapshot["input"]["verifiedAutomation"];
  },
  config: ReleaseInputConfiguration,
): void {
  const { range, pullRequests, bootstrapCommits, verifiedAutomation } = input;
  const graph = new Map<string, GitCommitEvidence>();
  const parentsByCommit = new Map<string, readonly string[]>();
  const stacks = new Map<string, (AssociatedPullRequest & { stackBase: StackBase })[]>();
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
    const proof = verifiedAutomation?.find((entry) => entry.pullNumber === pull.number);

    const candidate = config.candidateLandings?.find((pin) => pin.pullNumber === pull.number);
    if (candidate) {
      if (
        pull.authorType !== "Bot" ||
        pull.authorId !== candidate.botUserId ||
        pull.headRepositoryId !== config.repositoryId ||
        pull.headRef !== `release-log/${config.releaseBranch}` ||
        pull.headSha !== candidate.headSha ||
        pull.mergeCommitSha !== candidate.landingSha ||
        pull.stackBase ||
        (pull.landingKind === "linear" && pull.landedCommits.length !== 1)
      )
        return invalid("Candidate automation does not match its verified landing identity.");
    } else if (proof) {
      if (
        pull.authorType !== "Bot" ||
        pull.authorId !== proof.pull.botUserId ||
        pull.headRepositoryId !== config.repositoryId ||
        pull.headRef !== `release-log/${config.releaseBranch}` ||
        pull.headSha !== proof.headSha ||
        pull.mergeCommitSha !== proof.landingSha ||
        pull.title !== proof.pull.title ||
        pull.body !== proof.pull.body ||
        canonical(pull.landedCommits.map((entry) => entry.sha).toSorted()) !==
          canonical(proof.automationCommitShas)
      )
        return invalid(
          "Captured automation PR identity, metadata or complete footprint differs from verified authority.",
        );
    } else if (
      pull.authorType === "Bot" &&
      pull.headRepositoryId === config.repositoryId &&
      pull.headRef === `release-log/${config.releaseBranch}`
    )
      return invalid("Unverified release automation cannot enter a usable snapshot.");
    if (pull.stackBase) {
      if (pull.landingKind !== "merge" || proof)
        return invalid(
          `PR #${pull.number} shared landing ${pull.mergeCommitSha} requires ordinary merge evidence.`,
        );
      const members = stacks.get(pull.mergeCommitSha) ?? [];
      members.push({ ...pull, stackBase: pull.stackBase });
      stacks.set(pull.mergeCommitSha, members);
    } else {
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

  for (const pin of config.candidateLandings ?? []) {
    if (!pullRequests.some((pull) => pull.number === pin.pullNumber))
      return invalid("A verified candidate landing is missing from the captured range.");
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

  for (const [sha, members] of stacks) {
    const landing = graph.get(sha);
    const fail = (message: string): never =>
      invalid(
        `PRs ${members.map((pull) => `#${pull.number}`).join(", ")} shared landing ${sha}: ${message}.`,
      );
    if (!landing || !isFirstParentLanding(range.sourceCommitSha, sha, graph))
      return fail("landing is missing from the captured release branch's first-parent history");
    const owners = stackedLandingOwners(
      landing,
      config.releaseBranch,
      members,
      stackedFootprint(landing, graph),
      fail,
    );
    const count = members.reduce((total, pull) => total + pull.landedCommits.length, 0);
    if (count !== owners.size) return fail("recorded PRs do not own the complete Git footprint");
    for (const pull of members) {
      if (pull.landedCommits.some(({ sha: commit }) => owners.get(commit) !== pull.number))
        return fail(`PR #${pull.number} has incorrect landed commit ownership`);
    }
  }
}

export function onboardingCommits(
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
