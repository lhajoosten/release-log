import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
function obj(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid rehearsal evidence object");
  return Object.fromEntries(Object.entries(value));
}
function str(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Invalid rehearsal evidence value");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid rehearsal evidence number");
  return value;
}

// The historical observations are an operator attestation; GitHub cannot reconstruct
// a deleted or interrupted release's prior state from the current state alone.
export function parseEvidence(value: unknown, expectedRepo: string, expectedCandidate: string) {
  const e = obj(value);
  const repo = str(e.repository, repository);
  const candidate = str(e.candidate, sha);
  const previous = str(e.previous, sha);
  if (repo !== expectedRepo || candidate !== expectedCandidate || previous === candidate)
    throw new Error("Rehearsal identity mismatch");
  const releasePr = number(e.releasePr);
  const oldPr = number(e.oldPr);
  const newPr = number(e.newPr);
  const afterPr = number(e.afterPr);
  const newTriggerPr = number(e.newTriggerPr);
  const newHead = str(e.newHead, sha);
  if (new Set([releasePr, oldPr, newPr]).size !== 3)
    throw new Error("Rehearsal PRs must be distinct");
  const landing = str(e.landing, sha);
  const version = str(e.version, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  const imageDigest = str(e.imageDigest, digest);
  const runs = obj(e.runs);
  const publication = number(runs.publication);
  const retry = number(runs.retry);
  const oldReplay = number(runs.oldReplay);
  const newProposal = number(runs.newProposal);
  const pinPreview = number(runs.pinPreview);
  const freshCheck = number(runs.freshCheck);
  const alteredCheck = number(runs.alteredCheck);
  if (
    new Set([publication, retry, oldReplay, newProposal, freshCheck, alteredCheck, pinPreview])
      .size !== 7
  )
    throw new Error("Rehearsal runs must be distinct");
  const observed = obj(e.observed);
  if (
    observed.interruptedDigest !== imageDigest ||
    observed.retriedDigest !== imageDigest ||
    observed.releaseBeforeRetry !== "absent" ||
    observed.releaseAfterRetry !== "present" ||
    observed.failedPromotionBefore !== previous ||
    observed.failedPromotionAfter !== previous ||
    observed.rollbackTarget !== previous ||
    observed.oldProposalReplay !== "passed" ||
    observed.newProducer !== candidate ||
    observed.rollbackWithOpenProposal !== "passed"
  )
    throw new Error("Incomplete or conflicting operator observations");
  return {
    repo,
    candidate,
    previous,
    releasePr,
    oldPr,
    newPr,
    afterPr,
    newTriggerPr,
    newHead,
    landing,
    version,
    imageDigest,
    publication,
    retry,
    oldReplay,
    newProposal,
    pinPreview,
    freshCheck,
    alteredCheck,
  };
}

type Get = (path: string) => Promise<unknown>;
export async function verifyEvidence(
  value: unknown,
  repo: string,
  candidate: string,
  get: Get,
  registryDigest: string,
) {
  const e = parseEvidence(value, repo, candidate);
  if (registryDigest !== e.imageDigest)
    throw new Error("Registry digest differs from rehearsal evidence");
  async function pull(id: number, producer: string, merged: boolean, reviewedHead?: string) {
    const p = obj(await get(`pulls/${id}`));
    const base = obj(p.base);
    const head = obj(p.head);
    if (
      p.number !== id ||
      (merged && p.merged !== true) ||
      base.ref !== "main" ||
      obj(base.repo).full_name !== repo ||
      head.ref !== "release/next" ||
      obj(head.repo).full_name !== repo ||
      obj(p.user).type !== "Bot"
    )
      throw new Error("Rehearsal pull identity mismatch");
    const headSha = reviewedHead ?? str(head.sha, sha);
    if (reviewedHead) {
      const commits = await get(`pulls/${id}/commits?per_page=100`);
      if (
        !Array.isArray(commits) ||
        commits.length >= 100 ||
        !commits.some((commit: unknown) => obj(commit).sha === reviewedHead)
      )
        throw new Error("Recorded proposal head is unavailable in the PR history");
    }
    const reviewFile = obj(await get(`contents/.rolling-release/review.json?ref=${headSha}`));
    if (reviewFile.encoding !== "base64" || typeof reviewFile.content !== "string")
      throw new Error("Rehearsal review unavailable");
    const review = obj(JSON.parse(Buffer.from(reviewFile.content, "base64").toString("utf8")));
    if (review.producer !== producer || review.repository !== repo || review.branch !== "main")
      throw new Error("Rehearsal producer mismatch");
    return { pull: p, review };
  }
  const released = await pull(e.releasePr, e.candidate, true);
  if (
    released.pull.merge_commit_sha !== e.landing ||
    `v${String(released.review.version)}` !== e.version ||
    released.review.publishImage === false
  )
    throw new Error("Rehearsal landing or image policy mismatch");
  const old = await pull(e.oldPr, e.previous, true);
  const next = await pull(e.newPr, e.candidate, false, e.newHead);
  const trigger = obj(await get(`pulls/${e.newTriggerPr}`));
  if (
    trigger.number !== e.newTriggerPr ||
    trigger.merged !== true ||
    obj(trigger.base).ref !== "main" ||
    obj(obj(trigger.base).repo).full_name !== repo ||
    trigger.merge_commit_sha !== next.review.source
  )
    throw new Error("New proposal trigger mismatch");
  const advanced = obj(await get(`pulls/${e.afterPr}`));
  const advancedSha = str(advanced.merge_commit_sha, sha);
  if (
    advanced.number !== e.afterPr ||
    advanced.merged !== true ||
    obj(advanced.base).ref !== "main" ||
    obj(obj(advanced.base).repo).full_name !== repo ||
    advancedSha === e.landing ||
    obj(await get(`compare/${e.landing}...${advancedSha}`)).status !== "ahead"
  )
    throw new Error("Main did not advance after the release landing");
  const tag = obj(await get(`git/ref/tags/${e.version}`));
  if (obj(tag.object).type !== "commit" || obj(tag.object).sha !== e.landing)
    throw new Error("Rehearsal tag mismatch");
  const release = obj(await get(`releases/tags/${e.version}`));
  if (
    release.tag_name !== e.version ||
    release.name !== e.version ||
    release.body !== released.pull.body ||
    release.draft !== false ||
    release.prerelease !== false
  )
    throw new Error("Rehearsal release mismatch");
  const caller = (
    await readFile(new URL("../examples/release-cycle.yaml", import.meta.url), "utf8")
  ).replaceAll("@consumer-v1", "@consumer-rehearsal-v1");
  for (const [runId, conclusion, event, jobName, pr] of [
    [e.publication, "failure", "pull_request_target", "release / publish / publish", e.releasePr],
    [e.retry, "success", "workflow_dispatch", "release / publish / publish", e.releasePr],
    [e.oldReplay, "success", "pull_request_target", "release / publish / publish", e.oldPr],
    [e.freshCheck, "success", "pull_request", "proposal-check / proposal", e.newPr],
    [e.alteredCheck, "failure", "pull_request", "proposal-check / proposal", e.newPr],
    [
      e.newProposal,
      "success",
      "pull_request_target",
      "release / propose / propose",
      e.newTriggerPr,
    ],
  ] as const) {
    const run = obj(await get(`actions/runs/${runId}`));
    if (
      run.id !== runId ||
      run.status !== "completed" ||
      run.conclusion !== conclusion ||
      run.event !== event ||
      run.display_title !== `release:${pr}` ||
      !(
        run.path === ".github/workflows/rolling-release.yaml" ||
        String(run.path).startsWith(".github/workflows/rolling-release.yaml@")
      ) ||
      !Array.isArray(run.referenced_workflows) ||
      !run.referenced_workflows.some(
        (w: unknown) =>
          obj(w).sha === e.candidate &&
          obj(w).path ===
            `lhajoosten/rolling-release/.github/workflows/${event === "pull_request" ? "release-quality" : "release-cycle"}.yaml@consumer-rehearsal-v1`,
      )
    )
      throw new Error("Rehearsal run identity mismatch");
    const runHead = str(run.head_sha, sha);
    const associated =
      pr === e.releasePr
        ? released.pull
        : pr === e.oldPr
          ? old.pull
          : pr === e.newPr
            ? next.pull
            : trigger;
    if (
      event === "pull_request_target" &&
      (runHead !== obj(associated.head).sha ||
        run.head_branch !== obj(associated.head).ref ||
        associated.merged !== true)
    )
      throw new Error("Rehearsal event head mismatch");
    if (event === "pull_request" && (runHead !== e.newHead || run.head_branch !== "release/next"))
      throw new Error("Rehearsal proposal check head mismatch");
    if (event === "workflow_dispatch" && (run.head_branch !== "main" || runHead !== advancedSha))
      throw new Error("Rehearsal dispatch branch mismatch");
    const callerCommit =
      event === "workflow_dispatch"
        ? runHead
        : event === "pull_request"
          ? str(next.review.source, sha)
          : str(associated.merge_commit_sha, sha);
    const callerFile = obj(
      await get(`contents/.github/workflows/rolling-release.yaml?ref=${callerCommit}`),
    );
    if (
      callerFile.encoding !== "base64" ||
      typeof callerFile.content !== "string" ||
      Buffer.from(callerFile.content, "base64").toString("utf8") !== caller
    )
      throw new Error("Rehearsal caller differs from the reviewed template");
    const response = obj(await get(`actions/runs/${runId}/jobs?per_page=100`));
    if (
      !Array.isArray(response.jobs) ||
      response.total_count !== response.jobs.length ||
      !response.jobs.some(
        (job: unknown) => obj(job).name === jobName && obj(job).conclusion === conclusion,
      )
    )
      throw new Error("Rehearsal leaf job mismatch");
  }
  const pin = obj(await get(`actions/runs/${e.pinPreview}`));
  if (
    pin.id !== e.pinPreview ||
    pin.status !== "completed" ||
    pin.conclusion !== "success" ||
    pin.event !== "workflow_dispatch" ||
    pin.head_branch !== "main" ||
    pin.display_title !== "release:preview" ||
    !Array.isArray(pin.referenced_workflows) ||
    !pin.referenced_workflows.some(
      (w: unknown) =>
        obj(w).sha === e.candidate &&
        obj(w).path ===
          `lhajoosten/rolling-release/.github/workflows/release-cycle.yaml@${e.candidate}`,
    )
  )
    throw new Error("Immutable pin preview mismatch");
  const pinFile = obj(
    await get(`contents/.github/workflows/rolling-release.yaml?ref=${str(pin.head_sha, sha)}`),
  );
  const pinCaller = (
    await readFile(new URL("../examples/release-cycle.yaml", import.meta.url), "utf8")
  ).replaceAll("@consumer-v1", `@${e.candidate}`);
  if (
    pinFile.encoding !== "base64" ||
    typeof pinFile.content !== "string" ||
    Buffer.from(pinFile.content, "base64").toString("utf8") !== pinCaller
  )
    throw new Error("Immutable pin caller mismatch");
  const pinJobs = obj(await get(`actions/runs/${e.pinPreview}/jobs?per_page=100`));
  if (
    !Array.isArray(pinJobs.jobs) ||
    pinJobs.total_count !== pinJobs.jobs.length ||
    !pinJobs.jobs.some(
      (j: unknown) =>
        obj(j).name === "release / propose / propose" && obj(j).conclusion === "success",
    )
  )
    throw new Error("Immutable pin preview job mismatch");
}

async function main() {
  const repo = str(process.env.GITHUB_REPOSITORY, repository);
  const candidate = str(process.env.PROVIDER_SHA, sha);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Read token is required");
  const get: Get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub evidence request failed (${response.status})`);
    return response.json() as Promise<unknown>;
  };
  const evidence: unknown = JSON.parse(
    await readFile(process.env.REHEARSAL_EVIDENCE ?? "", "utf8"),
  );
  const parsed = parseEvidence(evidence, repo, candidate);
  const image = repo.toLowerCase();
  const registryCredential = process.env.GHCR_READ_TOKEN;
  const actor = process.env.GITHUB_ACTOR;
  const headers =
    registryCredential && actor
      ? {
          authorization: `Basic ${Buffer.from(`${actor}:${registryCredential}`).toString("base64")}`,
        }
      : {};
  const auth = await fetch(
    `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${image}:pull`)}`,
    { headers, redirect: "error" },
  );
  if (!auth.ok) throw new Error("Public registry authentication failed");
  const registryToken = str(obj(await auth.json()).token, /^\S+$/u);
  const manifest = await fetch(`https://ghcr.io/v2/${image}/manifests/${parsed.version}`, {
    headers: {
      authorization: `Bearer ${registryToken}`,
      accept:
        "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    },
    redirect: "error",
  });
  if (!manifest.ok) throw new Error("Registry manifest unavailable");
  const bytes = new Uint8Array(await manifest.arrayBuffer());
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (manifest.headers.get("docker-content-digest") !== hash)
    throw new Error("Registry digest header mismatch");
  const retained = await fetch(`https://ghcr.io/v2/${image}/manifests/sha-${parsed.landing}`, {
    headers: {
      authorization: `Bearer ${registryToken}`,
      accept:
        "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    },
    redirect: "error",
  });
  if (!retained.ok) throw new Error("Retained candidate image unavailable");
  const retainedBytes = new Uint8Array(await retained.arrayBuffer());
  if (
    `sha256:${createHash("sha256").update(retainedBytes).digest("hex")}` !== hash ||
    retained.headers.get("docker-content-digest") !== hash
  )
    throw new Error("Retained candidate digest mismatch");
  const configDigest = str(
    obj(obj(JSON.parse(Buffer.from(bytes).toString("utf8"))).config).digest,
    digest,
  );
  let config = await fetch(`https://ghcr.io/v2/${image}/blobs/${configDigest}`, {
    headers: { authorization: `Bearer ${registryToken}` },
    redirect: "manual",
  });
  if ([301, 302, 303, 307, 308].includes(config.status)) {
    const location = config.headers.get("location");
    if (!location) throw new Error("Registry config redirect missing");
    const target = new URL(location);
    if (
      target.protocol !== "https:" ||
      !target.hostname.endsWith(".githubusercontent.com") ||
      target.username ||
      target.password
    )
      throw new Error("Untrusted registry redirect");
    config = await fetch(target, { redirect: "error" });
  }
  if (!config.ok) throw new Error("Registry image config unavailable");
  const configBytes = new Uint8Array(await config.arrayBuffer());
  if (`sha256:${createHash("sha256").update(configBytes).digest("hex")}` !== configDigest)
    throw new Error("Registry image config digest mismatch");
  const configData = obj(JSON.parse(Buffer.from(configBytes).toString("utf8")));
  const labels = obj(obj(configData.config).Labels);
  if (
    configData.os !== "linux" ||
    configData.architecture !== "amd64" ||
    labels["org.opencontainers.image.source"] !== `https://github.com/${repo}` ||
    labels["org.opencontainers.image.revision"] !== parsed.landing ||
    labels["org.opencontainers.image.version"] !== parsed.version.slice(1)
  )
    throw new Error("Registry image identity mismatch");
  await verifyEvidence(evidence, repo, candidate, get, hash);
  console.log(
    "GitHub and current image digest verified; historical observations are operator-attested.",
  );
}
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Rehearsal verification failed");
    process.exitCode = 1;
  });
