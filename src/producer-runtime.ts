import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe } from "./proposal-identity.ts";
import type { Description, ProposalBodyFormat } from "./proposal-identity.ts";
import { prepareReleaseFileContents } from "./proposal-files.ts";
import type { PreparedRelease, ReleaseFileContents } from "./proposal/prepare.ts";
import { replayReleaseSnapshot } from "./snapshot/replay.ts";
import type { ReleaseInputConfiguration } from "./config/repository.ts";
import type { ReleaseSnapshot } from "./snapshot/model.ts";
import type { ReleaseVersionConfiguration } from "./planning/derive-release-plan.ts";
import { ProposalConflictError, proposalObject, proposalSha } from "./github-proposals.ts";

interface Producer {
  readonly sha: string;
  readonly legacy: boolean;
  readonly replay: typeof replayReleaseSnapshot;
  readonly prepare: typeof prepareReleaseFileContents;
  readonly describe: typeof describe;
}
export interface ProducerRuntimes {
  readonly activeSha: string;
  readonly producers: readonly Producer[];
}
const context = new AsyncLocalStorage<ProducerRuntimes>();

export function withProducerRuntimes<T>(runtimes: ProducerRuntimes, operation: () => T): T {
  return context.run(runtimes, operation);
}
export function activeProducerSha(): string | undefined {
  return context.getStore()?.activeSha;
}

// Executable modules are trusted; this checks the public module contract before
// calling them. Snapshot data never supplies code or a module location.
function implementsProducer(value: {
  replay: unknown;
  prepare: unknown;
  describe: unknown;
}): value is Pick<Producer, "replay" | "prepare" | "describe"> {
  return (
    typeof value.replay === "function" &&
    typeof value.prepare === "function" &&
    typeof value.describe === "function"
  );
}

// The registry is administrator-supplied executable configuration. Never derive
// directories or checkout revisions from snapshots, markers, PRs or consumer code.
export async function loadProducerRuntimes(value: unknown): Promise<ProducerRuntimes> {
  const registry = proposalObject(value);
  if (
    Object.keys(registry).toSorted().join(",") !== "activeSha,producers" ||
    !Array.isArray(registry.producers) ||
    registry.producers.length > 20
  )
    throw new ProposalConflictError("Supply a bounded trusted producer runtime registry.");
  const activeSha = proposalSha(registry.activeSha);
  const producers: Producer[] = [];
  for (const item of registry.producers) {
    const entry = proposalObject(item);
    const sha = proposalSha(entry.sha);
    if (
      Object.keys(entry).toSorted().join(",") !== "directory,legacy,sha" ||
      typeof entry.directory !== "string" ||
      !isAbsolute(entry.directory) ||
      typeof entry.legacy !== "boolean" ||
      sha === activeSha ||
      producers.some((p) => p.sha === sha)
    )
      throw new ProposalConflictError(
        "Producer runtimes require unique pinned SHAs, absolute trusted directories and explicit legacy authority.",
      );
    const directory = await realpath(entry.directory);
    const modules: unknown[] = await Promise.all(
      ["release-snapshot", "proposal-files", "proposal-identity"].map(
        (name) => import(pathToFileURL(join(directory, "dist", "src", `${name}.js`)).href),
      ),
    );
    const snapshot = proposalObject(modules[0]);
    const files = proposalObject(modules[1]);
    const identity = proposalObject(modules[2]);
    const runtime = {
      replay: snapshot.replayReleaseSnapshot,
      prepare: files.prepareReleaseFileContents,
      describe: identity.describe,
    };
    if (!implementsProducer(runtime))
      throw new ProposalConflictError(
        "The trusted producer does not implement proposal reconstruction.",
      );
    producers.push({ sha, legacy: entry.legacy, ...runtime });
  }
  return { activeSha, producers };
}

export async function reconstructProposal(
  serialized: string,
  configuration: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
  contents: ReleaseFileContents,
  botUserId: number,
  previousHeadSha: string | null,
  producerSha?: string,
  bodyFormat: ProposalBodyFormat = "legacy",
): Promise<{ snapshot: ReleaseSnapshot; prepared: PreparedRelease; description: Description }> {
  const registry = context.getStore();
  const current: Producer = {
    sha: registry?.activeSha ?? "",
    legacy: false,
    replay: replayReleaseSnapshot,
    prepare: prepareReleaseFileContents,
    describe,
  };
  const candidates =
    producerSha === undefined
      ? [current, ...(registry?.producers.filter((p) => p.legacy) ?? [])]
      : producerSha === registry?.activeSha
        ? [current]
        : (registry?.producers.filter((p) => p.sha === producerSha) ?? []);
  if (candidates.length === 0)
    throw new ProposalConflictError(
      "The recorded producer SHA has no explicitly trusted verification runtime.",
    );
  for (const [index, producer] of candidates.entries()) {
    let snapshot: ReleaseSnapshot;
    try {
      snapshot = await producer.replay(serialized, configuration);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "normalizer-mismatch") ||
        index === candidates.length - 1
      )
        throw error;
      continue;
    }
    const prepared = await producer.prepare(serialized, configuration, version, contents);
    const description = producer.describe(
      snapshot,
      prepared,
      botUserId,
      previousHeadSha,
      producerSha,
      bodyFormat,
    );
    return { snapshot, prepared, description };
  }
  throw new ProposalConflictError("No matching trusted producer runtime is available.");
}
