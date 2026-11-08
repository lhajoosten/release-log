import { createHash } from "node:crypto";
import { GitHubReadError, requestGitHubJson } from "./github.ts";
import type { GitHubRead } from "./github.ts";
import { releaseInputPaths } from "./proposal-files.ts";
import type { ProposalFile, ReleaseFileContents } from "./proposal-files.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export class ProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalConflictError";
  }
}
export function proposalObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProposalConflictError("GitHub returned incomplete proposal evidence.");
  return Object.fromEntries(Object.entries(value));
}
export function proposalSha(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    throw new ProposalConflictError("GitHub returned an invalid immutable object ID.");
  return value;
}
interface TreeEntry {
  readonly sha: string;
  readonly mode: string;
  readonly type: string;
}
export interface ProposalTree {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly message: string;
  readonly parents: readonly string[];
  readonly entries: ReadonlyMap<string, TreeEntry>;
}
export interface ProposalPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headSha: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly mergedByUserId: number | null;
}

export class GitHubProposalRepository {
  readonly headRef: string;
  private readonly prefix: string;
  private readonly signal = AbortSignal.timeout(300_000);
  private requests = 0;
  private readonly config: ReleaseInputConfiguration;
  private readonly botUserId: number;
  private readonly token: string;
  private readonly transport: GitHubRead;
  constructor(
    config: ReleaseInputConfiguration,
    botUserId: number,
    token: string,
    transport: GitHubRead = fetch,
  ) {
    if (!Number.isSafeInteger(botUserId) || botUserId <= 0 || !token.trim())
      throw new ProposalConflictError(
        "Configure the expected numeric bot identity and a repository-limited token explicitly.",
      );
    this.config = config;
    this.botUserId = botUserId;
    this.token = token;
    this.transport = transport;
    this.headRef = `release-log/${config.releaseBranch}`;
    this.prefix = `https://api.github.com/repos/${config.repository}`;
  }
  async request(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ): Promise<{ data: unknown; next: boolean }> {
    if (++this.requests > 200)
      throw new ProposalConflictError("Proposal reconciliation exceeds its 200-request budget.");
    return requestGitHubJson(
      this.prefix + path,
      this.token,
      { method, ...(body === undefined ? {} : { body }) },
      this.transport,
      this.signal,
    );
  }
  async requireDescendant(ancestor: string, source: string): Promise<void> {
    if (ancestor === source) return;
    const comparison = proposalObject(
      (await this.request(`/compare/${proposalSha(ancestor)}...${proposalSha(source)}?per_page=1`))
        .data,
    );
    if (
      comparison.status !== "ahead" ||
      comparison.behind_by !== 0 ||
      typeof comparison.ahead_by !== "number" ||
      !Number.isSafeInteger(comparison.ahead_by) ||
      comparison.ahead_by <= 0 ||
      proposalObject(comparison.base_commit).sha !== ancestor ||
      proposalObject(comparison.merge_base_commit).sha !== ancestor
    )
      throw new ProposalConflictError(
        "The release source was rewound or diverged from the previous proposal; review rather than discard captured changes.",
      );
  }
  async verifyRepository(): Promise<void> {
    const data = proposalObject((await this.request("")).data);
    if (data.id !== this.config.repositoryId || data.full_name !== this.config.repository)
      throw new ProposalConflictError("GitHub repository identity changed; review configuration.");
  }
  async ref(kind: "heads" | "tags", name: string, optional = false): Promise<string | null> {
    try {
      const data = proposalObject(
        (await this.request(`/git/ref/${kind}/${encodeURIComponent(name)}`)).data,
      );
      if (data.ref !== `refs/${kind}/${name}`)
        throw new ProposalConflictError("GitHub returned a different ref than requested.");
      return proposalSha(proposalObject(data.object).sha);
    } catch (error) {
      if (optional && error instanceof GitHubReadError && error.status === 404) return null;
      throw error;
    }
  }
  async tree(commitSha: string): Promise<ProposalTree> {
    const commit = proposalObject(
      (await this.request(`/git/commits/${proposalSha(commitSha)}`)).data,
    );
    if (
      commit.sha !== commitSha ||
      typeof commit.message !== "string" ||
      !Array.isArray(commit.parents)
    )
      throw new ProposalConflictError("GitHub returned incomplete commit evidence.");
    const treeSha = proposalSha(proposalObject(commit.tree).sha);
    const data = proposalObject((await this.request(`/git/trees/${treeSha}?recursive=1`)).data);
    if (
      data.sha !== treeSha ||
      data.truncated !== false ||
      !Array.isArray(data.tree) ||
      data.tree.length > 50_000
    )
      throw new ProposalConflictError(
        "A complete bounded Git tree is required; truncated or oversized trees cannot be updated.",
      );
    const entries = new Map<string, TreeEntry>();
    for (const raw of data.tree) {
      const item = proposalObject(raw);
      if (
        typeof item.path !== "string" ||
        item.path.length > 4096 ||
        typeof item.mode !== "string" ||
        typeof item.type !== "string" ||
        entries.has(item.path)
      )
        throw new ProposalConflictError("GitHub returned inconsistent Git tree entries.");
      entries.set(item.path, { sha: proposalSha(item.sha), mode: item.mode, type: item.type });
    }
    return {
      commitSha,
      treeSha,
      message: commit.message,
      parents: commit.parents.map((parent: unknown) => proposalSha(proposalObject(parent).sha)),
      entries,
    };
  }
  async contents(tree: ProposalTree): Promise<ReleaseFileContents> {
    const get = async (path: string): Promise<string | null> => {
      const parent = tree.entries.get(".release-log");
      if (
        path.startsWith(".release-log/") &&
        parent &&
        (parent.type !== "tree" || parent.mode !== "040000")
      )
        throw new ProposalConflictError(
          "The snapshot directory must not be a symlink or submodule.",
        );
      const entry = tree.entries.get(path);
      if (!entry) return null;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new ProposalConflictError(
          "Proposal inputs must be ordinary tracked files, not symlinks or submodules.",
        );
      const blob = proposalObject((await this.request(`/git/blobs/${entry.sha}`)).data);
      if (
        blob.sha !== entry.sha ||
        blob.encoding !== "base64" ||
        typeof blob.content !== "string" ||
        typeof blob.size !== "number" ||
        blob.size > 2 * 1024 * 1024
      )
        throw new ProposalConflictError(
          "Controller input files require complete base64 blobs no larger than 2 MiB.",
        );
      const compact = blob.content.replaceAll("\n", "");
      const bytes = Buffer.from(compact, "base64");
      const text = bytes.toString("utf8");
      if (
        bytes.length !== blob.size ||
        bytes.toString("base64") !== compact ||
        !Buffer.from(text).equals(bytes)
      )
        throw new ProposalConflictError("Controller input blobs must be complete UTF-8 text.");
      const actualSha = createHash(entry.sha.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (actualSha !== entry.sha)
        throw new ProposalConflictError(
          "GitHub blob bytes disagree with their immutable object ID.",
        );
      return text;
    };
    return {
      "package.json": await get("package.json"),
      "pyproject.toml": await get("pyproject.toml"),
      "CHANGELOG.md": await get("CHANGELOG.md"),
      ".release-log/inputs.json": await get(".release-log/inputs.json"),
      "package-lock.json": await get("package-lock.json"),
      "npm-shrinkwrap.json": await get("npm-shrinkwrap.json"),
      "uv.lock": await get("uv.lock"),
    };
  }
  pull(value: unknown): ProposalPullRequest {
    const raw = proposalObject(value);
    const head = proposalObject(raw.head);
    const base = proposalObject(raw.base);
    const author = proposalObject(raw.user);
    if (
      !Number.isSafeInteger(raw.number) ||
      typeof raw.number !== "number" ||
      raw.number <= 0 ||
      typeof raw.title !== "string" ||
      typeof raw.body !== "string" ||
      !["open", "closed"].includes(String(raw.state)) ||
      !(raw.merged_at === null || typeof raw.merged_at === "string") ||
      head.ref !== this.headRef ||
      base.ref !== this.config.releaseBranch ||
      proposalObject(head.repo).id !== this.config.repositoryId ||
      proposalObject(base.repo).id !== this.config.repositoryId ||
      author.id !== this.botUserId ||
      author.type !== "Bot"
    )
      throw new ProposalConflictError(
        "Reserved proposal PR identity does not match the configured bot/repository/branches; review manually.",
      );
    if (raw.state !== "open" && raw.state !== "closed")
      throw new ProposalConflictError("Unsupported proposal state.");
    let mergeCommitSha: string | null = null;
    let mergedByUserId: number | null = null;
    if (raw.merged_at !== null) {
      const merger = proposalObject(raw.merged_by);
      if (
        merger.type !== "User" ||
        typeof merger.id !== "number" ||
        !Number.isSafeInteger(merger.id) ||
        merger.id <= 0
      )
        throw new ProposalConflictError(
          "Merged release approval requires an identifiable human merger.",
        );
      mergeCommitSha = proposalSha(raw.merge_commit_sha);
      mergedByUserId = merger.id;
    }
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      headSha: proposalSha(head.sha),
      state: raw.state,
      merged: raw.merged_at !== null,
      mergeCommitSha,
      mergedByUserId,
    };
  }
  async pulls(): Promise<readonly ProposalPullRequest[]> {
    const result: ProposalPullRequest[] = [];
    const owner = this.config.repository.split("/")[0];
    for (let page = 1; page <= 10; page++) {
      const response = await this.request(
        `/pulls?state=all&head=${encodeURIComponent(`${owner}:${this.headRef}`)}&base=${encodeURIComponent(this.config.releaseBranch)}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.data))
        throw new ProposalConflictError("GitHub returned an invalid proposal history page.");
      result.push(...response.data.map((value: unknown) => this.pull(value)));
      if (!response.next) {
        if (new Set(result.map((pull) => pull.number)).size !== result.length)
          throw new ProposalConflictError(
            "Duplicate proposal history; cannot choose an authoritative PR.",
          );
        return result;
      }
    }
    throw new ProposalConflictError(
      "Proposal history exceeds ten pages; no partial selection is permitted.",
    );
  }
  async readPull(number: number): Promise<ProposalPullRequest> {
    return this.pull((await this.request(`/pulls/${number}`)).data);
  }
  async commit(
    source: ProposalTree,
    previousHead: string | null,
    files: readonly ProposalFile[],
    message: string,
  ): Promise<string> {
    const tree = proposalObject(
      (
        await this.request("/git/trees", "POST", {
          base_tree: source.treeSha,
          tree: files.map((file) => {
            if (!releaseInputPaths.includes(file.path))
              throw new ProposalConflictError("Unexpected proposal output path.");
            if (Buffer.byteLength(file.after, "utf8") > 2 * 1024 * 1024)
              throw new ProposalConflictError(
                "Controller output files exceed the 2 MiB per-file limit.",
              );
            return {
              path: file.path,
              mode: source.entries.get(file.path)?.mode ?? "100644",
              type: "blob",
              content: file.after,
            };
          }),
        })
      ).data,
    );
    // Build from the captured source tree, but retain the previous proposal as a
    // parent so refreshes remain fast-forward-only without rewriting its history.
    const commit = proposalObject(
      (
        await this.request("/git/commits", "POST", {
          tree: proposalSha(tree.sha),
          parents:
            previousHead && previousHead !== source.commitSha
              ? [source.commitSha, previousHead]
              : [source.commitSha],
          message,
        })
      ).data,
    );
    return proposalSha(commit.sha);
  }
  async setRef(head: string, exists: boolean): Promise<void> {
    if (exists)
      await this.request(`/git/refs/heads/${encodeURIComponent(this.headRef)}`, "PATCH", {
        sha: head,
        force: false,
      });
    else await this.request("/git/refs", "POST", { ref: `refs/heads/${this.headRef}`, sha: head });
  }
  async savePull(
    previous: ProposalPullRequest | null,
    title: string,
    body: string,
  ): Promise<ProposalPullRequest> {
    return this.pull(
      (
        await this.request(
          previous ? `/pulls/${previous.number}` : "/pulls",
          previous ? "PATCH" : "POST",
          {
            title,
            body,
            ...(previous
              ? {}
              : {
                  head: this.headRef,
                  base: this.config.releaseBranch,
                  draft: true,
                  maintainer_can_modify: false,
                }),
          },
        )
      ).data,
    );
  }
}
