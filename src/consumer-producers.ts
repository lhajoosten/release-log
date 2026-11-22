import { ancestry, latestMergedProposal } from "./cycle/history.ts";
import { GitHubProposalRepository, proposalObject } from "./github-proposals.ts";
import { GitHubReadError, readGitHubJson } from "./github.ts";
import type { GitHubRead } from "./github.ts";
import { capturedIdentity } from "./proposal/identity.ts";
import type { ReleaseInputConfiguration } from "./config/repository.ts";
import type { parseProducerPins } from "./config/producer-pins.ts";

export async function selectConsumerProducers(
  configuration: ReleaseInputConfiguration,
  botUserId: number,
  token: string,
  activeSha: string,
  catalog: ReturnType<typeof parseProducerPins>,
  mergePullNumber?: number,
  transport?: GitHubRead,
) {
  const api = new GitHubProposalRepository(configuration, botUserId, token, transport);
  await api.verifyRepository();
  const pulls = await api.pulls();
  const landing = pulls.find((pull) => pull.number === mergePullNumber && pull.merged);
  const candidates = landing ? [landing] : pulls.filter((pull) => pull.state === "open");
  if (!landing) {
    const latest = await latestMergedProposal(pulls, ancestry(api));
    if (latest && latest.number !== configuration.adoptedRelease?.pullNumber)
      candidates.push(latest);
  }

  const needed = new Map<string, { sha: string; legacy: boolean }>();
  for (const pull of candidates) {
    const commit = await api.readCommit(pull.headSha);
    const { producerSha } = capturedIdentity(commit.message);
    if (producerSha === undefined) {
      for (const pin of catalog) if (pin.legacy) needed.set(pin.sha, pin);
    } else if (producerSha !== activeSha) {
      const pin = catalog.find(({ sha }) => sha === producerSha);
      if (!pin && !(await isPromotedProducer(producerSha, transport)))
        throw new Error(
          `Proposal PR #${pull.number} requires producer ${producerSha}. Ask Rolling Release to restore or approve it in the provider catalog.`,
        );
      needed.set(producerSha, pin ?? { sha: producerSha, legacy: false });
    }
  }
  return [...needed.values()];
}

async function isPromotedProducer(sha: string, transport?: GitHubRead): Promise<boolean> {
  const key = `tags/rolling-release-producer/${sha}`;
  try {
    // These append-only tags attest exact reviewed revisions in the public provider.
    const { data } = await readGitHubJson(
      `https://api.github.com/repos/lhajoosten/rolling-release/git/ref/${key}`,
      "",
      async (url, options) => {
        const headers = new Headers(options.headers);
        headers.delete("Authorization");
        return (transport ?? fetch)(url, { ...options, headers });
      },
    );
    const ref = proposalObject(data);
    const object = proposalObject(ref.object);
    return ref.ref === `refs/${key}` && object.type === "commit" && object.sha === sha;
  } catch (error) {
    if (error instanceof GitHubReadError && error.status === 404) return false;
    throw error;
  }
}
