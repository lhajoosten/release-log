import assert from "node:assert/strict";
import { test } from "node:test";

import { renderChangelog } from "../src/changelog.ts";
import { createReleasePlan } from "../src/release-plan.ts";
import { validatePullRequestMetadata } from "../src/pr-readiness.ts";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const optional = { ...fixtureConfiguration, contextPolicy: "optional" } as const;
const required = { ...fixtureConfiguration, contextPolicy: "required" } as const;
const version = { kind: "released", currentVersion: "1.2.3" } as const;

async function source(body: string, breaking = false) {
  const fixture = await releaseFixture([
    {
      title: breaking ? "feat(api)!: remove old keys" : "feat(api): export <rows>",
      action: breaking ? "Supply new keys." : null,
      message: breaking
        ? "feat!: remove old keys\n\nBREAKING CHANGE: supply new keys"
        : "feat: export rows",
    },
  ]);
  return {
    ...fixture.snapshot.input,
    pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({ ...pull, body })),
  };
}

void test("trusted configuration preserves omission and rejects unknown context policies", () => {
  assert.deepEqual(parseReleaseInputConfiguration(fixtureConfiguration), fixtureConfiguration);
  assert.deepEqual(parseReleaseInputConfiguration(optional), optional);
  assert.deepEqual(parseReleaseInputConfiguration(required), required);
  for (const contextPolicy of [null, undefined, "", "OPTIONAL", "ignore", true, {}]) {
    assert.throws(
      () => parseReleaseInputConfiguration({ ...fixtureConfiguration, contextPolicy }),
      /Context policy must be required or optional/u,
    );
  }
});

void test("omission and explicit required reject absent context; optional preserves complete evidence", async () => {
  const input = await source("Ordinary surrounding Markdown without structured context.");
  for (const config of [fixtureConfiguration, required])
    await assert.rejects(captureReleaseSnapshot(input, config), { code: "metadata-invalid" });

  const snapshot = await captureReleaseSnapshot(input, optional);
  assert.deepEqual(snapshot.input, input);
  assert.deepEqual(
    snapshot.normalized.pullRequests.map((pull) => pull.number),
    [1],
  );
  const pull = snapshot.normalized.pullRequests[0];
  assert.ok(pull);
  assert.equal(pull.context, null);
  assert.equal(pull.rawBlock, null);
  assert.deepEqual(
    pull.validation.warnings.map((issue) => issue.code),
    ["block-missing"],
  );
  const serialized = await serializeReleaseSnapshot(snapshot);
  assert.deepEqual(await replayReleaseSnapshot(serialized, optional), snapshot);
  assert.equal(
    await serializeReleaseSnapshot(await replayReleaseSnapshot(serialized, optional)),
    serialized,
  );
  const plan = await createReleasePlan(serialized, optional, version);
  assert.equal(plan.nextVersion, "1.3.0");
  assert.equal(plan.contributions[0]?.type, "feat");
  await assert.rejects(replayReleaseSnapshot(serialized, required), {
    code: "configuration-mismatch",
  });
  await assert.rejects(replayReleaseSnapshot(serialized, fixtureConfiguration), {
    code: "configuration-mismatch",
  });
});

void test("valid context has the same normalized result under both policies; identities bind the choice", async () => {
  const fixture = await releaseFixture([{ title: "fix(api): retain keys", audience: "internal" }]);
  const strict = await captureReleaseSnapshot(fixture.snapshot.input, required);
  const relaxed = await captureReleaseSnapshot(fixture.snapshot.input, optional);
  assert.deepEqual(relaxed.normalized, strict.normalized);
  assert.notEqual(relaxed.configurationId, strict.configurationId);
  assert.notEqual(relaxed.snapshotId, strict.snapshotId);
  assert.notEqual(strict.tool.normalizerId, fixture.snapshot.tool.normalizerId);
  assert.deepEqual(
    await replayReleaseSnapshot(fixture.serialized, fixtureConfiguration),
    fixture.snapshot,
  );
  await assert.rejects(replayReleaseSnapshot(await serializeReleaseSnapshot(strict), optional), {
    code: "configuration-mismatch",
  });
});

for (const body of [
  "```release-log\nversion: 1\n```",
  "```release-log\nversion: [\n```",
  "```release-log extra\nversion: 1\n```",
  "```release-log\nversion: 1",
  "```release-log\nversion: 1\n```\n\n```release-log\nversion: 1\n```",
]) {
  void test(`optional policy rejects malformed or excessive context (${body.length} bytes, ${body.slice(0, 30)})`, async () => {
    await assert.rejects(captureReleaseSnapshot(await source(body), optional), {
      code: "metadata-invalid",
    });
  });
}

void test("optional policy preserves description size limits at parsing and capture boundaries", async () => {
  const body = "x".repeat(1024 * 1024 + 1);
  const readiness = await validatePullRequestMetadata("feat(api): add rows", body, [], "optional");
  assert.ok(!readiness.valid);
  assert.ok(readiness.errors.some((issue) => issue.code === "description-too-large"));
  await assert.rejects(captureReleaseSnapshot(await source(body), optional), {
    code: "resource-limit",
  });
});

