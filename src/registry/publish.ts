import { gitEnvironment } from "../git.ts";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const mediaTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid registry response.");
  return value;
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Manifest {
  digest: string;
  bytes: Uint8Array;
  mediaType: string;
  configDigest: string;
}

async function login(config: string, actor: string, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["--config", config, "login", "ghcr.io", "-u", actor, "--password-stdin"],
      {
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: process.env.PATH },
      },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Registry login failed.")),
    );
    child.stdin.end(token);
  });
}

/** The caller must verify the reviewed release landing and serialize all version writers. */
export async function publishImage(
  root: string,
  repository: string,
  version: string,
  landing: string,
  recheck: () => Promise<void> = () => Promise.resolve(),
): Promise<string> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository) ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) ||
    !/^[a-f0-9]{40}$/u.test(landing)
  )
    throw new Error("Invalid image publication identity.");
  const token = process.env.GHCR_TOKEN;
  const actor = process.env.GITHUB_ACTOR;
  if (!token || !actor) throw new Error("GHCR_TOKEN and GITHUB_ACTOR are required.");
  const source = `https://github.com/${repository}`;
  const packageName = repository.toLowerCase();
  const image = `ghcr.io/${packageName}`;
  const endpoint = `https://ghcr.io/v2/${packageName}`;
  const authUrl = `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${packageName}:pull,push`)}`;
  const auth = await fetch(authUrl, {
    headers: { authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!auth.ok) throw new Error(`Registry authentication failed (${auth.status}).`);
  const registryToken = object(await auth.json()).token;
  if (typeof registryToken !== "string" || !registryToken)
    throw new Error("Registry token missing.");
  const headers = { authorization: `Bearer ${registryToken}`, accept: mediaTypes.join(", ") };
  const get = async (reference: string): Promise<Manifest | null> => {
    const response = await fetch(`${endpoint}/manifests/${reference}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) {
      const error = object(await response.json());
      if (
        Array.isArray(error.errors) &&
        error.errors.length > 0 &&
        error.errors.every((item: unknown) =>
          ["MANIFEST_UNKNOWN", "NAME_UNKNOWN"].includes(String(object(item).code)),
        )
      )
        return null;
    }
    if (!response.ok) throw new Error(`Registry manifest read failed (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = hash(bytes);
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!mediaTypes.includes(mediaType) || response.headers.get("docker-content-digest") !== digest)
      throw new Error("Invalid registry manifest digest or type.");
    const manifest = object(JSON.parse(Buffer.from(bytes).toString("utf8")));
    const configDigest = object(manifest.config).digest;
    if (
      manifest.schemaVersion !== 2 ||
      typeof configDigest !== "string" ||
      !digestPattern.test(configDigest)
    )
      throw new Error("Invalid image config descriptor.");
    const configResponse = await fetch(`${endpoint}/blobs/${configDigest}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    let config = configResponse;
    if ([301, 302, 303, 307, 308].includes(config.status)) {
      const location = config.headers.get("location");
      if (!location) throw new Error("Missing image config redirect.");
      const target = new URL(location);
      if (
        target.protocol !== "https:" ||
        !target.hostname.endsWith(".githubusercontent.com") ||
        target.username ||
        target.password
      )
        throw new Error("Untrusted image config redirect.");
      config = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(30000) });
    }
    if (!config.ok) throw new Error(`Registry config read failed (${config.status}).`);
    const configBytes = new Uint8Array(await config.arrayBuffer());
    if (hash(configBytes) !== configDigest) throw new Error("Image config digest mismatch.");
    const data = object(JSON.parse(Buffer.from(configBytes).toString("utf8")));
    const labels = object(object(data.config).Labels);
    if (
      data.os !== "linux" ||
      data.architecture !== "amd64" ||
      labels["org.opencontainers.image.source"] !== source ||
      labels["org.opencontainers.image.revision"] !== landing ||
      labels["org.opencontainers.image.version"] !== version.slice(1)
    )
      throw new Error("Conflicting image source, revision, version or platform.");
    return { digest, bytes, mediaType, configDigest };
  };
  const providerGate = async (reference: string, pull: boolean): Promise<void> => {
    if (packageName !== "lhajoosten/rolling-release") return;
    const scanner = process.env.ROLLING_RELEASE_SCAN_SCRIPT;
    const reports = process.env.ROLLING_RELEASE_SCAN_OUTPUT;
    if (!scanner || !reports)
      throw new Error("Provider image smoke and scan gate is not configured.");
    const directory = await mkdtemp(join(tmpdir(), "rolling-release-gate-"));
    try {
      if (pull) {
        await login(directory, actor, token);
        await exec(
          "docker",
          ["--config", directory, "pull", "--platform", "linux/amd64", reference],
          { env: { PATH: process.env.PATH }, maxBuffer: 8 * 1024 * 1024 },
        );
      }
      for (const argument of ["--version", "--help"])
        await exec("docker", ["run", "--rm", "--network", "none", reference, argument], {
          env: { PATH: process.env.PATH },
          maxBuffer: 1024 * 1024,
        });
      await exec(process.execPath, [scanner, "--image", reference, "--output", reports], {
        env: { PATH: process.env.PATH },
        timeout: 900000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const candidateTag = `sha-${landing}`;
  let candidate = await get(candidateTag);
  const published = await get(version);
  if (candidate) await providerGate(`${image}@${candidate.digest}`, true);
  if (published) {
    if (!candidate || candidate.digest !== published.digest)
      throw new Error("Conflicting image version or missing retained candidate.");
    return published.digest;
  }
  if (!candidate) {
    const directory = await mkdtemp(join(tmpdir(), "rolling-release-image-"));
    try {
      const context = join(directory, "context");
      await exec("mkdir", ["-p", context]);
      const archive = await exec("git", ["archive", "--format=tar", landing], {
        cwd: root,
        env: gitEnvironment(),
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
      });
      const archivePath = join(directory, "source.tar");
      await writeFile(archivePath, archive.stdout);
      await exec("tar", ["-xf", archivePath, "-C", context]);
      const dockerfile = await stat(join(context, "Dockerfile")).then(
        () => "Dockerfile",
        () => "container/Dockerfile",
      );
      await exec(
        "docker",
        [
          "build",
          "--platform",
          "linux/amd64",
          "--build-arg",
          `TOOL_VERSION=${version.slice(1)}`,
          "--build-arg",
          `SOURCE_REVISION=${landing}`,
          "--build-arg",
          `SOURCE_URL=${source}`,
          "--label",
          `org.opencontainers.image.source=${source}`,
          "--label",
          `org.opencontainers.image.revision=${landing}`,
          "--label",
          `org.opencontainers.image.version=${version.slice(1)}`,
          "-f",
          join(context, dockerfile),
          "-t",
          `${image}:${candidateTag}`,
          context,
        ],
        { env: { PATH: process.env.PATH }, maxBuffer: 8 * 1024 * 1024 },
      );
      const inspection = await exec(
        "docker",
        ["image", "inspect", "--format", "{{json .}}", `${image}:${candidateTag}`],
        { env: { PATH: process.env.PATH }, maxBuffer: 1024 * 1024 },
      );
      const local = object(JSON.parse(inspection.stdout));
      const localLabels = object(object(local.Config).Labels);
      if (
        typeof local.Id !== "string" ||
        !digestPattern.test(local.Id) ||
        local.Os !== "linux" ||
        local.Architecture !== "amd64" ||
        localLabels["org.opencontainers.image.source"] !== source ||
        localLabels["org.opencontainers.image.revision"] !== landing ||
        localLabels["org.opencontainers.image.version"] !== version.slice(1)
      )
        throw new Error("Built candidate image identity does not match the reviewed release.");
      await providerGate(`${image}:${candidateTag}`, false);
      const raced = await get(candidateTag);
      if (raced) {
        candidate = raced;
        await providerGate(`${image}@${candidate.digest}`, true);
      } else {
        const config = join(directory, "docker");
        await exec("mkdir", ["-p", config]);
        await recheck();
        await login(config, actor, token);
        await exec(
          "docker",
          ["--config", config, "push", "--platform", "linux/amd64", `${image}:${candidateTag}`],
          { env: { PATH: process.env.PATH }, maxBuffer: 8 * 1024 * 1024 },
        );
        candidate = await get(candidateTag);
        if (!candidate) throw new Error("Candidate push not confirmed; inspect before retrying.");
        if (candidate.configDigest !== local.Id)
          throw new Error("Published candidate differs from the validated local image.");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const racedVersion = await get(version);
  if (racedVersion) {
    if (racedVersion.digest !== candidate.digest) throw new Error("Conflicting image version.");
    return racedVersion.digest;
  }
  const retained = await get(candidateTag);
  if (!retained || retained.digest !== candidate.digest)
    throw new Error("Candidate changed before publication.");
  await recheck();
  const put = await fetch(`${endpoint}/manifests/${version}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${registryToken}`, "content-type": candidate.mediaType },
    body: Buffer.from(candidate.bytes),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (put.status !== 201 || put.headers.get("docker-content-digest") !== candidate.digest)
    throw new Error("Image version write uncertain; inspect before retrying.");
  const result = await get(version);
  if (!result || result.digest !== candidate.digest)
    throw new Error("Image version readback mismatch.");
  return result.digest;
}
