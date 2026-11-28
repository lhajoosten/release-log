import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { publishImage } from "../src/registry/publish.ts";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

void test("image publication rejects non-ASCII repository names", async () => {
  await assert.rejects(
    publishImage(".", "acme/\u212aelvin", "v1.3.0", "a".repeat(40)),
    /Invalid image publication identity/u,
  );
});

void test("retained candidate publishes exact manifest and retries without another write", async () => {
  const original = globalThis.fetch;
  const oldToken = process.env.GHCR_TOKEN;
  const oldActor = process.env.GITHUB_ACTOR;
  process.env.GHCR_TOKEN = "synthetic";
  process.env.GITHUB_ACTOR = "synthetic";
  const sha = "a".repeat(40);
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.source": "https://github.com/Acme/Widget",
        "org.opencontainers.image.revision": sha,
        "org.opencontainers.image.version": "1.3.0",
      },
    },
  });
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: digest(config) } });
  const manifestDigest = digest(manifest);
  let versionExists = false;
  let puts = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/token?")) {
      assert.equal(new URL(url).searchParams.get("scope"), "repository:acme/widget:pull,push");
      return Response.json({ token: "synthetic-bearer" });
    }
    assert.ok(url.startsWith("https://ghcr.io/v2/acme/widget/"));
    if (url.includes("/blobs/")) return new Response(config);
    if (init?.method === "PUT") {
      assert.ok(Buffer.isBuffer(init.body));
      assert.equal(init.body.toString("utf8"), manifest);
      puts++;
      versionExists = true;
      return new Response(null, {
        status: 201,
        headers: { "docker-content-digest": manifestDigest },
      });
    }
    if (url.endsWith("/v1.3.0") && !versionExists)
      return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
    return new Response(manifest, {
      headers: {
        "content-type": "application/vnd.oci.image.manifest.v1+json",
        "docker-content-digest": manifestDigest,
      },
    });
  };
  try {
    assert.equal(await publishImage(".", "Acme/Widget", "v1.3.0", sha), manifestDigest);
    assert.equal(await publishImage(".", "Acme/Widget", "v1.3.0", sha), manifestDigest);
    assert.equal(puts, 1);
  } finally {
    globalThis.fetch = original;
    if (oldToken === undefined) delete process.env.GHCR_TOKEN;
    else process.env.GHCR_TOKEN = oldToken;
    if (oldActor === undefined) delete process.env.GITHUB_ACTOR;
    else process.env.GITHUB_ACTOR = oldActor;
  }
});

