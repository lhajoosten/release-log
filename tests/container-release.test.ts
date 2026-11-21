import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { archiveConfigPath } from "../scripts/scan-container.ts";
import {
  checkImage,
  publicationDecision,
  readPublication,
  reconcilePublication,
  source,
  validateRelease,
} from "../scripts/container-release.ts";

function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : input.toString();
}

const sha = "a".repeat(40);
const image = {
  os: "linux",
  architecture: "amd64",
  config: {
    Labels: {
      "org.opencontainers.image.version": "1.2.3",
      "org.opencontainers.image.revision": sha,
      "org.opencontainers.image.source": source,
    },
  },
};
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function registry(config: unknown = image): typeof fetch {
  const blob = JSON.stringify(config);
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: digest(blob) } });
  return async (url, options) => {
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer synthetic");
    assert.equal(options?.redirect, "manual");
    const body = requestUrl(url).includes("/manifests/") ? manifest : blob;
    return new Response(body, { headers: { "docker-content-digest": digest(body) } });
  };
}

void test("only stable canonical tags with matching manifest, peeled tag and event SHA qualify", () => {
  validateRelease("v1.2.3", "1.2.3", sha, sha, sha);
  validateRelease("v0.0.0", "0.0.0", sha, sha, sha);
  for (const tag of ["v01.2.3", "1.2.3", "v1.2.3-rc.1", "v1.2.3+build", "v1.2", "v1.2.3\n"])
    assert.throws(() => validateRelease(tag, tag.slice(1), sha, sha, sha));
  assert.throws(() => validateRelease("v1.2.3", "1.2.4", sha, sha, sha), /version/u);
  for (const values of [
    [sha, "b".repeat(40), sha],
    [sha, sha, "b".repeat(40)],
    ["bad", "bad", "bad"],
  ]) {
    const [event = "", head = "", tagged = ""] = values;
    assert.throws(() => validateRelease("v1.2.3", "1.2.3", event, head, tagged), /agree/u);
  }
});

void test("matching registry publication is retained by digest; different source, version or platform conflicts", async () => {
  const retained = await publicationDecision("v1.2.3", sha, "synthetic", registry());
  assert.ok(retained);
  assert.ok(retained.digest.startsWith("sha256:"));
  assert.equal(retained.configDigest, digest(JSON.stringify(image)));
  for (const candidate of [
    { ...image, architecture: "arm64" },
    { ...image, os: "windows" },
    { ...image, config: { Labels: {} } },
    {
      ...image,
      config: {
        Labels: { ...image.config.Labels, "org.opencontainers.image.revision": "b".repeat(40) },
      },
    },
    {
      ...image,
      config: { Labels: { ...image.config.Labels, "org.opencontainers.image.version": "1.2.4" } },
    },
    {
      ...image,
      config: {
        Labels: {
          ...image.config.Labels,
          "org.opencontainers.image.source": "https://example.invalid",
        },
      },
    },
  ])
    await assert.rejects(
      publicationDecision("v1.2.3", sha, "synthetic", registry(candidate)),
      /Conflicting/u,
    );
  assert.throws(() => checkImage({}, "v1.2.3", sha));
});

void test("only explicit registry absence permits a first push; auth, outages and ambiguous 404s fail closed", async () => {
  for (const code of ["MANIFEST_UNKNOWN", "NAME_UNKNOWN"]) {
    assert.equal(
      await readPublication(
        "v1.2.3",
        "synthetic",
        async () => new Response(JSON.stringify({ errors: [{ code }] }), { status: 404 }),
      ),
      null,
    );
  }
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      readPublication("v1.2.3", "synthetic", async () => new Response("failure", { status })),
      /Registry read failed/u,
    );
  for (const body of ["not JSON", "{}", '{"errors":[]}', '{"errors":[{"code":"DENIED"}]}'])
    await assert.rejects(
      readPublication("v1.2.3", "synthetic", async () => new Response(body, { status: 404 })),
    );
  await assert.rejects(
    readPublication("v1.2.3", "synthetic", async () => {
      throw new Error("offline");
    }),
    /offline/u,
  );
});

void test("reject malformed or corrupted manifests/configs, including multi-platform indexes", async () => {
  for (const body of [
    "{}",
    '{"schemaVersion":2,"manifests":[]}',
    '{"schemaVersion":2,"config":{"digest":"bad"}}',
  ])
    await assert.rejects(
      readPublication(
        "v1.2.3",
        "synthetic",
        async () => new Response(body, { headers: { "docker-content-digest": digest(body) } }),
      ),
    );
  await assert.rejects(
    readPublication(
      "v1.2.3",
      "synthetic",
      async () =>
        new Response("{}", { headers: { "docker-content-digest": `sha256:${"f".repeat(64)}` } }),
    ),
    /digest mismatch/u,
  );
  const valid = registry();
  await assert.rejects(
    readPublication("v1.2.3", "synthetic", async (url, options) =>
      requestUrl(url).includes("/blobs/") ? new Response("{}") : valid(url, options),
    ),
    /config digest mismatch/u,
  );
});

