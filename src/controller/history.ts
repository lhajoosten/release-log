import { inspectCommit, inspectPendingRelease, inspectRootBaseline } from "../git.ts";
import { collectMergedPullRequests } from "../github-association.ts";
import { readGitHubJson } from "../github.ts";
import type { GitHubRead } from "../github.ts";
import type { Change } from "../release/core.ts";

function action(body: string, number: number): string | null {
  const matches = [...body.matchAll(/^Required action:[ \t]*(.*)$/gimu)];
  if (matches.length > 1) throw new Error(`PR #${number} has multiple Required action lines.`);
  const value = matches[0]?.[1]?.trim();
  if (matches.length && !value) throw new Error(`PR #${number} has an empty Required action line.`);
  return value ?? null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("GitHub returned invalid root association evidence.");
  return Object.fromEntries(Object.entries(value));
}

async function rootChange(
  repository: string,
  branch: string,
  rootSha: string,
  token: string,
  read: GitHubRead,
): Promise<Change> {
  const prefix = `https://api.github.com/repos/${repository}`;
  const candidates: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await readGitHubJson(
      `${prefix}/commits/${rootSha}/pulls?per_page=100&page=${page}`,
      token,
      read,
    );
    if (!Array.isArray(response.data))
      throw new Error("GitHub returned invalid root associations.");
    for (const raw of response.data) {
      const item = object(raw);
      const base = object(item.base);
      const baseRepo = object(base.repo);
      if (
        item.state === "closed" &&
        typeof item.merged_at === "string" &&
        item.merge_commit_sha === rootSha &&
        base.ref === branch &&
        baseRepo.full_name === repository
      ) {
        if (
          typeof item.number !== "number" ||
          !Number.isSafeInteger(item.number) ||
          item.number <= 0 ||
          candidates.includes(item.number)
        )
          throw new Error(`Invalid or duplicate root association for ${rootSha}.`);
        candidates.push(item.number);
      }
    }
    if (!response.next) break;
    if (page === 10)
      throw new Error(`Root associations for ${rootSha} exceed the pagination limit.`);
  }
  if (candidates.length !== 1)
    throw new Error(
      `Root commit ${rootSha} has no unique verified PR landing; select a reviewed start or supply historical evidence.`,
    );
  const number = candidates[0];
  const url = `${prefix}/pulls/${number}`;
  const first = object((await readGitHubJson(url, token, read)).data);
  const base = object(first.base);
  const baseRepo = object(base.repo);
  const user = first.user === null ? null : object(first.user);
  if (
    first.number !== number ||
    first.state !== "closed" ||
    first.merged !== true ||
    typeof first.merged_at !== "string" ||
    first.merge_commit_sha !== rootSha ||
    base.ref !== branch ||
    baseRepo.full_name !== repository ||
    typeof first.title !== "string" ||
    !(first.body === null || typeof first.body === "string") ||
    typeof first.updated_at !== "string" ||
    (user !== null && typeof user.login !== "string")
  )
    throw new Error(`Root commit ${rootSha} has inconsistent PR evidence.`);
  const second = object((await readGitHubJson(url, token, read)).data);
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error(`PR #${number} changed during collection.`);
  return {
    number: number ?? 0,
    title: first.title,
    author: user === null ? null : String(user.login),
    requiredAction: action(first.body ?? "", number ?? 0),
  };
}

export type VerifyAutomation = (pull: Record<string, unknown>) => Promise<string>;

