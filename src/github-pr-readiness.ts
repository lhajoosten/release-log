import { validatePullRequestMetadata } from "./pr-readiness.ts";
import type { PullRequestCommit, PullRequestReadiness } from "./pr-readiness.ts";

const fullSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const maximumResponseBytes = 4 * 1024 * 1024;
const maximumCommits = 250;

export class PullRequestCheckError extends Error {}

export type GitHubRead = (url: string, options: RequestInit) => Promise<Response>;

interface PullRequestState {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly commits: number;
  readonly authorId: number;
  readonly base: { readonly sha: string; readonly ref: string; readonly repositoryId: number };
  readonly head: { readonly sha: string; readonly ref: string; readonly repositoryId: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && fullSha.test(value);
}

function requireRepository(repository: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/u.test(repository) ||
    [".", ".."].includes(repository.split("/")[1] ?? "")
  ) {
    throw new PullRequestCheckError("Use a GitHub owner/repository identity, not a URL or path.");
  }
}

export function pullRequestFromEvent(
  event: unknown,
  repository: string,
): { number: number; headSha: string } {
  requireRepository(repository);

  if (
    !isRecord(event) ||
    !isRecord(event.repository) ||
    event.repository.full_name !== repository ||
    !isPositiveInteger(event.number) ||
    !isRecord(event.pull_request) ||
    !isRecord(event.pull_request.head) ||
    !isSha(event.pull_request.head.sha)
  ) {
    throw new PullRequestCheckError(
      "Expected a PR event for GITHUB_REPOSITORY with a PR number and full head SHA.",
    );
  }

  return { number: event.number, headSha: event.pull_request.head.sha };
}

function readPullRequest(value: unknown, repository: string, number: number): PullRequestState {
  if (
    !isRecord(value) ||
    value.number !== number ||
    value.state !== "open" ||
    value.merged !== false ||
    typeof value.title !== "string" ||
    (value.body !== null && typeof value.body !== "string") ||
    typeof value.updated_at !== "string" ||
    !isPositiveInteger(value.commits) ||
    !isRecord(value.user) ||
    !isPositiveInteger(value.user.id) ||
    !isRecord(value.base) ||
    !isSha(value.base.sha) ||
    typeof value.base.ref !== "string" ||
    !isRecord(value.base.repo) ||
    !isPositiveInteger(value.base.repo.id) ||
    value.base.repo.full_name !== repository ||
    !isRecord(value.head) ||
    !isSha(value.head.sha) ||
    typeof value.head.ref !== "string" ||
    !isRecord(value.head.repo) ||
    !isPositiveInteger(value.head.repo.id)
  ) {
    throw new PullRequestCheckError(
      "GitHub did not return a complete open PR in the expected repository. Refresh the PR and check read permissions.",
    );
  }

  if (value.commits > maximumCommits) {
    throw new PullRequestCheckError(
      "PR metadata checks support at most 250 commits because GitHub's PR commits endpoint is capped. Split the PR before retrying.",
    );
  }

  return {
    number,
    title: value.title,
    body: value.body ?? "",
    updatedAt: value.updated_at,
    commits: value.commits,
    authorId: value.user.id,
    base: { sha: value.base.sha, ref: value.base.ref, repositoryId: value.base.repo.id },
    head: { sha: value.head.sha, ref: value.head.ref, repositoryId: value.head.repo.id },
  };
}

function readCommit(value: unknown): PullRequestCommit {
  if (
    !isRecord(value) ||
    !isSha(value.sha) ||
    !isRecord(value.commit) ||
    typeof value.commit.message !== "string" ||
    !Array.isArray(value.parents) ||
    !value.parents.every((parent: unknown) => isRecord(parent) && isSha(parent.sha))
  ) {
    throw new PullRequestCheckError(
      "GitHub returned incomplete commit evidence; no partial metadata check is accepted.",
    );
  }

  return { sha: value.sha, message: value.commit.message, parentCount: value.parents.length };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new PullRequestCheckError("GitHub returned an empty response; retry the metadata check.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) {
        await reader.cancel();
        throw new PullRequestCheckError(
          "GitHub metadata response exceeds the 4 MiB safety limit; reduce PR metadata and retry.",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PullRequestCheckError) {
      throw error;
    }
    throw new PullRequestCheckError(
      "GitHub response was interrupted or timed out; retry the metadata check.",
    );
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PullRequestCheckError("GitHub returned malformed JSON; retry the metadata check.");
  }
}