void test("signed blob redirects carry no registry credential and reject unexpected destinations", async () => {
  const blob = JSON.stringify(image);
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: digest(blob) } });
  const calls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    calls.push(requestUrl(url));
    if (requestUrl(url).startsWith("https://pkg-containers.githubusercontent.com/")) {
      assert.equal(options?.headers, undefined);
      assert.equal(options?.redirect, "error");
      return new Response(blob);
    }
    if (requestUrl(url).includes("/manifests/"))
      return new Response(manifest, { headers: { "docker-content-digest": digest(manifest) } });
    return new Response(null, {
      status: 307,
      headers: {
        location: "https://pkg-containers.githubusercontent.com/blob?synthetic-signature",
      },
    });
  };
  assert.ok(await readPublication("v1.2.3", "synthetic", request));
  assert.equal(calls.length, 3);
  for (const location of [
    "http://pkg-containers.githubusercontent.com/blob",
    "https://example.invalid/blob",
    "https://githubusercontent.com.evil.invalid/blob",
    "https://user:pass@pkg-containers.githubusercontent.com/blob",
  ]) {
    await assert.rejects(
      readPublication("v1.2.3", "synthetic", async (url, options) =>
        requestUrl(url).includes("/manifests/")
          ? request(url, options)
          : new Response(null, { status: 307, headers: { location } }),
      ),
      /Unexpected registry blob redirect/u,
    );
  }
});

function harness() {
  const published = {
    digest: `sha256:${"b".repeat(64)}`,
    configDigest: digest(JSON.stringify(image)),
    image,
  };
  const calls: { file: string; args: string[]; authenticated: boolean }[] = [];
  async function run(file: string, args: string[], authenticated = false) {
    calls.push({ file, args, authenticated });
    if (args.includes("{{.Id}}")) return `sha256:${"c".repeat(64)}`;
    if (args.includes("{{json .}}"))
      return JSON.stringify({
        Os: image.os,
        Architecture: image.architecture,
        Config: image.config,
      });
    return "";
  }
  return {
    published,
    calls,
    run,
    scan: async () => ({
      imageId: `sha256:${"c".repeat(64)}`,
      configDigest: published.configDigest,
      blocked: false,
    }),
  };
}

void test("first publication pushes once and verifies the registry config against scanned candidate identity", async () => {
  const h = harness();
  let reads = 0;
  const result = await reconcilePublication(
    "v1.2.3",
    sha,
    async () => (++reads <= 2 ? null : h.published),
    h.run,
    h.scan,
  );
  assert.equal(result.existing, null);
  assert.equal(result.result.digest, h.published.digest);
  assert.deepEqual(
    h.calls.filter((call) => call.args[0] === "push"),
    [
      {
        file: "docker",
        args: ["push", "--platform", "linux/amd64", "ghcr.io/lhajoosten/release-log:v1.2.3"],
        authenticated: true,
      },
    ],
  );
  assert.ok(h.calls.filter((call) => call.args[0] !== "push").every((call) => !call.authenticated));
});

void test("retry pulls by digest, tests and scans retained config identity, and never pushes", async () => {
  const h = harness();
  const result = await reconcilePublication(
    "v1.2.3",
    sha,
    async () => h.published,
    h.run,
    async () => {
      throw new Error("must not inspect rebuilt candidate");
    },
  );
  assert.equal(result.result.digest, h.published.digest);
  assert.deepEqual(
    h.calls.map((call) => call.args[0]),
    ["pull", "check:container", "container:scan"],
  );
  assert.ok(h.calls[2]?.args.includes("--allow-openssl-backport"));
  assert.deepEqual(h.calls[0]?.args, [
    "pull",
    "--platform",
    "linux/amd64",
    `ghcr.io/lhajoosten/release-log@${h.published.digest}`,
  ]);
  assert.ok(
    h.calls
      .slice(1)
      .every(
        (call) =>
          call.args.includes(`ghcr.io/lhajoosten/release-log@${h.published.digest}`) &&
          !call.authenticated,
      ),
  );
});

void test("conflicts, uncertain reads and failed retained gates cannot cause a push", async () => {
  const h = harness();
  await assert.rejects(
    reconcilePublication("v1.2.3", "c".repeat(40), async () => h.published, h.run, h.scan),
    /Conflicting/u,
  );
  assert.equal(h.calls.length, 0);
  await assert.rejects(
    reconcilePublication(
      "v1.2.3",
      sha,
      async () => {
        throw new Error("registry unavailable");
      },
      h.run,
      h.scan,
    ),
    /registry unavailable/u,
  );
  assert.equal(h.calls.length, 0);
  for (const gate of ["check:container", "container:scan"]) {
    await assert.rejects(
      reconcilePublication(
        "v1.2.3",
        sha,
        async () => h.published,
        async (file, args, auth) => {
          if (args[0] === gate) throw new Error("gate failed");
          return h.run(file, args, auth);
        },
        h.scan,
      ),
      /gate failed/u,
    );
  }
  assert.ok(h.calls.every((call) => call.args[0] !== "push"));
});