async function automationLandings(
  root: string,
  repository: string,
  branch: string,
  base: string,
  head: string,
  token: string,
  read: GitHubRead,
  verify?: VerifyAutomation,
): Promise<readonly { landing: string; parent: string }[]> {
  const result: { landing: string; parent: string }[] = [];
  let cursor = head;
  for (let count = 0; cursor !== base; count++) {
    if (count >= 1000) throw new Error("First-parent history exceeds the association limit.");
    const commit = await inspectCommit(root, cursor);
    const parent = commit.parentShas[0];
    if (!parent)
      throw new Error(`Baseline ${base} is not on the first-parent history at ${cursor}.`);
    const candidates: number[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await readGitHubJson(
        `https://api.github.com/repos/${repository}/commits/${cursor}/pulls?per_page=100&page=${page}`,
        token,
        read,
      );
      if (!Array.isArray(response.data)) throw new Error(`Invalid PR associations for ${cursor}.`);
      for (const raw of response.data) {
        const item = object(raw);
        if (
          item.state === "closed" &&
          typeof item.merged_at === "string" &&
          item.merge_commit_sha === cursor
        ) {
          if (
            typeof item.number !== "number" ||
            !Number.isSafeInteger(item.number) ||
            item.number <= 0 ||
            candidates.includes(item.number)
          )
            throw new Error(`Invalid or duplicate associations for ${cursor}.`);
          candidates.push(item.number);
        }
      }
      if (!response.next) break;
      if (page === 10) throw new Error(`Associations for ${cursor} exceed the pagination limit.`);
    }
    for (const number of candidates) {
      const pull = object(
        (
          await readGitHubJson(
            `https://api.github.com/repos/${repository}/pulls/${number}`,
            token,
            read,
          )
        ).data,
      );
      const headRef = object(pull.head).ref;
      if (
        headRef !== "release/next" &&
        headRef !== "release/changelog-backfill" &&
        headRef !== "release-log/main"
      )
        continue;
      const headRepository = object(pull.head).repo;
      if (headRepository === null || object(headRepository).full_name !== repository) continue;
      if (candidates.length !== 1 || !verify)
        throw new Error(
          `Release automation at ${cursor} requires independently verified landing evidence.`,
        );
      try {
        if (
          pull.number !== number ||
          object(pull.base).ref !== branch ||
          (await verify(pull)) !== cursor
        )
          throw new Error("landing differs from reviewed evidence");
      } catch (error) {
        throw new Error(
          `Release automation at ${cursor} failed landing verification: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      result.push({ landing: cursor, parent });
    }
    cursor = parent;
  }
  return result.toReversed();
}

/** Read a captured Git range using the strict GitHub association collector. */
export async function readChanges(
  root: string,
  repository: string,
  base: string | null,
  head: string,
  read: GitHubRead = fetch,
  verifyAutomation?: VerifyAutomation,
  membershipOnly = false,
): Promise<readonly Change[]> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/u.test(repository) ||
    [".", ".."].includes(repository.split("/")[1] ?? "")
  )
    throw new Error("Invalid GitHub repository identity.");
  const token = process.env.GITHUB_TOKEN;
  const releaseBranch = process.env.ROLLING_RELEASE_BRANCH ?? "main";
  if (!token) throw new Error("GITHUB_TOKEN is required to read PR associations.");
  if (base === null) {
    const rootSha = await inspectRootBaseline(root, head);
    await inspectCommit(root, rootSha);
    const first = await rootChange(repository, releaseBranch, rootSha, token, read);
    const remaining = await readChanges(
      root,
      repository,
      rootSha,
      head,
      read,
      verifyAutomation,
      membershipOnly,
    );
    if (remaining.some((change) => change.number === first.number))
      throw new Error(`Root PR #${first.number} also owns another landing.`);
    return [first, ...remaining].toSorted((a, b) => a.number - b.number);
  }
  const range = await inspectPendingRelease(root, { kind: "bootstrap", commitSha: base }, head);
  const verify =
    verifyAutomation ??
    (async (pull: Record<string, unknown>) => {
      const { Remote } = await import("./remote.ts");
      const { verifyLanded, verifyBackfillLanding } = await import("./cycle.ts");
      const remote = new Remote(repository, token, process.env.ROLLING_RELEASE_BOT ?? "");
      if (object(pull.head).ref === "release-log/main") {
        const { verifyHistoricalRelease } = await import("./legacy.ts");
        return verifyHistoricalRelease(root, remote, pull);
      }
      if (object(pull.head).ref === "release/changelog-backfill")
        return verifyBackfillLanding(root, remote, pull);
      return (await verifyLanded(root, remote, pull, true)).landing;
    });
  const automation = await automationLandings(
    root,
    repository,
    releaseBranch,
    range.baseline.commitSha,
    range.sourceCommitSha,
    token,
    read,
    verify,
  );
  const changes: Change[] = [];
  let segmentBase = range.baseline.commitSha;
  for (const boundary of [
    ...automation,
    { parent: range.sourceCommitSha, landing: range.sourceCommitSha },
  ]) {
    const segment = await inspectPendingRelease(
      root,
      { kind: "bootstrap", commitSha: segmentBase },
      boundary.parent,
    );
    const result = await collectMergedPullRequests(
      { repository, releaseBranch, localRepository: root, range: segment, token, membershipOnly },
      read,
    );
    changes.push(
      ...result.pullRequests.map((pull) => ({
        number: pull.number,
        title: pull.title,
        author: pull.authorLogin ?? null,
        requiredAction: action(pull.body, pull.number),
      })),
    );
    segmentBase = boundary.landing;
  }
  const numbers = new Set<number>();
  for (const change of changes) {
    if (numbers.has(change.number))
      throw new Error(`PR #${change.number} appears in multiple release segments.`);
    numbers.add(change.number);
  }
  return changes.toSorted((a, b) => a.number - b.number);
}

export async function releaseMembers(
  root: string,
  repository: string,
  base: string,
  source: string,
) {
  return (await readChanges(root, repository, base, source, fetch, undefined, true)).map(
    (change) => change.number,
  );
}
