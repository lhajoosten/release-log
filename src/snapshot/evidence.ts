import type {
  GitCommitEvidence,
  PendingReleaseInspection,
  ResolvedReleaseBaseline,
} from "../git.ts";
import { parseVerifiedReleaseApproval } from "../approval/record.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import {
  ReleaseSnapshotError,
  array,
  invalid,
  isObject,
  object,
  positive,
  sha,
  text,
  unique,
} from "../evidence/schema.ts";
import type { AssociatedPullRequest } from "./association.ts";
import { canonical } from "./canonical.ts";
import type { ReleaseSnapshot } from "./model.ts";
import { onboardingCommits, validateCommitGraph } from "./graph.ts";

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

function pullEvidence(value: unknown, presentation: boolean): AssociatedPullRequest {
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
      ...(presentation && isObject(value) && Object.hasOwn(value, "authorLogin")
        ? ["authorLogin"]
        : []),
      "url",
      "landingKind",
      ...(isObject(value) && Object.hasOwn(value, "stackBase") ? ["stackBase"] : []),
      ...(isObject(value) && Object.hasOwn(value, "squashStack") ? ["squashStack"] : []),
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
  const stackBase = Object.hasOwn(item, "stackBase")
    ? object(item.stackBase, ["ref", "sha"], "stack base")
    : undefined;
  const squashStack = Object.hasOwn(item, "squashStack")
    ? object(
        item.squashStack,
        ["base", "originalBaseTree", "originalHeadTree", "landedBaseTree", "landedHeadTree"],
        "stack squash evidence",
      )
    : undefined;
  const squashBase = squashStack && object(squashStack.base, ["ref", "sha"], "stack squash base");
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
    authorId: presentation && item.authorId === null ? null : positive(item.authorId, "author ID"),
    ...(Object.hasOwn(item, "authorLogin")
      ? {
          authorLogin:
            item.authorLogin === null ? null : text(item.authorLogin, "author login", 256),
        }
      : {}),
    authorType: text(item.authorType, "author type", 64),
    url: text(item.url, "PR URL", 1024),
    landingKind: item.landingKind,
    ...(stackBase
      ? { stackBase: { ref: text(stackBase.ref, "stack base ref", 1024), sha: sha(stackBase.sha) } }
      : {}),
    ...(squashStack && squashBase
      ? {
          squashStack: {
            base: {
              ref: text(squashBase.ref, "stack squash base ref", 1024),
              sha: sha(squashBase.sha),
            },
            originalBaseTree: sha(squashStack.originalBaseTree),
            originalHeadTree: sha(squashStack.originalHeadTree),
            landedBaseTree: sha(squashStack.landedBaseTree),
            landedHeadTree: sha(squashStack.landedHeadTree),
          },
        }
      : {}),
    originalCommits,
    landedCommits,
  };
}

export function association(
  value: unknown,
  config: ReleaseInputConfiguration,
  presentation = false,
): ReleaseSnapshot["input"] {
  const item = object(
    value,
    [
      "repository",
      "releaseBranch",
      "range",
      "pullRequests",
      ...(isObject(value) && Object.hasOwn(value, "bootstrapCommits") ? ["bootstrapCommits"] : []),
      ...(config.automationExclusions ? ["verifiedAutomation"] : []),
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
    .map((pull) => pullEvidence(pull, presentation))
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
  const verifiedAutomation = config.automationExclusions
    ? array(item.verifiedAutomation, 100, "captured automation verification evidence")
        .map(parseVerifiedReleaseApproval)
        .toSorted((left, right) => left.pullNumber - right.pullNumber)
    : undefined;

  if (verifiedAutomation) {
    unique(
      verifiedAutomation.map((proof) => proof.pullNumber),
      "verification evidence PR numbers",
    );

    if (
      canonical(
        verifiedAutomation.map((proof) => ({
          pullNumber: proof.pullNumber,
          verificationId: proof.verificationId,
        })),
      ) !== canonical(config.automationExclusions)
    )
      return invalid(
        "Captured exclusion evidence differs from independently trusted configuration pins.",
      );

    for (const proof of verifiedAutomation) {
      if (
        proof.repositoryId !== config.repositoryId ||
        proof.releaseBranch !== config.releaseBranch
      )
        return invalid(
          "Exclusion verification evidence belongs to a different repository or branch.",
        );

      const overlap = proof.automationCommitShas.filter((id) => range.commitShas.includes(id));

      if (overlap.length !== 0 && overlap.length !== proof.automationCommitShas.length)
        return invalid("The captured range splits a verified automation footprint.");
      if (overlap.length && !pullRequests.some((pull) => pull.number === proof.pullNumber))
        return invalid("Automation footprint evidence lacks its captured PR identity.");
    }
  }

  validateCommitGraph({ range, pullRequests, bootstrapCommits, verifiedAutomation }, config);
  const captured = {
    repository: config.repository,
    releaseBranch: config.releaseBranch,
    range,
    pullRequests,
    bootstrapCommits,
    ...(verifiedAutomation === undefined ? {} : { verifiedAutomation }),
  };
  const historical = onboardingCommits(captured, config);

  if (pullRequests.some((pull) => pull.squashStack && historical.has(pull.mergeCommitSha)))
    return invalid("Stack squash evidence cannot reattribute reviewed onboarding history.");

  if (
    config.schemaVersion === 2 &&
    range.baseline.kind === "bootstrap" &&
    bootstrapCommits.some((entry) => !historical.has(entry.sha))
  )
    return invalid("New changes after onboarding require verified merged-PR evidence.");

  return captured;
}