for (const verbosity of ["detailed", "concise", "one-liner"] as const) {
  for (const breaking of [false, true]) {
    void test(`${verbosity}: absent context retains title, source and warnings (breaking=${breaking})`, async () => {
      const config = { ...optional, changelog: { verbosity } };
      const input = await source("No release block.", breaking);
      const snapshot = await captureReleaseSnapshot(input, config);
      const serialized = await serializeReleaseSnapshot(snapshot);
      const rendered = await renderChangelog(serialized, config, version);
      assert.ok(rendered);
      assert.match(rendered, breaking ? /## v2\.0\.0/u : /## v1\.3\.0/u);
      assert.ok(rendered.includes(breaking ? "remove old keys" : "export &#60;rows&#62;"));
      assert.ok(rendered.includes("[#1](https://github.com/example/project/pull/1)"));
      assert.ok(rendered.includes("audience and impact are unknown"));
      assert.ok(!rendered.includes("[internal]"));
      assert.equal(rendered.includes("migration instructions are missing"), breaking);
      assert.equal(
        rendered.includes("**Breaking change:** remove old keys; supply new keys"),
        breaking,
      );
      assert.equal(
        snapshot.normalized.pullRequests[0]?.validation.warnings.some(
          (issue) => issue.code === "breaking-action-missing",
        ),
        breaking,
      );
      assert.equal(await renderChangelog(serialized, config, version), rendered);
    });
  }
}

void test("optional policy preserves title/commit validation and requires an action in a supplied breaking block", async () => {
  const fixture = await releaseFixture([{ title: "feat(api): export rows" }]);
  const body = fixture.snapshot.input.pullRequests[0]?.body;
  assert.ok(body);
  const result = await validatePullRequestMetadata("feat(api)!: remove keys", body, [], "optional");
  assert.ok(!result.valid);
  assert.ok(result.errors.some((issue) => issue.code === "breaking-action-required"));
  for (const [title, message] of [
    ["feat: unscoped title", "feat: add rows"],
    ["feat(api): add rows", "arbitrary commit"],
    ["feat(api): add rows", "feat!: remove keys"],
  ]) {
    const invalid = await validatePullRequestMetadata(
      title ?? "",
      "No context",
      [{ sha: "a".repeat(40), message: message ?? "", parentCount: 1 }],
      "optional",
    );
    assert.ok(!invalid.valid);
  }
});

void test("optional policy does not alter historical onboarding treatment", async () => {
  const fixture = await releaseFixture([{ title: "feat(api): add rows" }], null);
  const input = {
    ...fixture.snapshot.input,
    pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({
      ...pull,
      body: "Historical body",
    })),
  };
  const base = {
    ...fixtureConfiguration,
    schemaVersion: 2,
    bootstrap: {
      baselineSha: input.range.baseline.commitSha,
      onboardingSha: input.range.sourceCommitSha,
    },
  } as const;
  const strict = await captureReleaseSnapshot(input, base);
  const relaxed = await captureReleaseSnapshot(input, { ...base, contextPolicy: "optional" });
  assert.deepEqual(relaxed.normalized, strict.normalized);
  assert.equal(relaxed.normalized.historicalEntries.length, 1);
  assert.equal(relaxed.normalized.pullRequests.length, 0);
});

void test("replay rejects forged context and missing warnings", async () => {
  const snapshot = await captureReleaseSnapshot(await source("No context"), optional);
  const serialized = await serializeReleaseSnapshot(snapshot);
  const pull = snapshot.normalized.pullRequests[0];
  assert.ok(pull);
  for (const normalized of [
    {
      ...snapshot.normalized,
      pullRequests: [{ ...pull, validation: { valid: true, warnings: [] } }],
    },
    {
      ...snapshot.normalized,
      pullRequests: [
        {
          ...pull,
          context: {
            version: 1,
            audience: "users",
            summary: "Invented",
            impact: "Invented",
            requiredAction: null,
          },
        },
      ],
    },
  ]) {
    await assert.rejects(
      replayReleaseSnapshot(JSON.stringify({ ...snapshot, normalized }), optional),
      { code: "integrity-mismatch" },
    );
  }
  assert.deepEqual(await replayReleaseSnapshot(serialized, optional), snapshot);
});

void test("optional policy neither forces a docs-only release nor accepts missing association evidence", async () => {
  const fixture = await releaseFixture([{ title: "docs(api): explain keys" }]);
  const input = {
    ...fixture.snapshot.input,
    pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({
      ...pull,
      body: "No release context.",
    })),
  };
  const serialized = await serializeReleaseSnapshot(await captureReleaseSnapshot(input, optional));
  assert.equal((await createReleasePlan(serialized, optional, version)).release, false);
  assert.equal(await renderChangelog(serialized, optional, version), null);
  await assert.rejects(captureReleaseSnapshot({ ...input, pullRequests: [] }, optional));
});