for (const uncertain of [false, true])
  void test(`first push ${uncertain ? "with an uncertain response recovers" : "succeeds"} without rebuilding`, async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, writeFile, chmod, readFile, rm, access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const execute = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), "image-push-test-"));
    const repository = join(directory, "repo");
    const bin = join(directory, "bin");
    await execute("mkdir", ["-p", repository, bin]);
    await execute("git", ["init", "-q", repository]);
    await execute("git", ["-C", repository, "config", "user.name", "Test"]);
    await execute("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(repository, "Dockerfile"), "FROM scratch\n");
    await execute("git", ["-C", repository, "add", "Dockerfile"]);
    await execute("git", ["-C", repository, "commit", "-qm", "fixture"]);
    const sha = (await execute("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    const labels = {
      "org.opencontainers.image.source": "https://github.com/Acme/Widget",
      "org.opencontainers.image.revision": sha,
      "org.opencontainers.image.version": "1.3.0",
    };
    const config = JSON.stringify({
      os: "linux",
      architecture: "amd64",
      config: { Labels: labels },
    });
    const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: digest(config) } });
    const candidateFile = join(directory, "candidate");
    const log = join(directory, "calls");
    const inspect = JSON.stringify({
      Id: digest(config),
      Os: "linux",
      Architecture: "amd64",
      Config: { Labels: labels },
    });
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in\n  image) printf '%s\\n' '${inspect}' ;;\n  --config) case "$3" in login) cat >/dev/null ;; push) touch '${candidateFile}'; exit ${uncertain ? 1 : 0} ;; esac ;;\nesac\n`,
    );
    await chmod(join(bin, "docker"), 0o755);
    const previousFetch = globalThis.fetch;
    const previousPath = process.env.PATH;
    const previousToken = process.env.GHCR_TOKEN;
    const previousActor = process.env.GITHUB_ACTOR;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.GHCR_TOKEN = "synthetic";
    process.env.GITHUB_ACTOR = "synthetic";
    let versionExists = false;
    let writes = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/token?")) return Response.json({ token: "synthetic" });
      if (url.includes("/blobs/")) return new Response(config);
      if (init?.method === "PUT") {
        writes++;
        versionExists = true;
        return new Response(null, {
          status: 201,
          headers: { "docker-content-digest": digest(manifest) },
        });
      }
      const exists = url.endsWith(`/sha-${sha}`)
        ? await access(candidateFile).then(
            () => true,
            () => false,
          )
        : versionExists;
      if (!exists)
        return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
      return new Response(manifest, {
        headers: {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": digest(manifest),
        },
      });
    };
    try {
      if (uncertain) await assert.rejects(publishImage(repository, "Acme/Widget", "v1.3.0", sha));
      assert.equal(await publishImage(repository, "Acme/Widget", "v1.3.0", sha), digest(manifest));
      const commands = await readFile(log, "utf8");
      assert.match(commands, /SOURCE_URL=https:\/\/github\.com\/Acme\/Widget/u);
      assert.match(commands, /ghcr\.io\/acme\/widget:sha-/u);
      assert.equal(commands.split("\n").filter((line) => line.startsWith("build ")).length, 1);
      assert.equal(commands.split("\n").filter((line) => line.includes(" push ")).length, 1);
      assert.equal(writes, 1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousToken === undefined) delete process.env.GHCR_TOKEN;
      else process.env.GHCR_TOKEN = previousToken;
      if (previousActor === undefined) delete process.env.GITHUB_ACTOR;
      else process.env.GITHUB_ACTOR = previousActor;
      await rm(directory, { recursive: true, force: true });
    }
  });

void test("provider retained image must pass its smoke test before version publication", async () => {
  const { mkdtemp, mkdir, writeFile, chmod, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "provider-gate-test-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    '#!/bin/sh\nif [ "$3" = login ]; then cat >/dev/null; fi\nif [ "$1" = run ]; then test -f "$0.pass"; fi\n',
  );
  await chmod(join(bin, "docker"), 0o755);
  const pass = join(bin, "docker.pass");
  const old = {
    fetch: globalThis.fetch,
    path: process.env.PATH,
    token: process.env.GHCR_TOKEN,
    actor: process.env.GITHUB_ACTOR,
  };
  process.env.PATH = `${bin}:${old.path ?? ""}`;
  process.env.GHCR_TOKEN = "synthetic";
  process.env.GITHUB_ACTOR = "synthetic";
  const sha = "a".repeat(40);
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.source": "https://github.com/LHajoosten/Rolling-Release",
        "org.opencontainers.image.revision": sha,
        "org.opencontainers.image.version": "1.3.0",
      },
    },
  });
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: digest(config) } });
  let versionExists = false;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/token?")) return Response.json({ token: "synthetic" });
    if (url.includes("/blobs/")) return new Response(config);
    if (init?.method === "PUT") {
      writes++;
      versionExists = true;
      return new Response(null, {
        status: 201,
        headers: { "docker-content-digest": digest(manifest) },
      });
    }
    if (url.endsWith("/v1.3.0") && !versionExists)
      return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
    return new Response(manifest, {
      headers: {
        "content-type": "application/vnd.oci.image.manifest.v1+json",
        "docker-content-digest": digest(manifest),
      },
    });
  };
  try {
    await assert.rejects(publishImage(".", "LHajoosten/Rolling-Release", "v1.3.0", sha));
    assert.equal(writes, 0);
    await writeFile(pass, "ok");
    assert.equal(
      await publishImage(".", "LHajoosten/Rolling-Release", "v1.3.0", sha),
      digest(manifest),
    );
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = old.fetch;
    for (const [key, value] of Object.entries({
      PATH: old.path,
      GHCR_TOKEN: old.token,
      GITHUB_ACTOR: old.actor,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
