import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { parseReleaseAutomation } from "../src/config/automation.ts";
import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import { reconcileGitHubLatest, taggedReleaseNotes } from "../src/github-release.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalSha,
} from "../src/github-proposals.ts";
import { loadProducerRuntimes, withProducerRuntimes } from "../src/producer-runtime.ts";
import { proposeReleaseForCycle } from "../src/release-roll.ts";
import { candidateLandingPin } from "../src/tagging/candidate.ts";
import { readTagTarget } from "../src/tagging/evidence.ts";
import { createReleaseLandingVerifier, reconcileReleaseTag } from "../src/tagging/reconcile.ts";
import {
  checkImage,
  ContainerPublicationConflict,
  copyLatestManifest,
  readPublication,
  reconcileLatestAlias,
  reconcilePublication,
  withReleaseRegistry,
} from "./container-release.ts";
import { publishInternalCandidate } from "./self-release-publication.ts";
import type { PublicationClaim } from "./self-release-state.ts";
import { SelfReleaseState } from "./self-release-state.ts";

const execute = promisify(execFile);
const initialPull = 124;
const initialLanding = "3929887fbbb8309a55ad819a3d4f0063928a5340";
const initialTag = "v0.5.2";
const localImage = "release-log-candidate:release";

class StaleCandidate extends Error {}

