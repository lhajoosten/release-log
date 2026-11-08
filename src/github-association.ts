import { inspectCommit, inspectPendingRelease } from "./git.ts";
import type { GitCommitEvidence, PendingReleaseInspection } from "./git.ts";
import { GitHubReadError, readGitHubJson } from "./github.ts";
import type { GitHubRead } from "./github.ts";

export type AssociationErrorCode =
  | "invalid-input"
  | "invalid-response"
  | "collection-limit"
  | "github-read-failed"
  | "unassociated-commit"
  | "ambiguous-association"
  | "partial-membership"
  | "incomplete-evidence"
  | "metadata-changed"
  | "automation-unverified";

export class PullRequestAssociationError extends Error {
  readonly code: AssociationErrorCode;
  constructor(code: AssociationErrorCode, message: string) {
    super(message);
    this.name = "PullRequestAssociationError";
    this.code = code;
  }
}

export interface PullRequestCommitEvidence {
  readonly sha: string;
  readonly message: string;
  readonly parentShas: readonly string[];
}

interface CapturedPullRequest {
  readonly number: number;
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly mergedAt: string;
  readonly mergeCommitSha: string;
  readonly commitCount: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepositoryId: number | null;
  readonly baseRepositoryId: number;
  readonly authorId: number;
  readonly authorType: string;
}

export interface AssociatedPullRequest extends CapturedPullRequest {
  readonly url: string;
  readonly landingKind: "merge" | "linear";
  readonly originalCommits: readonly PullRequestCommitEvidence[];
  readonly landedCommits: readonly GitCommitEvidence[];
}

export interface PullRequestAssociation {
  readonly repository: string;
  readonly releaseBranch: string;
  readonly range: PendingReleaseInspection;
  readonly pullRequests: readonly AssociatedPullRequest[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
  );
}

function invalid(message: string): never {
  throw new PullRequestAssociationError("invalid-response", message);
}

function summary(value: unknown): {
  number: number;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  repository: string;
  branch: string;
} {
  if (
    !record(value) ||
    !integer(value.number) ||
    (value.state !== "open" && value.state !== "closed") ||
    !(value.merged_at === null || typeof value.merged_at === "string") ||
    !(value.merge_commit_sha === null || isSha(value.merge_commit_sha)) ||
    !record(value.base) ||
    typeof value.base.ref !== "string" ||
    !record(value.base.repo) ||
    typeof value.base.repo.full_name !== "string"
  ) {
    return invalid(
      "GitHub returned incomplete PR association evidence; collection cannot omit malformed entries.",
    );
  }
  return {
    number: value.number,
    mergedAt: value.state === "closed" ? value.merged_at : null,
    mergeCommitSha: value.merge_commit_sha,
    repository: value.base.repo.full_name,
    branch: value.base.ref,
  };
}

function capturePull(
  value: unknown,
  repository: string,
  branch: string,
  number: number,
): CapturedPullRequest {
  const item = summary(value);
  if (
    !record(value) ||
    item.number !== number ||
    item.repository.toLowerCase() !== repository.toLowerCase() ||
    item.branch !== branch ||
    !item.mergedAt ||
    !item.mergeCommitSha ||
    value.merged !== true ||
    !integer(value.id) ||
    typeof value.title !== "string" ||
    !(value.body === null || typeof value.body === "string") ||
    typeof value.updated_at !== "string" ||
    !integer(value.commits) ||
    !record(value.head) ||
    !isSha(value.head.sha) ||
    typeof value.head.ref !== "string" ||
    !record(value.base) ||
    !record(value.base.repo) ||
    !integer(value.base.repo.id) ||
    !record(value.user) ||
    !integer(value.user.id) ||
    typeof value.user.type !== "string"
  ) {
    return invalid(
      "GitHub did not return consistent merged-PR identity, metadata, or landing evidence.",
    );
  }
  let headRepositoryId: number | null = null;
  if (value.head.repo !== null) {
    const headRepository = value.head.repo;
    if (!record(headRepository) || !integer(headRepository.id))
      return invalid("GitHub returned invalid PR head repository identity.");
    headRepositoryId = headRepository.id;
  }
  if (value.commits > 250)
    throw new PullRequestAssociationError(
      "collection-limit",
      `PR #${number} exceeds the 250-commit PR endpoint limit; collect complete evidence with a separately supported adapter before planning.`,
    );
  return {
    number,
    id: value.id,
    title: value.title,
    body: value.body ?? "",
    updatedAt: value.updated_at,
    mergedAt: item.mergedAt,
    mergeCommitSha: item.mergeCommitSha,
    commitCount: value.commits,
    headSha: value.head.sha,
    headRef: value.head.ref,
    headRepositoryId,
    baseRepositoryId: value.base.repo.id,
    authorId: value.user.id,
    authorType: value.user.type,
  };
}

