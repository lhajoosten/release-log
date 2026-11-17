import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { copyLatestManifest, reconcileLatestAlias, source } from "../scripts/container-release.ts";

const sha = "a".repeat(40);
function publication(version = "1.2.3", revision = sha) {
  const image = {
    os: "linux",
    architecture: "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.source": source,
      },
    },
  };
  return {
    image,
    configDigest: `sha256:${"c".repeat(64)}`,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(image)).digest("hex")}`,
  };
}

void test("latest is the exact verified release digest and retry does not write", async () => {
  const published = publication();
  let latest: ReturnType<typeof publication> | null = null;
  let writes = 0;
  const copy = async () => {
    writes++;
    latest = published;
  };
  const run = () =>
    reconcileLatestAlias(
      "v1.2.3",
      sha,
      published,
      async () => latest,
      async () => published,
      copy,
    );
  assert.equal((await run()).outcome, "updated");
  assert.equal(latest, published);
  assert.equal((await run()).outcome, "unchanged");
  assert.equal(writes, 1);
});

void test("older events retain newer latest; equal-version conflicts and untrusted labels fail", async () => {
  const published = publication();
  const newer = publication("1.3.0");
  const run = (latest: ReturnType<typeof publication>) =>
    reconcileLatestAlias(
      "v1.2.3",
      sha,
      published,
      async () => latest,
      async () => published,
      async () => {
        throw new Error("must not write");
      },
    );
  assert.equal((await run(newer)).outcome, "retained-newer");
  await assert.rejects(run(publication("1.2.3", "b".repeat(40))), /conflicts/u);
  for (const version of ["latest", "01.2.3", "1.2.3-rc.1"])
    await assert.rejects(run(publication(version)), /invalid version/u);
  const wrong = publication("1.1.0");
  wrong.image.config.Labels["org.opencontainers.image.source"] = "https://evil.invalid";
  await assert.rejects(run(wrong), /Conflicting release image/u);
});

void test("a newer latest appearing during preparation is retained", async () => {
  const published = publication();
  let reads = 0;
  let writes = 0;
  const result = await reconcileLatestAlias(
    "v1.2.3",
    sha,
    published,
    async () => (++reads === 1 ? null : publication("2.0.0")),
    async () => published,
    async () => {
      writes++;
    },
  );
  assert.equal(result.outcome, "retained-newer");
  assert.equal(writes, 0);
});

void test("missing or changed version publications and failed alias writes stop without rewriting version tags", async () => {
  const published = publication();
  let writes = 0;
  for (const version of [null, publication("1.2.4")])
    await assert.rejects(
      reconcileLatestAlias(
        "v1.2.3",
        sha,
        published,
        async () => null,
        async () => version,
        async () => {
          writes++;
        },
      ),
      /Version tag changed/u,
    );
  assert.equal(writes, 0);
  await assert.rejects(
    reconcileLatestAlias(
      "v1.2.3",
      sha,
      published,
      async () => null,
      async () => published,
      async () => {
        throw new Error("uncertain PUT");
      },
    ),
    /uncertain PUT/u,
  );
  await assert.rejects(
    reconcileLatestAlias(
      "v1.2.3",
      sha,
      published,
      async () => null,
      async () => published,
      async () => {},
    ),
    /Latest digest differs/u,
  );
});

void test("manifest aliasing copies identical bytes and only PUTs latest", async () => {
  const body = JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${"c".repeat(64)}` } });
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const calls: { url: string; method: string }[] = [];
  await copyLatestManifest(digest, "synthetic", async (input, options) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = options?.method ?? "GET";
    calls.push({ url, method });
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer synthetic");
    if (method === "GET")
      return new Response(body, {
        headers: {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": digest,
        },
      });
    assert.equal(options?.body, body);
    assert.equal(
      new Headers(options?.headers).get("Content-Type"),
      "application/vnd.oci.image.manifest.v1+json",
    );
    return new Response(null, { status: 201, headers: { "docker-content-digest": digest } });
  });
  assert.deepEqual(calls, [
    { url: `https://ghcr.io/v2/lhajoosten/release-log/manifests/${digest}`, method: "GET" },
    { url: "https://ghcr.io/v2/lhajoosten/release-log/manifests/latest", method: "PUT" },
  ]);
  for (const failure of [403, 429, 500, 307])
    await assert.rejects(
      copyLatestManifest(digest, "synthetic", async () => new Response(null, { status: failure })),
      /read failed/u,
    );
  await assert.rejects(
    copyLatestManifest(
      digest,
      "synthetic",
      async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "docker-content-digest": digest,
          },
        }),
    ),
    /manifest bytes/u,
  );
});

void test("an older alias advances and an uncertain successful promotion is not repeated", async () => {
  const published = publication();
  let latest = publication("1.2.2");
  let writes = 0;
  const run = () =>
    reconcileLatestAlias(
      "v1.2.3",
      sha,
      published,
      async () => latest,
      async () => published,
      async () => {
        latest = published;
        writes++;
        throw new Error("lost response");
      },
    );
  await assert.rejects(run(), /lost response/u);
  assert.equal((await run()).outcome, "unchanged");
  assert.equal(writes, 1);
});

void test("latest manifest PUT failures and bad acknowledgements are uncertain, with no automatic retry", async () => {
  const body = '{"schemaVersion":2}';
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  for (const status of [403, 429, 500, 201]) {
    let writes = 0;
    await assert.rejects(
      copyLatestManifest(digest, "synthetic", async (_url, options) => {
        if (options?.method !== "PUT")
          return new Response(body, {
            headers: {
              "content-type": "application/vnd.oci.image.manifest.v1+json",
              "docker-content-digest": digest,
            },
          });
        writes++;
        return new Response(null, { status });
      }),
      /uncertain result/u,
    );
    assert.equal(writes, 1);
  }
});
