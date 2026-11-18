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
      "--allow-openssl-backport",
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

function imageVersion(publication: NonNullable<Publication>): string {
  const labels = record(record(record(publication.image).config).Labels);
  const version = labels["org.opencontainers.image.version"];
  const revision = labels["org.opencontainers.image.revision"];
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) ||
    version.length > 128 ||
    typeof revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(revision)
  )
    throw new Error("Latest image has invalid version or source labels.");
  checkImage(publication.image, `v${version}`, revision);
  return version;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (const index of [0, 1, 2]) {
    const x = a[index];
    const y = b[index];
    if (x === undefined || y === undefined) throw new Error("Invalid stable image version.");
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export async function copyLatestManifest(
  digest: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!digestPattern.test(digest)) throw new Error("Invalid latest source digest.");
  const url = `https://ghcr.io/v2/lhajoosten/release-log/manifests/`;
  const types = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
  ];
  const response = await request(url + digest, {
    headers: { Authorization: `Bearer ${token}`, Accept: types.join(", ") },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Latest manifest read failed (${response.status}).`);
  const body = await response.text();
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (
    !mediaType ||
    !types.includes(mediaType) ||
    record(JSON.parse(body)).schemaVersion !== 2 ||
    `sha256:${createHash("sha256").update(body).digest("hex")}` !== digest ||
    response.headers.get("docker-content-digest") !== digest
  )
    throw new Error("Latest manifest bytes or media type differ from the verified publication.");
  // Copy the exact manifest, preserving its digest; do not rebuild or create an index.
  const written = await request(url + "latest", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mediaType },
    body,
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (written.status !== 201 || written.headers.get("docker-content-digest") !== digest)
    throw new Error(
      "Latest manifest write failed or has an uncertain result; inspect and retry from registry state.",
    );
}

export async function reconcileLatestAlias(
  tag: string,
  sha: string,
  publication: NonNullable<Publication>,
  currentLatest: () => Promise<Publication>,
  currentVersion: () => Promise<Publication>,
  copy: () => Promise<void>,
) {
  if (!digestPattern.test(publication.digest))
    throw new Error("Invalid verified publication digest.");
  checkImage(publication.image, tag, sha);
  const version = imageVersion(publication);
  const decision = (latest: Publication) => {
    if (!latest) return "update" as const;
    const compared = compareVersions(imageVersion(latest), version);
    if (compared > 0) return "retained-newer" as const;
    if (compared === 0) {
      if (latest.digest !== publication.digest)
        throw new Error("Latest conflicts with the immutable version publication.");
      return "unchanged" as const;
    }
    return "update" as const;
  };
  const result = (
    outcome: "updated" | "unchanged" | "retained-newer",
    latest: NonNullable<Publication>,
  ) => ({
    outcome,
    image: `${repository}:latest`,
    digest: latest.digest,
    version: imageVersion(latest),
  });
  let latest = await currentLatest();
  let outcome = decision(latest);
  if (latest && outcome !== "update") return result(outcome, latest);
  const versionBefore = await currentVersion();
  if (!versionBefore || versionBefore.digest !== publication.digest)
    throw new Error("Version tag changed before latest promotion.");
  checkImage(versionBefore.image, tag, sha);
  latest = await currentLatest();
  outcome = decision(latest);
  if (latest && outcome !== "update") return result(outcome, latest);
  await copy();
  const after = await currentLatest();
  if (!after || after.digest !== publication.digest)
    throw new Error("Latest digest differs after promotion; inspect before retrying.");
  checkImage(after.image, tag, sha);
  const versionAfter = await currentVersion();
  if (!versionAfter || versionAfter.digest !== publication.digest)
    throw new Error("Version tag changed during latest promotion.");
  checkImage(versionAfter.image, tag, sha);
  return result("updated", after);
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
  async function registryToken() {
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
    return token;
  }
  const current = async () => publicationDecision(tag, sha, await registryToken());
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
    const latest = await reconcileLatestAlias(
      tag,
      sha,
      result,
      async () => readPublication("latest", await registryToken()),
      current,
      async () => copyLatestManifest(result.digest, await registryToken()),
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
      latest,
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
        `Published/retained \`${evidence.digestReference}\`\n\nSource: \`${sha}\`; tag: \`${tag}\`; reused: ${evidence.reused}\n\nLatest: ${latest.outcome} at \`${latest.digest}\`\n`,
      );
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