function captureCommit(value: unknown): PullRequestCommitEvidence {
  if (
    !record(value) ||
    !isSha(value.sha) ||
    !record(value.commit) ||
    typeof value.commit.message !== "string" ||
    !Array.isArray(value.parents) ||
    !value.parents.every((parent: unknown) => record(parent) && isSha(parent.sha))
  ) {
    return invalid("GitHub returned incomplete original PR commit evidence.");
  }
  return {
    sha: value.sha,
    message: value.commit.message,
    parentShas: value.parents.map((parent: { sha: string }) => parent.sha),
  };
}

export async function collectMergedPullRequests(
  request: {
    readonly repository: string;
    readonly releaseBranch: string;
    readonly localRepository: string;
    readonly range: PendingReleaseInspection;
    readonly token: string;
  },
  read: GitHubRead = fetch,
): Promise<PullRequestAssociation> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/u.test(request.repository) ||
    request.repository.trim() !== request.repository ||
    [".", ".."].includes(request.repository.split("/")[1] ?? "") ||
    !request.releaseBranch.trim() ||
    /[\0\r\n]/u.test(request.releaseBranch) ||
    !request.token.trim() ||
    !request.range.baselineIsAncestor
  ) {
    throw new PullRequestAssociationError(
      "invalid-input",
      "Supply a repository identity, release branch, read-only token, and a captured ancestral Git range.",
    );
  }
  const verified = await inspectPendingRelease(
    request.localRepository,
    { kind: "bootstrap", commitSha: request.range.baseline.commitSha },
    request.range.sourceCommitSha,
  );
  if (JSON.stringify(verified.commitShas) !== JSON.stringify(request.range.commitShas.toSorted())) {
    throw new PullRequestAssociationError(
      "invalid-input",
      "The supplied commit set does not match the captured local range; inspect it again before collection.",
    );
  }
  if (verified.commitShas.length > 1000)
    throw new PullRequestAssociationError(
      "collection-limit",
      "Collection supports at most 1000 range commits; use an explicitly reviewed baseline rather than silently truncating history.",
    );
  const inRange = new Set(verified.commitShas);
  const apiBase = `https://api.github.com/repos/${request.repository.split("/").map(encodeURIComponent).join("/")}`;
  const signal = AbortSignal.timeout(300_000);
  const deadline = Date.now() + 300_000;
  let requests = 0;
  async function get(path: string) {
    if (++requests > 2000 || Date.now() >= deadline)
      throw new PullRequestAssociationError(
        "collection-limit",
        "Collection exceeded its 2000-request or five-minute budget; no partial association is usable.",
      );
    try {
      return await readGitHubJson(`${apiBase}${path}`, request.token, read, signal);
    } catch (error) {
      if (error instanceof GitHubReadError)
        throw new PullRequestAssociationError("github-read-failed", error.message);
      throw error;
    }
  }
  const pulls = new Map<number, CapturedPullRequest>();
  const associations = new Map<string, readonly number[]>();
  const commits = new Map<string, GitCommitEvidence>();
  async function local(sha: string): Promise<GitCommitEvidence> {
    const cached = commits.get(sha);
    if (cached) return cached;
    const result = await inspectCommit(request.localRepository, sha);
    commits.set(sha, result);
    return result;
  }
  async function candidates(commitSha: string): Promise<readonly number[]> {
    const cached = associations.get(commitSha);
    if (cached) return cached;
    const found = new Set<number>();
    const seen = new Set<number>();
    for (let page = 1; ; page += 1) {
      const response = await get(`/commits/${commitSha}/pulls?per_page=100&page=${page}`);
      if (
        !Array.isArray(response.data) ||
        response.data.length > 100 ||
        (response.next && response.data.length !== 100)
      )
        invalid("GitHub PR association pagination is inconsistent.");
      for (const value of response.data) {
        const item = summary(value);
        if (seen.has(item.number))
          invalid("GitHub repeated a PR within paginated commit associations.");
        seen.add(item.number);
        if (
          !item.mergedAt ||
          !item.mergeCommitSha ||
          item.repository.toLowerCase() !== request.repository.toLowerCase() ||
          item.branch !== request.releaseBranch ||
          !inRange.has(item.mergeCommitSha)
        )
          continue;
        let pull = pulls.get(item.number);
        if (!pull) {
          pull = capturePull(
            (await get(`/pulls/${item.number}`)).data,
            request.repository,
            request.releaseBranch,
            item.number,
          );
          pulls.set(item.number, pull);
        }
        if (pull.mergeCommitSha !== item.mergeCommitSha)
          throw new PullRequestAssociationError(
            "metadata-changed",
            `PR #${item.number} landing evidence changed during collection; retry explicitly.`,
          );
        if (
          pull.authorType === "Bot" &&
          pull.headRepositoryId === pull.baseRepositoryId &&
          pull.headRef === `release-log/${request.releaseBranch}`
        ) {
          throw new PullRequestAssociationError(
            "automation-unverified",
            `PR #${pull.number} claims the release automation branch. Snapshot/diff identity verification is not available in this collector; do not exclude it by bot name or title.`,
          );
        }
        found.add(item.number);
      }
      if (!response.next) break;
      if (page === 10)
        throw new PullRequestAssociationError(
          "collection-limit",
          "Commit association pagination exceeds ten pages; no partial association is usable.",
        );
    }
    const result = [...found].toSorted((a, b) => a - b);
    if (result.length > 1)
      throw new PullRequestAssociationError(
        "ambiguous-association",
        `Commit ${commitSha} has multiple qualifying merged PRs: ${result.join(", ")}. Resolve the association before planning.`,
      );
    associations.set(commitSha, result);
    return result;
  }
  for (const commitSha of verified.commitShas) await candidates(commitSha);

  async function originalCommits(
    pull: CapturedPullRequest,
  ): Promise<readonly PullRequestCommitEvidence[]> {
    const result: PullRequestCommitEvidence[] = [];
    const seen = new Set<string>();
    for (let page = 1; result.length < pull.commitCount; page += 1) {
      const response = await get(`/pulls/${pull.number}/commits?per_page=100&page=${page}`);
      if (
        !Array.isArray(response.data) ||
        response.data.length !== Math.min(100, pull.commitCount - result.length)
      )
        invalid(`PR #${pull.number} commit pagination is incomplete.`);
      for (const value of response.data) {
        const commit = captureCommit(value);
        if (seen.has(commit.sha))
          invalid(`PR #${pull.number} has duplicate original commit evidence.`);
        seen.add(commit.sha);
        result.push(commit);
      }
      if (response.next !== result.length < pull.commitCount)
        invalid(`PR #${pull.number} commit pagination disagrees with its captured count.`);
    }
    if (result.at(-1)?.sha !== pull.headSha)
      throw new PullRequestAssociationError(
        "incomplete-evidence",
        `PR #${pull.number} original commit evidence does not end at its captured head.`,
      );
    return result;
  }

  const result: AssociatedPullRequest[] = [];
  const owners = new Map<string, number>();
  for (const pull of [...pulls.values()].toSorted((a, b) => a.number - b.number)) {
    const original = await originalCommits(pull);
    const landing = await local(pull.mergeCommitSha);
    let landed: readonly GitCommitEvidence[];
    let landingKind: "merge" | "linear";
    if (landing.parentShas.length === 2) {
      const [parent, head] = landing.parentShas;
      if (!parent || head !== pull.headSha)
        throw new PullRequestAssociationError(
          "incomplete-evidence",
          `PR #${pull.number} merge parents do not match its captured head.`,
        );
      const footprint = await inspectPendingRelease(
        request.localRepository,
        { kind: "bootstrap", commitSha: parent },
        landing.sha,
      );
      const evidence: GitCommitEvidence[] = [];
      for (const commitSha of footprint.commitShas) evidence.push(await local(commitSha));
      landed = evidence;
      const introduced = footprint.commitShas.filter((sha) => sha !== landing.sha).toSorted();
      if (
        JSON.stringify(introduced) !==
        JSON.stringify(original.map((commit) => commit.sha).toSorted())
      )
        throw new PullRequestAssociationError(
          "incomplete-evidence",
          `PR #${pull.number} original commits do not account for the complete merge footprint.`,
        );
      landingKind = "merge";
    } else if (landing.parentShas.length === 1) {
      const chain: GitCommitEvidence[] = [];
      let current = landing;
      for (;;) {
        if (current.parentShas.length !== 1 || chain.length === 250)
          throw new PullRequestAssociationError(
            "incomplete-evidence",
            `PR #${pull.number} has an unsupported or incomplete linear landing sequence.`,
          );
        chain.push(current);
        const parent = current.parentShas[0];
        if (!parent || !(await candidates(parent)).includes(pull.number)) break;
        current = await local(parent);
      }
      if (chain.length !== 1 && chain.length !== original.length)
        throw new PullRequestAssociationError(
          "incomplete-evidence",
          `PR #${pull.number} rewritten landing sequence does not account for its original commit count.`,
        );
      landed = chain.toSorted((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
      landingKind = "linear";
    } else {
      throw new PullRequestAssociationError(
        "incomplete-evidence",
        `PR #${pull.number} has an unsupported landing parent structure.`,
      );
    }
    for (const commit of landed) {
      if (!inRange.has(commit.sha))
        throw new PullRequestAssociationError(
          "partial-membership",
          `PR #${pull.number} crosses the captured baseline at commit ${commit.sha}; select a complete PR boundary.`,
        );
      if (owners.has(commit.sha))
        throw new PullRequestAssociationError(
          "ambiguous-association",
          `Commit ${commit.sha} belongs to overlapping PR landing footprints.`,
        );
      const linked = await candidates(commit.sha);
      if (
        (linked.length === 0 && commit.parentShas.length < 2) ||
        (linked.length > 0 && !linked.includes(pull.number))
      )
        throw new PullRequestAssociationError(
          "incomplete-evidence",
          `PR #${pull.number} lacks unique association evidence for introduced commit ${commit.sha}.`,
        );
      owners.set(commit.sha, pull.number);
    }
    result.push({
      ...pull,
      url: `https://github.com/${request.repository}/pull/${pull.number}`,
      landingKind,
      originalCommits: original,
      landedCommits: landed,
    });
  }
  if (result.length !== pulls.size)
    throw new PullRequestAssociationError(
      "incomplete-evidence",
      "Landing boundary discovery introduced additional PR candidates; resolve the overlapping evidence before planning.",
    );
  for (const commitSha of verified.commitShas) {
    if (!owners.has(commitSha))
      throw new PullRequestAssociationError(
        "unassociated-commit",
        `Commit ${commitSha} has no verified merged-PR landing footprint. Direct commits and missing associations must be resolved before planning.`,
      );
  }
  for (const pull of pulls.values()) {
    const final = capturePull(
      (await get(`/pulls/${pull.number}`)).data,
      request.repository,
      request.releaseBranch,
      pull.number,
    );
    if (JSON.stringify(final) !== JSON.stringify(pull))
      throw new PullRequestAssociationError(
        "metadata-changed",
        `PR #${pull.number} metadata changed during collection; retry explicitly rather than mixing snapshots.`,
      );
  }
  return {
    repository: request.repository,
    releaseBranch: request.releaseBranch,
    range: request.range,
    pullRequests: result,
  };
}
