import { isDeepStrictEqual } from "node:util";
import { ProposalConflictError, proposalObject, proposalSha } from "../src/github-proposals.ts";
import type { GitHubProposalRepository } from "../src/github-proposals.ts";

const branch = "release-log/publication";
const header = "release-log self-publication v1\n\n";

export interface PublicationClaim {
  readonly pullNumber: number;
  readonly landingSha: string;
  readonly proposalId: string;
  readonly tag: string;
  readonly configDigest: string;
  readonly manifestDigest: string | null;
  readonly complete: boolean;
}

const isDigest = (digest: unknown): digest is string =>
  typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest);

function parseClaim(value: unknown): PublicationClaim {
  const claim = proposalObject(value);
  const { pullNumber, landingSha, proposalId, tag, configDigest, manifestDigest, complete } = claim;
  if (
    Object.keys(claim).length !== 7 ||
    typeof pullNumber !== "number" ||
    !Number.isSafeInteger(pullNumber) ||
    pullNumber <= 0 ||
    typeof proposalId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proposalId) ||
    typeof tag !== "string" ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag) ||
    !isDigest(configDigest) ||
    (manifestDigest !== null && !isDigest(manifestDigest)) ||
    typeof complete !== "boolean" ||
    (complete && !manifestDigest)
  )
    throw new ProposalConflictError("Invalid self-publication journal.");
  return {
    pullNumber,
    landingSha: proposalSha(landingSha),
    proposalId,
    tag,
    configDigest,
    manifestDigest,
    complete,
  };
}

export class SelfReleaseState {
  private readonly api: GitHubProposalRepository;

  constructor(api: GitHubProposalRepository) {
    this.api = api;
  }

  async read() {
    const head = await this.api.ref("heads", branch, true);
    if (!head) return null;
    const commit = proposalObject((await this.api.request(`/git/commits/${head}`)).data);
    if (
      commit.sha !== head ||
      typeof commit.message !== "string" ||
      !commit.message.startsWith(header)
    )
      throw new ProposalConflictError("Unrecognized self-publication journal commit.");
    let raw: unknown;
    try {
      raw = JSON.parse(commit.message.slice(header.length));
    } catch {
      throw new ProposalConflictError("Invalid self-publication journal JSON.");
    }
    return { head, claim: parseClaim(raw) };
  }

  async write(expectedHead: string | null, claim: PublicationClaim, tree: string) {
    parseClaim(claim);
    if ((await this.api.ref("heads", branch, true)) !== expectedHead)
      throw new ProposalConflictError(
        "The self-publication journal advanced; retry with fresh state.",
      );
    const commit = proposalObject(
      (
        await this.api.request("/git/commits", "POST", {
          tree,
          parents: [expectedHead ?? claim.landingSha],
          message: header + JSON.stringify(claim),
        })
      ).data,
    );
    const head = proposalSha(commit.sha);
    if (expectedHead) {
      await this.api.request(`/git/refs/heads/${branch}`, "PATCH", { sha: head, force: false });
    } else {
      await this.api.request("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: head });
    }
    const saved = await this.read();
    if (!saved || saved.head !== head || !isDeepStrictEqual(saved.claim, claim))
      throw new ProposalConflictError("Uncertain self-publication journal write; reconcile again.");
    return saved;
  }
}
