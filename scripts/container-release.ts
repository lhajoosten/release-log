import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const repository = "ghcr.io/lhajoosten/release-log";
export const source = "https://github.com/lhajoosten/release-log";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an image metadata object.");
  return value;
}

export function validateRelease(
  tag: string,
  version: unknown,
  sha: string,
  head: string,
  tagged: string,
) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag))
    throw new Error("Require a stable vMAJOR.MINOR.PATCH tag.");
  if (version !== tag.slice(1)) throw new Error("Package version does not match release tag.");
  if (!/^[a-f0-9]{40}$/u.test(sha) || head !== sha || tagged !== sha)
    throw new Error("Checkout, event source and peeled release tag must agree.");
}

export function checkImage(value: unknown, tag: string, sha: string) {
  const image = record(value);
  const labels = record(record(image.config).Labels);
  if (
    image.os !== "linux" ||
    image.architecture !== "amd64" ||
    labels["org.opencontainers.image.version"] !== tag.slice(1) ||
    labels["org.opencontainers.image.revision"] !== sha ||
    labels["org.opencontainers.image.source"] !== source
  )
    throw new Error("Conflicting release image: platform, version or source identity differs.");
}

// Only a verified registry 404 is absence. Authentication, network and malformed responses fail closed.
export async function readPublication(tag: string, token: string, request: typeof fetch = fetch) {
  async function get(path: string, missing = false) {
    let response = await request(`https://ghcr.io/v2/lhajoosten/release-log/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    // Blob storage may redirect to signed CDN URLs. Never forward the registry bearer token.
    if (path.startsWith("blobs/") && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing registry blob redirect.");
      const url = new URL(location);
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".githubusercontent.com") ||
        url.username ||
        url.password
      )
        throw new Error("Unexpected registry blob redirect.");
      response = await request(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    }
    if (response.status === 404 && missing) {
      const body = record(await response.json());
      if (
        Array.isArray(body.errors) &&
        body.errors.length > 0 &&
        body.errors.every((item: unknown) =>
          ["MANIFEST_UNKNOWN", "NAME_UNKNOWN"].includes(String(record(item).code)),
        )
      )
        return null;
    }
    if (!response.ok) throw new Error(`Registry read failed (${response.status}).`);
    return response;
  }
  const response = await get(`manifests/${tag}`, true);
  if (!response) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (response.headers.get("docker-content-digest") !== digest)
    throw new Error("Registry manifest digest mismatch.");
  const manifest = record(JSON.parse(bytes.toString("utf8")));
  const configDigest = record(manifest.config).digest;
  if (
    manifest.schemaVersion !== 2 ||
    typeof configDigest !== "string" ||
    !digestPattern.test(configDigest)
  )
    throw new Error("Expected a single-platform image manifest with SHA-256 config.");
  const config = await get(`blobs/${configDigest}`);
  if (!config) throw new Error("Missing image config.");
  const configBytes = Buffer.from(await config.arrayBuffer());
  if (`sha256:${createHash("sha256").update(configBytes).digest("hex")}` !== configDigest)
    throw new Error("Registry config digest mismatch.");
  return { digest, configDigest, image: JSON.parse(configBytes.toString("utf8")) as unknown };
}

export async function publicationDecision(
  tag: string,
  sha: string,
  token: string,
  request: typeof fetch = fetch,
) {
  const existing = await readPublication(tag, token, request);
  if (existing) checkImage(existing.image, tag, sha);
  return existing;
}

type Publication = Awaited<ReturnType<typeof readPublication>>;
type Run = (file: string, args: string[], authenticated?: boolean) => Promise<string>;

export async function reconcilePublication(
  tag: string,
  sha: string,
  current: () => Promise<Publication>,
  run: Run,
  scanEvidence: () => Promise<unknown>,
) {
  const existing = await current();
  if (existing) checkImage(existing.image, tag, sha);
  const image = `${repository}:${tag}`;
  let result = existing;
  if (existing) {
    const pinned = `${repository}@${existing.digest}`;
    await run("docker", ["pull", "--platform", "linux/amd64", pinned], true);
    // The retained image, rather than a fresh non-reproducible rebuild, must pass today's gates.
    await run("pnpm", ["check:container", "--image", pinned]);
    await run("pnpm", [
      "container:scan",
      "--image",
      pinned,
      "--output",
      "reports/container-release/reused-scan",
    ]);
  } else {
    const local = "release-log-candidate:release";
    const id = await run("docker", ["image", "inspect", "--format", "{{.Id}}", local]);
    if (!digestPattern.test(id)) throw new Error("Invalid candidate image ID.");
    const scan = record(await scanEvidence());
    if (
      scan.imageId !== id ||
      scan.blocked !== false ||
      typeof scan.configDigest !== "string" ||
      !digestPattern.test(scan.configDigest)
    )
      throw new Error("Candidate lacks passing vulnerability evidence for its exact image ID.");
    // Verify candidate metadata before its first write; prior workflow steps gate this exact ID.
    const inspected = record(
      JSON.parse(await run("docker", ["image", "inspect", "--format", "{{json .}}", id])),
    );
    checkImage(
      { os: inspected.Os, architecture: inspected.Architecture, config: inspected.Config },
      tag,
      sha,
    );
    await run("docker", ["tag", id, image]);
    // Recheck immediately before writing; workflow concurrency serializes all approved writers.
    const beforePush = await current();
    if (beforePush) throw new Error("Release appeared during preparation; rerun to reconcile.");
    await run("docker", ["push", "--platform", "linux/amd64", image], true);
    result = await current();
    if (result) checkImage(result.image, tag, sha);
    if (!result || result.configDigest !== scan.configDigest)
      throw new Error("Published config differs from verified candidate.");
  }
  if (!result) throw new Error("Missing publication result.");
  const final = await current();
  if (final) checkImage(final.image, tag, sha);
  if (!final || final.digest !== result.digest)
    throw new Error("Release tag changed during publication.");
  return { existing, result, image };
}

async function git(ref: string) {
  return (await execute("git", ["rev-parse", ref])).stdout.trim();
}

async function main() {
  const tag = process.env.RELEASE_TAG ?? "";
  const sha = process.env.RELEASE_SHA ?? "";
  const manifest = record(JSON.parse(await readFile("package.json", "utf8")));
  await Promise.all([git("HEAD"), git(`refs/tags/${tag}^{commit}`)]).then(([head, tagged]) =>
    validateRelease(tag, manifest.version, sha, head, tagged),
  );
  if (process.argv[2] === "validate" && process.argv.length === 3) return;
  if (process.argv[2] !== "publish" || process.argv.length !== 3)
    throw new Error("Usage: pnpm container:release validate|publish");
  const credential = process.env.GHCR_TOKEN;
  const actor = process.env.GHCR_ACTOR;
  if (!credential || !actor) throw new Error("Publication requires step-local GHCR credentials.");
  async function current() {
    const auth = await fetch(
      "https://ghcr.io/token?service=ghcr.io&scope=repository:lhajoosten/release-log:pull,push",
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${actor}:${credential}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      },
    );
    if (!auth.ok) throw new Error(`Registry authentication failed (${auth.status}).`);
    const token = record(await auth.json()).token;
    if (typeof token !== "string" || !token) throw new Error("Missing registry bearer token.");
    return publicationDecision(tag, sha, token);
  }
  const directory = await mkdtemp(join(tmpdir(), "release-publish-"));
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME };
  async function run(file: string, args: string[], authenticated = false) {
    // Never print subprocess errors: Docker errors can include registry response bodies.
    try {
      const result = await execute(file, args, {
        env: { ...environment, ...(authenticated ? { DOCKER_CONFIG: directory } : {}) },
        timeout: 1_200_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (!authenticated) process.stdout.write(result.stdout);
      return result.stdout.trim();
    } catch {
      throw new Error(`${file} ${args[0]} failed; publication stopped.`);
    }
  }
  try {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        auths: { "ghcr.io": { auth: Buffer.from(`${actor}:${credential}`).toString("base64") } },
      }),
      { mode: 0o600 },
    );
    const { existing, result, image } = await reconcilePublication(
      tag,
      sha,
      current,
      run,
      async () =>
        JSON.parse(
          await readFile("reports/container-release/candidate-scan/evidence.json", "utf8"),
        ) as unknown,
    );
    const evidence = {
      image,
      digestReference: `${repository}@${result.digest}`,
      source,
      revision: sha,
      version: tag.slice(1),
      platform: "linux/amd64",
      configDigest: result.configDigest,
      reused: existing !== null,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    };
    await mkdir("reports/container-release", { recursive: true });
    await writeFile(
      "reports/container-release/publication.json",
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Published/retained \`${evidence.digestReference}\`\n\nSource: \`${sha}\`; tag: \`${tag}\`; reused: ${evidence.reused}\n`,
      );
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
