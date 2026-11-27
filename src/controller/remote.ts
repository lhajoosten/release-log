import { githubCommitSignature, verifiedAppCommit } from "./commit-verification.ts";
import { GitHubReadError, requestGitHubJson } from "../github.ts";

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a GitHub object");
  return Object.fromEntries(Object.entries(value));
}

export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("Invalid Git object ID");
  return value;
}

export function repoName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/u.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid GitHub repository");
  return value;
}

export class Remote {
  readonly repository: string;
  readonly bot: string;
  readonly #token: string;
  constructor(repository: string, token: string, bot: string) {
    this.repository = repoName(repository);
    if (!token || !/^[\w-]+\[bot\]$/u.test(bot))
      throw new Error("Expected a GitHub token and the trusted GitHub App bot login");
    this.#token = token;
    this.bot = bot;
  }
  async request(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ): Promise<unknown> {
    return (
      await requestGitHubJson(
        `https://api.github.com/repos/${this.repository}/${path}`,
        this.#token,
        { method, body },
      )
    ).data;
  }
  async verifiedAppCommit(head: string) {
    const commit = await this.request("commits/" + head);
    return verifiedAppCommit(
      commit,
      head,
      this.bot,
      () => githubCommitSignature(this.repository, head, this.#token),
      this.repository,
    );
  }
  async optional(path: string): Promise<unknown> {
    try {
      return await this.request(path);
    } catch (error) {
      if (error instanceof GitHubReadError && error.status === 404) return null;
      throw error;
    }
  }
  async ref(ref: string): Promise<string | null> {
    const result = await this.optional("git/ref/" + ref);
    return result === null ? null : sha(object(object(result).object).sha);
  }
  async tag(tag: string): Promise<string | null> {
    const result = await this.optional("git/ref/tags/" + tag);
    if (result === null) return null;
    let target = object(object(result).object);
    for (let depth = 0; depth < 8; depth++) {
      const id = sha(target.sha);
      if (target.type === "commit") return id;
      if (target.type !== "tag") break;
      target = object(object(await this.request("git/tags/" + id)).object);
    }
    throw new Error("Tag does not resolve to a commit: " + tag);
  }
  async openProposal(branch: string) {
    const pulls = await this.request(
      "pulls?" +
        new URLSearchParams({
          state: "open",
          head: this.repository.split("/")[0] + ":" + branch,
          base: "main",
          per_page: "2",
        }),
    );
    if (!Array.isArray(pulls) || pulls.length > 1) throw new Error("Ambiguous proposal " + branch);
    if (!pulls.length) return null;
    const pull = object(pulls[0]);
    if (
      !this.owned(pull, branch) ||
      typeof pull.number !== "number" ||
      !Number.isSafeInteger(pull.number)
    )
      throw new Error("Unowned proposal " + branch);
    return {
      number: pull.number,
      head: sha(object(pull.head).sha),
      title: pull.title,
      body: pull.body,
      pull,
    };
  }
  async lastClosed(branch: string) {
    const list = await this.request(
      "pulls?" +
        new URLSearchParams({
          state: "closed",
          head: this.repository.split("/")[0] + ":" + branch,
          base: "main",
          sort: "created",
          direction: "desc",
          per_page: "1",
        }),
    );
    if (!Array.isArray(list)) throw new Error("Invalid closed proposal response");
    if (!list.length) return null;
    const number = object(list[0]).number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
      throw new Error("Invalid closed proposal number");
    const pull = object(await this.request("pulls/" + number));
    if (!this.owned(pull, branch) || pull.merged !== true)
      throw new Error("A closed, unmerged or unowned proposal requires maintainer recovery");
    return pull;
  }
  owned(pull: Record<string, unknown>, branch: string) {
    const head = object(pull.head),
      base = object(pull.base),
      author = object(pull.user);
    return (
      author.type === "Bot" &&
      author.login === this.bot &&
      head.ref === branch &&
      base.ref === "main" &&
      head.repo !== null &&
      head.repo !== undefined &&
      object(head.repo).full_name === this.repository &&
      object(base.repo).full_name === this.repository
    );
  }
  private async confirmProposal(input: {
    branch: string;
    number: number;
    previous: string;
    next: string;
    expectedTitle: unknown;
    expectedBody: unknown;
    title: string;
    body: string;
    afterPatch: boolean;
  }) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const pull = object(await this.request("pulls/" + input.number));
      const head = sha(object(pull.head).sha);
      const oldText = pull.title === input.expectedTitle && pull.body === input.expectedBody;
      const newText = pull.title === input.title && pull.body === input.body;
      if (
        pull.number !== input.number ||
        pull.state !== "open" ||
        !this.owned(pull, input.branch) ||
        (head !== input.previous && head !== input.next) ||
        (!oldText && !(input.afterPatch && newText))
      )
        throw new Error("Proposal was edited during refresh; preserve the edit for review");
      if (head === input.next && (input.afterPatch ? newText : oldText)) return;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
    throw new Error("Proposal write was not confirmed");
  }
  async updateProposalText(input: {
    branch: string;
    source: string;
    head: string;
    number: number;
    expectedTitle: unknown;
    expectedBody: unknown;
    title: string;
    body: string;
    recheck?: () => Promise<void>;
  }) {
    const confirm = (afterPatch: boolean) =>
      this.confirmProposal({ ...input, previous: input.head, next: input.head, afterPatch });
    const assertRefs = async () => {
      if (
        (await this.ref("heads/main")) !== input.source ||
        (await this.ref("heads/" + input.branch)) !== input.head
      )
        throw new Error("Main or the proposal changed; retry from fresh refs");
    };
    await input.recheck?.();
    await assertRefs();
    await confirm(false);
    await this.request("pulls/" + input.number, "PATCH", { title: input.title, body: input.body });
    await confirm(true);
  }
  async writeProposal(input: {
    branch: string;
    source: string;
    previous: string | null;
    number: number | null;
    title: string;
    files: ReadonlyMap<string, string | Uint8Array>;
    body: string;
    expectedBody?: unknown;
    expectedTitle?: unknown;
    recheck?: () => Promise<void>;
  }) {
    const { branch, source, previous, number, title, files, body } = input;
    const assertFresh = async () => {
      if (
        (await this.ref("heads/main")) !== source ||
        (await this.ref("heads/" + branch)) !== previous
      )
        throw new Error("Main or the proposal changed; retry from fresh refs");
      const open = await this.openProposal(branch);
      if (
        (open?.number ?? null) !== number ||
        (open &&
          (open.head !== previous ||
            open.body !== input.expectedBody ||
            open.title !== input.expectedTitle))
      )
        throw new Error("Proposal ownership or head changed");
    };
    await assertFresh();
    const base = object(await this.request("git/commits/" + source));
    const tree = [];
    for (const [path, bytes] of files) {
      if (
        path.startsWith("/") ||
        path.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
      )
        throw new Error("Invalid generated path " + path);
      const blob = object(
        await this.request("git/blobs", "POST", {
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        }),
      );
      tree.push({ path, mode: "100644", type: "blob", sha: sha(blob.sha) });
    }
    const nextTree = object(
      await this.request("git/trees", "POST", { base_tree: sha(object(base.tree).sha), tree }),
    );
    const commit = object(
      await this.request("git/commits", "POST", {
        message: title,
        tree: sha(nextTree.sha),
        parents: previous && previous !== source ? [source, previous] : [source],
      }),
    );
    const next = sha(commit.sha);
    await assertFresh();
    await input.recheck?.();
    if (previous)
      await this.request("git/refs/heads/" + branch, "PATCH", { sha: next, force: false });
    else await this.request("git/refs", "POST", { ref: "refs/heads/" + branch, sha: next });
    if ((await this.ref("heads/" + branch)) !== next)
      throw new Error("Proposal head changed during update");
    if (number) {
      if (!previous) throw new Error("Existing proposal has no previous head");
      await this.confirmProposal({
        ...input,
        expectedTitle: input.expectedTitle,
        expectedBody: input.expectedBody,
        number,
        previous,
        next,
        afterPatch: false,
      });
      await this.updateProposalText({
        branch,
        source,
        head: next,
        number,
        expectedTitle: input.expectedTitle,
        expectedBody: input.expectedBody,
        title,
        body,
        ...(input.recheck ? { recheck: input.recheck } : {}),
      });
      return;
    }
    await this.request("pulls", "POST", { head: branch, base: "main", title, body });
    const saved = await this.openProposal(branch);
    if (
      !saved ||
      saved.head !== next ||
      saved.title !== title ||
      saved.body !== body ||
      (number && saved.number !== number)
    )
      throw new Error("Proposal write was not confirmed");
  }
}
