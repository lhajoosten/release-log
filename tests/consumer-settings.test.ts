import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateConsumerConfiguration, resolveConsumerSettings } from "../src/config/consumer.ts";
import { retryGitHubReads } from "../src/github-retry.ts";

const caller = { repository: "example/project", repositoryId: 17, releaseBranch: "main" };

void test("minimal consumers use the provider defaults, with no inferred bootstrap boundary", () => {
  const result = resolveConsumerSettings({}, caller);
  assert.deepEqual(result.configuration, {
    ...caller,
    schemaVersion: 1,
    releasePolicy: "release-policy-v2",
    contextPolicy: "required",
    githubRelease: true,
    changelog: { verbosity: "concise", format: "compact" },
  });
  assert.deepEqual(result.historical, []);
});

void test("moving reviewed inline settings to repository data preserves the exact captured configuration", () => {
  const bootstrap = { baselineSha: "a".repeat(40), onboardingSha: "b".repeat(40) };
  const legacy = {
    ...caller,
    schemaVersion: 2,
    releasePolicy: "release-policy-v1",
    bootstrap,
    changelog: { verbosity: "detailed" },
  };
  const inline = resolveConsumerSettings({}, caller, JSON.stringify(legacy));
  const moved = resolveConsumerSettings(
    {
      bootstrap,
      releasePolicy: "release-policy-v1",
      contextPolicy: null,
      githubRelease: false,
      changelog: { verbosity: "detailed", format: null },
    },
    caller,
  );
  assert.deepEqual(moved.configuration, inline.configuration);
  const generated = migrateConsumerConfiguration(inline.configuration);
  assert.deepEqual(resolveConsumerSettings(generated, caller).configuration, inline.configuration);

  const next = resolveConsumerSettings({ bootstrap, priorConfigurations: [legacy] }, caller);
  assert.deepEqual(next.historical, [inline.configuration]);
  assert.equal(next.configuration.releasePolicy, "release-policy-v2");
});

void test("consumer settings reject repository substitution, executable authority, and incomplete bootstrap", () => {
  for (const bad of [
    { repositoryId: 1 },
    { selfUpgrade: true },
    { internalPublication: true },
    { replayHistory: ["a".repeat(40)] },
    { bootstrap: { baselineSha: "a".repeat(40) } },
    { changelog: { format: "invalid" } },
  ])
    assert.throws(() => resolveConsumerSettings(bad, caller));
  assert.throws(
    () =>
      resolveConsumerSettings(
        {},
        caller,
        JSON.stringify({
          ...caller,
          repositoryId: 1,
          schemaVersion: 1,
          releasePolicy: "release-policy-v2",
        }),
      ),
    /must match the caller/u,
  );
});

void test("consumer transport retries temporary GET responses but never retries a failed write", async () => {
  let reads = 0;
  let writes = 0;
  const read = retryGitHubReads((_url, options) => {
    if (options.method === "GET") {
      reads++;
      return Promise.resolve(new Response(null, { status: reads === 1 ? 503 : 200 }));
    }
    writes++;
    return Promise.resolve(new Response(null, { status: 503 }));
  });
  assert.equal(
    (await read("https://api.github.com/repos/example/project", { method: "GET" })).status,
    200,
  );
  assert.equal(
    (await read("https://api.github.com/repos/example/project", { method: "POST" })).status,
    503,
  );
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});