export async function checkGitHubPullRequest(
  request: {
    readonly repository: string;
    readonly number: number;
    readonly headSha: string;
    readonly token: string;
  },
  read: GitHubRead = fetch,
): Promise<{
  readonly number: number;
  readonly headSha: string;
  readonly result: PullRequestReadiness;
}> {
  requireRepository(request.repository);
  if (!isPositiveInteger(request.number) || !isSha(request.headSha) || !request.token.trim()) {
    throw new PullRequestCheckError(
      "Provide a PR number, full event head SHA, and a read-only GitHub token.",
    );
  }

  const [owner, repository] = request.repository.split("/");
  const apiPath = `https://api.github.com/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repository ?? "")}/pulls/${request.number}`;

  async function get(suffix = ""): Promise<{ data: unknown; next: boolean }> {
    let response: Response;
    try {
      response = await read(`${apiPath}${suffix}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${request.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "release-log-pr-readiness",
        },
      });
    } catch {
      throw new PullRequestCheckError(
        "GitHub read failed or timed out. Check connectivity and retry; redirects are not followed.",
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      if ([403, 429].includes(response.status)) {
        throw new PullRequestCheckError(
          `GitHub read rejected (HTTP ${response.status}). Check read permissions or rate limits and retry after the limit resets.`,
        );
      }
      throw new PullRequestCheckError(
        `GitHub read failed (HTTP ${response.status}). Check repository/PR read access and retry; no metadata was accepted.`,
      );
    }

    return {
      data: await readJson(response),
      next: /rel="next"/u.test(response.headers.get("link") ?? ""),
    };
  }

  const initial = readPullRequest((await get()).data, request.repository, request.number);
  if (initial.head.sha !== request.headSha) {
    throw new PullRequestCheckError(
      "The event head SHA is outdated. Run the metadata check for the current PR head.",
    );
  }

  const commits: PullRequestCommit[] = [];
  const seen = new Set<string>();
  for (let page = 1; commits.length < initial.commits; page += 1) {
    const response = await get(`/commits?per_page=100&page=${page}`);
    const expectedCount = Math.min(100, initial.commits - commits.length);
    if (!Array.isArray(response.data) || response.data.length !== expectedCount) {
      throw new PullRequestCheckError(
        "GitHub commit pagination is incomplete; retry rather than validate a partial PR.",
      );
    }
    for (const value of response.data) {
      const commit = readCommit(value);
      if (seen.has(commit.sha)) {
        throw new PullRequestCheckError(
          "GitHub returned duplicate commit evidence; refresh and retry the check.",
        );
      }
      seen.add(commit.sha);
      commits.push(commit);
    }
    if (commits.length === initial.commits && response.next) {
      throw new PullRequestCheckError(
        "PR commit count changed or pagination is inconsistent; retry for the current PR.",
      );
    }
    if (commits.length < initial.commits && !response.next) {
      throw new PullRequestCheckError(
        "GitHub truncated the PR commits; retry rather than accept incomplete evidence.",
      );
    }
  }

  if (commits.at(-1)?.sha !== initial.head.sha) {
    throw new PullRequestCheckError(
      "PR commit evidence does not end at the captured head; refresh and retry.",
    );
  }

  const result = await validatePullRequestMetadata(initial.title, initial.body, commits);
  const final = readPullRequest((await get()).data, request.repository, request.number);
  if (JSON.stringify(initial) !== JSON.stringify(final)) {
    throw new PullRequestCheckError(
      "PR title, body, commits, or identity changed during validation. Retry the metadata check for the current PR.",
    );
  }

  return { number: initial.number, headSha: initial.head.sha, result };
}