async function main() {
  const configuration = parseReleaseInputConfiguration(
    JSON.parse(process.env.CONFIGURATION ?? "null"),
  );
  if (
    configuration.internalPublication !== true ||
    process.env.GITHUB_REPOSITORY !== configuration.repository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")
  )
    throw new Error("Self-publication requires a trusted event on Release Log main.");
  const automation = parseReleaseAutomation({
    schemaVersion: 1,
    botUserId: Number(process.env.BOT_USER_ID),
  });
  const token = process.env.RELEASE_LOG_APP_TOKEN ?? "";
  const source = resolve("source");
  const candidateDirectory = resolve("candidate");
  const reports = resolve("reports/container-release");
  const api = new GitHubProposalRepository(
    configuration,
    automation.botUserId,
    token,
    fetch,
    3_300_000,
  );
  const state = new SelfReleaseState(api);
  // The workflow token owns stable writes. Its ref writes do not dispatch old tag-triggered workflows.
  const publicationToken = process.env.GHCR_TOKEN ?? "";
  const publisher = new GitHubProposalRepository(
    configuration,
    automation.botUserId,
    publicationToken,
    fetch,
    3_300_000,
  );
  await mkdir(reports, { recursive: true });
  const report = async (status: string, details: object = {}) => {
    const record = { status, ...details };
    await writeFile(join(reports, "status.json"), JSON.stringify(record, null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## Release publication · ${status}\n\n` +
          `\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n\n`,
      );
    process.stdout.write(JSON.stringify(record) + "\n");
  };
  const git = async (...args: string[]) =>
    (
      await execute("git", args, {
        cwd: source,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  const request = (pullNumber: number, landingSha: string) => ({
    configuration,
    automation,
    token,
    pullNumber,
    landingSha,
  });
  const verifyLanding = createReleaseLandingVerifier({ configuration, automation });
  const load = async (pullNumber: number, landingSha: string) => {
    const result = await verifyLanding({ token, pullNumber, landingSha });
    if (result.baseline.kind !== "tag")
      throw new ProposalConflictError("Self-publication requires a verified stable baseline.");
    const pin = candidateLandingPin(result.pull, landingSha, result.verified);
    return { ...result, baseline: result.baseline, pin, tag: `v${pin.version}` };
  };

  let details: object = {};
  try {
    await api.verifyRepository();
    const sourceSha = proposalSha(await api.ref("heads", "main"));
    if ((await git("rev-parse", "HEAD")) !== sourceSha)
      throw new StaleCandidate("Main advanced before the checked-out history could be used.");
    const pulls = await api.pulls();
    const merged = pulls.filter((pull) => pull.merged);
    let journal = await state.read();
    const explicit = journal?.claim
      ? await load(journal.claim.pullNumber, journal.claim.landingSha)
      : null;
    if (
      journal &&
      (!explicit ||
        journal.claim.proposalId !== explicit.pin.proposalId ||
        journal.claim.tag !== explicit.tag ||
        !merged.some(
          (pull) =>
            pull.number === explicit.pullNumber && pull.mergeCommitSha === explicit.landingSha,
        ))
    )
      throw new ProposalConflictError(
        "Self-publication journal refers to a different reviewed candidate.",
      );

    const metadata =
      explicit && journal?.claim.complete
        ? { name: explicit.tag, commitSha: explicit.landingSha }
        : (explicit?.baseline ?? { name: initialTag, commitSha: initialLanding });
    const boundaryPull = merged.find((pull) => pull.mergeCommitSha === metadata.commitSha);
    if (!boundaryPull || (!explicit && boundaryPull.number !== initialPull))
      throw new ProposalConflictError(
        "The verified stable boundary is missing from release history.",
      );
    const boundary =
      explicit?.landingSha === metadata.commitSha
        ? explicit
        : await load(boundaryPull.number, metadata.commitSha);
    if (boundary.tag !== metadata.name)
      throw new ProposalConflictError(
        "The selected stable baseline has a different verified version.",
      );

    const history = (await git("rev-list", "--first-parent", "--reverse", sourceSha)).split("\n");
    const boundaryIndex = history.indexOf(boundary.landingSha);
    const knownLandings = new Set(history);
    const byLanding = new Map(merged.map((pull) => [pull.mergeCommitSha, pull]));
    if (
      boundaryIndex === -1 ||
      byLanding.size !== merged.length ||
      merged.some((pull) => !pull.mergeCommitSha || !knownLandings.has(pull.mergeCommitSha))
    )
      throw new ProposalConflictError(
        "Verified release landings must be unique on main's first-parent history.",
      );
    const newer = history.slice(boundaryIndex + 1).flatMap((sha) => {
      const pull = byLanding.get(sha);
      return pull ? [pull] : [];
    });
    const latestPull = newer.at(-1) ?? boundaryPull;
    if (newer.length > 30)
      throw new ProposalConflictError("Self-publication history exceeds thirty pending landings.");

    await withReleaseRegistry(
      candidateDirectory,
      process.env.GHCR_ACTOR,
      process.env.GHCR_TOKEN,
      async ({ registryToken, run }) => {
        const readImage = async (candidate: typeof boundary) => {
          const image = await readPublication(candidate.tag, await registryToken());
          if (image) checkImage(image.image, candidate.tag, candidate.landingSha);
          return image;
        };
        const checkGitHub = async (candidate: typeof boundary) => {
          const result = await reconcileReleaseTag(
            request(candidate.pullNumber, candidate.landingSha),
          );
          return result.outcome === "unchanged" && result.release?.outcome === "unchanged";
        };

        if (!(await checkGitHub(boundary)) || !(await readImage(boundary)))
          throw new ProposalConflictError(
            "Stable baseline differs from its verified GitHub and GHCR publication.",
          );
        let stable = boundary;
        const pending: (typeof boundary)[] = [];
        for (const pull of newer) {
          if (pull.mergeCommitSha === null)
            throw new ProposalConflictError("A merged candidate is missing its landing.");
          const candidate =
            explicit?.landingSha === pull.mergeCommitSha
              ? explicit
              : await load(pull.number, pull.mergeCommitSha);
          // Only previously public legacy landings can be adopted without a journal.
          if (
            !journal &&
            !candidate.verified.snapshot.configuration.internalPublication &&
            (await readTagTarget(api, candidate.tag)) === candidate.landingSha &&
            (await checkGitHub(candidate)) &&
            (await readImage(candidate))
          ) {
            stable = candidate;
            pending.length = 0;
          } else {
            pending.push(candidate);
          }
        }

        const saved = journal?.claim ?? null;
        const pinnedImage = explicit && saved ? await readImage(explicit) : null;
        const hasPublicWrites =
          explicit &&
          saved &&
          !saved.complete &&
          (pinnedImage !== null ||
            (await readTagTarget(api, explicit.tag)) === explicit.landingSha);
        const newest = pending.at(-1);
        const active = hasPublicWrites
          ? explicit
          : newest?.baseline.commitSha === stable.landingSha && newest.baseline.name === stable.tag
            ? newest
            : null;
        let aliasError: unknown;
        let blocked = false;
        const repairAliases = async (candidate: typeof boundary, expectedDigest: string) => {
          const image = await readImage(candidate);
          if (!image || image.digest !== expectedDigest)
            throw new ProposalConflictError("The version image changed before latest repair.");
          const notes = taggedReleaseNotes(candidate.verified.changelog, candidate.pin.version);
          await writeFile(
            join(reports, "publication.json"),
            JSON.stringify(
              {
                image: `ghcr.io/lhajoosten/release-log:${candidate.tag}`,
                digestReference: `ghcr.io/lhajoosten/release-log@${image.digest}`,
                tag: candidate.tag,
                revision: candidate.landingSha,
                version: candidate.pin.version,
                platform: "linux/amd64",
                configDigest: image.configDigest,
              },
              null,
              2,
            ) + "\n",
          );
          const [github, container] = await Promise.allSettled([
            reconcileGitHubLatest(publisher, candidate.tag, notes, async () => {
              if (
                (await readTagTarget(api, candidate.tag)) !== candidate.landingSha ||
                (await readImage(candidate))?.digest !== expectedDigest
              )
                throw new ProposalConflictError(
                  "Stable publication changed before GitHub latest promotion.",
                );
            }),
            reconcileLatestAlias(
              candidate.tag,
              candidate.landingSha,
              image,
              async () => readPublication("latest", await registryToken()),
              async () => readImage(candidate),
              async () => copyLatestManifest(image.digest, await registryToken()),
            ),
          ]);
          await writeFile(
            join(reports, "latest.json"),
            JSON.stringify(
              {
                github: github.status === "fulfilled" ? github.value : String(github.reason),
                container:
                  container.status === "fulfilled" ? container.value : String(container.reason),
              },
              null,
              2,
            ) + "\n",
          );
          if (github.status === "rejected") throw github.reason;
          if (container.status === "rejected") throw container.reason;
        };
        if (saved?.complete && explicit && pinnedImage) {
          if (
            pinnedImage.digest !== saved.manifestDigest ||
            pinnedImage.configDigest !== saved.configDigest
          )
            throw new ProposalConflictError("Completed version image differs from the journal.");
          try {
            await repairAliases(explicit, pinnedImage.digest);
          } catch (error) {
            aliasError = error;
          }
        }

        if (active) {
          const scanRequired =
            process.env.RELEASE_CONTAINER_SCAN !== "false" ||
            active.tag !== "v0.6.0" ||
            active.landingSha !== "21662200936919c1df83f9d3ce8fccee42fa3dc4";
          details = {
            ...active.pin,
            tag: active.tag,
            sourceSha: active.verified.source.commitSha,
            stableBaseline: active.baseline.name,
            producer: active.verified.identity.producerSha,
            vulnerabilityScan: scanRequired ? "required" : "skipped",
          };
          await report(hasPublicWrites ? "resuming-publication" : "validating", details);
          const target = await readTagTarget(api, active.tag);
          if (target !== null && target !== active.landingSha)
            throw new ProposalConflictError("Stable tag points to another commit.");
          await git("worktree", "add", "--detach", candidateDirectory, active.landingSha);
          const sameClaim = saved?.landingSha === active.landingSha ? saved : null;
          let smokeTestedImageId: string | null = null;
          try {
            await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
            const outcome = await publishInternalCandidate(active.pin, sameClaim, {
              readImage: () => readImage(active),
              checkGitHub: async () => {
                const currentTarget = await readTagTarget(api, active.tag);
                if (currentTarget === null) {
                  const result = await reconcileReleaseTag(
                    request(active.pullNumber, active.landingSha),
                  );
                  if (result.release?.outcome !== "would-create")
                    throw new ProposalConflictError(
                      "A GitHub Release already exists without its verified tag.",
                    );
                  return false;
                }
                return checkGitHub(active);
              },
              stage: async () => {
                await run("pnpm", ["container:build", "--tag", localImage]);
                const imageId = await run("docker", [
                  "image",
                  "inspect",
                  "--format",
                  "{{.Id}}",
                  localImage,
                ]);
                if (!/^sha256:[a-f0-9]{64}$/u.test(imageId))
                  throw new Error("Invalid built image ID.");
                await run("pnpm", ["check:container", "--image", imageId]);
                smokeTestedImageId = imageId;
                if (scanRequired)
                  await run("pnpm", [
                    "container:scan",
                    "--image",
                    imageId,
                    "--output",
                    join(reports, "candidate-scan"),
                    "--allow-openssl-backport",
                  ]);
              },
              publishImage: async (beforePush) => {
                const { result } = await reconcilePublication(
                  active.tag,
                  active.landingSha,
                  () => readImage(active),
                  run,
                  scanRequired
                    ? async () =>
                        JSON.parse(
                          await readFile(join(reports, "candidate-scan/evidence.json"), "utf8"),
                        ) as unknown
                    : { smokeTestedImageId },
                  beforePush,
                  join(reports, "reused-scan"),
                );
                return result;
              },
              claim: async (claim: PublicationClaim) => {
                journal = await state.write(
                  journal?.head ?? null,
                  claim,
                  active.verified.head.treeSha,
                );
              },
              checkActive: async () => {
                const recorded = await state.read();
                if (recorded?.head !== journal?.head)
                  throw new StaleCandidate("The self-publication journal advanced.");
                if ((await readTagTarget(api, stable.tag)) !== stable.landingSha)
                  throw new ProposalConflictError("Stable baseline changed during publication.");
                const verified = await load(active.pullNumber, active.landingSha);
                if (!isDeepStrictEqual(verified.pin, active.pin))
                  throw new ProposalConflictError("Reviewed candidate identity changed.");
                // GitHub and the registry are both read again before the next write.
                const currentTarget = await readTagTarget(api, active.tag);
                if (currentTarget !== null && currentTarget !== active.landingSha)
                  throw new ProposalConflictError(
                    "The stable version tag appeared at another commit.",
                  );
                if (!(await readImage(active))) {
                  const known = new Set(merged.map((pull) => pull.number));
                  const current = (await api.pulls()).filter((pull) => pull.merged);
                  if (
                    current.some((pull) => !known.has(pull.number)) ||
                    !current.some((pull) =>
                      isDeepStrictEqual(pull, { ...active.pull, mergedByUserId: null }),
                    )
                  )
                    throw new StaleCandidate("A newer reviewed candidate superseded this run.");
                }
              },
              publishGitHub: async (beforeWrite) => {
                await reconcileReleaseTag(
                  {
                    ...request(active.pullNumber, active.landingSha),
                    token: publicationToken,
                    write: true,
                  },
                  fetch,
                  beforeWrite,
                );
              },
              repairAliases: (image) => repairAliases(active, image.digest),
            });
            await report(outcome.outcome, { ...details, digest: outcome.image.digest });
            return;
          } catch (error) {
            if (
              error instanceof ProposalConflictError ||
              error instanceof ContainerPublicationConflict ||
              error instanceof StaleCandidate
            )
              throw error;
            const scan = async (folder: string) => {
              try {
                const evidence: unknown = JSON.parse(
                  await readFile(join(reports, folder, "evidence.json"), "utf8"),
                );
                return (
                  typeof evidence === "object" &&
                  evidence !== null &&
                  "blocked" in evidence &&
                  evidence.blocked === true
                );
              } catch (readError) {
                if (
                  readError instanceof Error &&
                  "code" in readError &&
                  readError.code === "ENOENT"
                )
                  return false;
                throw readError;
              }
            };
            blocked = (await scan("candidate-scan")) || (await scan("reused-scan"));
            if (!blocked) {
              await report("operational-error", { ...details, message: String(error) });
              if (hasPublicWrites || (await readImage(active))) throw error;
              aliasError ??= error;
            } else {
              await report("blocked", details);
            }
            if (hasPublicWrites) return;
          }
        }

        // Ordinary merges can build a replacement when no public write locked the previous landing.
        if (sourceSha !== latestPull.mergeCommitSha || (newest && !active)) {
          const pins = pending.map(({ pin }) => pin);
          const replacementConfiguration = {
            ...configuration,
            ...(pins.length ? { candidateLandings: pins } : {}),
            ...(newest && newest.baseline.commitSha !== stable.landingSha
              ? {
                  candidateStableNotes: taggedReleaseNotes(
                    stable.verified.changelog,
                    stable.pin.version,
                  ),
                }
              : {}),
          };
          const result = await proposeReleaseForCycle({
            configuration: replacementConfiguration,
            automation,
            repository: source,
            token,
            write: true,
            landingSha: latestPull.mergeCommitSha ?? stable.landingSha,
            cycle: {
              outcome: "selected",
              sourceSha,
              baseline: {
                kind: "tag",
                name: stable.tag,
                objectSha: proposalSha(await api.ref("tags", stable.tag)),
                commitSha: stable.landingSha,
                pullNumber: stable.pullNumber,
              },
              version: { kind: "released", currentVersion: stable.pin.version },
            },
            candidateHistory: {
              latestLanding: await api.readPull(latestPull.number),
              assertCurrent: async () => {
                if ((await state.read())?.head !== journal?.head)
                  throw new StaleCandidate(
                    "Publication state advanced during proposal preparation.",
                  );
                if ((await api.ref("heads", "main")) !== sourceSha)
                  throw new StaleCandidate("Main advanced during proposal preparation.");
              },
            },
          });
          await report(blocked ? "blocked" : aliasError ? "operational-error" : "ready", {
            ...details,
            proposal: result,
          });
        } else if (!active) {
          await report("unchanged", { tag: stable.tag, landingSha: stable.landingSha });
        }
        if (aliasError) throw aliasError;
      },
    );
  } catch (error) {
    if (error instanceof StaleCandidate) {
      await report("stale", { ...details, message: error.message });
      return;
    }
    await report(
      error instanceof ProposalConflictError || error instanceof ContainerPublicationConflict
        ? "conflict"
        : "operational-error",
      {
        ...details,
        message: String(error),
      },
    );
    throw error;
  }
}

if (import.meta.main) {
  const runtimes = process.env.RELEASE_PRODUCER_RUNTIMES;
  if (!runtimes) throw new Error("A trusted producer runtime registry is required.");
  await withProducerRuntimes(
    await loadProducerRuntimes(JSON.parse(await readFile(runtimes, "utf8"))),
    main,
  );
}