void test("wrong scan identity, blocking scan and a release appearing before push stop without registry writes", async () => {
  for (const scan of [
    { imageId: "different", blocked: false },
    { imageId: digest(JSON.stringify(image)), blocked: true },
    {},
  ]) {
    const h = harness();
    await assert.rejects(
      reconcilePublication(
        "v1.2.3",
        sha,
        async () => null,
        h.run,
        async () => scan,
      ),
      /evidence/u,
    );
    assert.ok(h.calls.every((call) => call.args[0] !== "push"));
  }
  const h = harness();
  let reads = 0;
  await assert.rejects(
    reconcilePublication(
      "v1.2.3",
      sha,
      async () => (++reads === 1 ? null : h.published),
      h.run,
      h.scan,
    ),
    /appeared/u,
  );
  assert.ok(h.calls.every((call) => call.args[0] !== "push"));
});

void test("uncertain acknowledgement after push recovers on retry without replacing publication", async () => {
  const h = harness();
  let reads = 0;
  await assert.rejects(
    reconcilePublication(
      "v1.2.3",
      sha,
      async () => {
        if (++reads <= 2) return null;
        throw new Error("lost acknowledgement");
      },
      h.run,
      h.scan,
    ),
    /lost acknowledgement/u,
  );
  assert.equal(h.calls.filter((call) => call.args[0] === "push").length, 1);
  await reconcilePublication("v1.2.3", sha, async () => h.published, h.run, h.scan);
  assert.equal(h.calls.filter((call) => call.args[0] === "push").length, 1);
});

void test("post-push config and final digest mismatches cannot report success", async () => {
  for (const failure of ["config", "digest"]) {
    const h = harness();
    let reads = 0;
    await assert.rejects(
      reconcilePublication(
        "v1.2.3",
        sha,
        async () => {
          reads++;
          if (reads <= 2) return null;
          if (failure === "config")
            return { ...h.published, configDigest: `sha256:${"f".repeat(64)}` };
          return reads === 3 ? h.published : { ...h.published, digest: `sha256:${"f".repeat(64)}` };
        },
        h.run,
        h.scan,
      ),
      failure === "config" ? /config differs/u : /tag changed/u,
    );
  }
});

void test("archive identity accepts classic and OCI config paths and rejects ambiguous or unsafe paths", () => {
  for (const path of [`${"a".repeat(64)}.json`, `blobs/sha256/${"a".repeat(64)}`])
    assert.equal(archiveConfigPath([{ Config: path }]), path);
  for (const value of [
    [],
    [{ Config: "../../etc/passwd" }],
    [{ Config: "/absolute" }],
    [{ Config: "bad" }],
    [{ Config: "bad" }, { Config: "bad" }],
    {},
  ])
    assert.throws(() => archiveConfigPath(value));
});

void test("the self-release workflow reconciles only trusted main and keeps credentials step-local", async () => {
  const workflow: unknown = parse(
    await readFile(
      new URL("../.github/workflows/rolling-release-caller.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    typeof workflow === "object" &&
      workflow !== null &&
      "on" in workflow &&
      "permissions" in workflow &&
      "concurrency" in workflow &&
      "jobs" in workflow,
  );
  assert.deepEqual(workflow.on, {
    push: { branches: ["main"] },
    schedule: [{ cron: "19 */4 * * *" }],
    workflow_dispatch: null,
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "release-log-${{ github.repository }}-main",
    "cancel-in-progress": false,
  });
  assert.ok(
    typeof workflow.jobs === "object" && workflow.jobs !== null && "reconcile" in workflow.jobs,
  );
  const job = workflow.jobs.reconcile;
  assert.ok(
    typeof job === "object" &&
      job !== null &&
      "steps" in job &&
      Array.isArray(job.steps) &&
      "permissions" in job &&
      "if" in job,
  );
  assert.deepEqual(job.permissions, {
    contents: "write",
    packages: "write",
    "pull-requests": "read",
  });
  assert.ok("concurrency" in job);
  assert.deepEqual(job.concurrency, { group: "container-release", "cancel-in-progress": false });
  assert.match(String(job.if), /github.ref == 'refs\/heads\/main'/u);
  assert.match(String(job.if), /vars\.RELEASE_LOG_WRITE_ENABLED != 'false'/u);
  let credentialSteps = 0;
  for (const step of job.steps) {
    assert.ok(typeof step === "object" && step !== null);
    if ("uses" in step) {
      assert.match(String(step.uses), /@[a-f0-9]{40}$/u);
      if (String(step.uses).startsWith("actions/checkout@")) {
        assert.ok("with" in step && typeof step.with === "object" && step.with !== null);
        assert.equal(
          Object.getOwnPropertyDescriptor(step.with, "persist-credentials")?.value,
          false,
        );
      }
    }
    if ("env" in step && JSON.stringify(step.env).includes("github.token")) {
      credentialSteps++;
      assert.ok("run" in step);
      assert.match(String(step.run), /node tool\/scripts\/self-release.ts/u);
    }
  }
  assert.equal(credentialSteps, 1);
  await assert.rejects(
    readFile(new URL("../.github/workflows/container-release.yml", import.meta.url)),
    { code: "ENOENT" },
  );
});
