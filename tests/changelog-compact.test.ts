import assert from "node:assert/strict";
import { test } from "node:test";

import { renderChangelog, updateChangelog } from "../src/changelog.ts";
import { createReleasePlan } from "../src/release-plan.ts";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import type { ChangelogVerbosity } from "../src/release-snapshot.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const version = { kind: "released", currentVersion: "1.2.3" } as const;

async function compact(
  fixture: Awaited<ReturnType<typeof releaseFixture>>,
  verbosity: ChangelogVerbosity = "concise",
) {
  const config = { ...fixtureConfiguration, changelog: { verbosity, format: "compact" as const } };
  const snapshot = await captureReleaseSnapshot(fixture.snapshot.input, config);
  return { config, snapshot, serialized: await serializeReleaseSnapshot(snapshot) };
}

void test("compact layout matches the golden with visible actions and collapsed internal maintenance", async () => {
  const fixture = await releaseFixture([
    { title: "feat(api): export rows", summary: "Export selected rows." },
    {
      title: "fix(release): verify commits",
      audience: "internal",
      summary: "Verify commit messages.",
      action: "Review generated output.",
    },
    { title: "ci(deps): lock tools", audience: "internal", summary: "Keep locked dependencies." },
  ]);
  const selected = await compact(fixture);
  assert.equal(
    await renderChangelog(selected.serialized, selected.config, version),
    [
      "## v1.3.0",
      "",
      "### Features",
      "",
      "- Export selected rows&#46; ([#1](https://github.com/example/project/pull/1))",
      "",
      "### Required actions",
      "",
      "- Review generated output&#46; ([#2](https://github.com/example/project/pull/2))",
      "",
      "<details>",
      "<summary>Internal maintenance</summary>",
      "",
      "- Verify commit messages&#46; ([#2](https://github.com/example/project/pull/2))",
      "- Keep locked dependencies&#46; ([#3](https://github.com/example/project/pull/3))",
      "",
      "</details>",
      "",
    ].join("\n"),
  );
});

for (const verbosity of ["detailed", "concise", "one-liner"] as const) {
  void test(`${verbosity}: compact keeps internal breaking warnings/actions visible and escapes prose`, async () => {
    const fixture = await releaseFixture([
      {
        title: "fix(api)!: remove old keys",
        audience: "internal",
        summary: "Remove <old> keys.",
        impact: "Old keys stop working.",
        action: "Use <new> keys.",
        message: "fix!: remove old keys\n\nBREAKING CHANGE: supply new keys",
      },
      { title: "feat(api): export rows", summary: "<details><summary>forged</summary></details>" },
    ]);
    const selected = await compact(fixture, verbosity);
    const rendered = await renderChangelog(selected.serialized, selected.config, version);
    assert.ok(rendered);
    const collapse = rendered.indexOf("<details>");
    assert.ok(collapse > 0);
    assert.ok(rendered.indexOf("### Breaking changes") < collapse);
    assert.ok(rendered.indexOf("### Required actions") < collapse);
    assert.ok(rendered.slice(0, collapse).includes("supply new keys"));
    assert.ok(rendered.slice(0, collapse).includes("Use &#60;new&#62; keys&#46;"));
    assert.equal((rendered.match(/<details>/gu) ?? []).length, 1);
    assert.ok(!rendered.includes("[internal]"));
    assert.ok(!rendered.includes("**api**:"));
    assert.equal(rendered.includes("Impact:"), verbosity === "detailed");
    assert.equal(await renderChangelog(selected.serialized, selected.config, version), rendered);
    assert.deepEqual(
      await replayReleaseSnapshot(selected.serialized, selected.config),
      selected.snapshot,
    );
    const original = await createReleasePlan(fixture.serialized, fixtureConfiguration, version);
    const plan = await createReleasePlan(selected.serialized, selected.config, version);
    assert.equal(plan.nextVersion, original.nextVersion);
    assert.deepEqual(plan.contributions, original.contributions);
    assert.deepEqual(selected.snapshot.normalized, fixture.snapshot.normalized);
  });
}

void test("compact optional context stays visible with unknown audience and missing migration instructions", async () => {
  const fixture = await releaseFixture([
    { title: "feat(api)!: remove keys", action: "Use new keys." },
  ]);
  const config = {
    ...fixtureConfiguration,
    contextPolicy: "optional",
    changelog: { verbosity: "concise", format: "compact" },
  } as const;
  const snapshot = await captureReleaseSnapshot(
    {
      ...fixture.snapshot.input,
      pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({
        ...pull,
        body: "No structured context.",
      })),
    },
    config,
  );
  const rendered = await renderChangelog(await serializeReleaseSnapshot(snapshot), config, version);
  assert.ok(rendered);
  assert.ok(rendered.includes("remove keys"));
  assert.ok(rendered.includes("audience and impact are unknown"));
  assert.ok(rendered.includes("Migration instructions are missing"));
  assert.ok(!rendered.includes("<details>"));
});

void test("compact retains bootstrap and historical source identities without inferring context", async () => {
  const fixture = await releaseFixture([{ title: "feat(api): keep history" }], null, [
    "fix!: remove old keys\n\nBREAKING CHANGE: supply new keys",
  ]);
  const config = {
    ...fixtureConfiguration,
    schemaVersion: 2,
    bootstrap: {
      baselineSha: fixture.snapshot.input.range.baseline.commitSha,
      onboardingSha: fixture.snapshot.input.range.sourceCommitSha,
    },
    changelog: { verbosity: "concise", format: "compact" },
  } as const;
  const input = {
    ...fixture.snapshot.input,
    pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({
      ...pull,
      title: "Legacy import",
      body: "Historical context unavailable.",
    })),
  };
  const snapshot = await captureReleaseSnapshot(input, config);
  const rendered = await renderChangelog(await serializeReleaseSnapshot(snapshot), config, {
    kind: "bootstrap",
    initialVersion: "0.1.0",
  });
  assert.ok(rendered);
  assert.ok(rendered.includes("Historical changes"));
  assert.ok(rendered.includes("Legacy import"));
  assert.ok(rendered.includes("supply new keys"));
  assert.ok(rendered.includes("https://github.com/example/project/pull/1"));
  assert.ok(rendered.includes("https://github.com/example/project/commit/"));
  assert.ok(rendered.includes("migration instructions"));
});

void test("compact is pinned into configuration identity and preserves released sections", async () => {
  const fixture = await releaseFixture([{ title: "feat(api): export rows" }]);
  const selected = await compact(fixture);
  assert.notEqual(selected.snapshot.configurationId, fixture.snapshot.configurationId);
  await assert.rejects(replayReleaseSnapshot(fixture.serialized, selected.config));
  const released = "## v1.2.3\r\n\r\nKeep the published text.\r\n";
  const old = updateChangelog(
    released,
    await renderChangelog(fixture.serialized, fixtureConfiguration, version),
  );
  const rendered = await renderChangelog(selected.serialized, selected.config, version);
  const updated = updateChangelog(old, rendered);
  assert.ok(updated.endsWith(released));
  assert.equal(updateChangelog(updated, rendered), updated);
});

void test("explicit classic preserves the existing output; invalid formats fail closed", async () => {
  const fixture = await releaseFixture([{ title: "feat(api): export rows" }]);
  const config = {
    ...fixtureConfiguration,
    changelog: { verbosity: "detailed", format: "classic" },
  } as const;
  const snapshot = await captureReleaseSnapshot(fixture.snapshot.input, config);
  assert.equal(
    await renderChangelog(await serializeReleaseSnapshot(snapshot), config, version),
    await renderChangelog(fixture.serialized, fixtureConfiguration, version),
  );
  for (const format of [undefined, null, "", "Compact", " compact ", "other", true])
    assert.throws(() =>
      parseReleaseInputConfiguration({ ...config, changelog: { verbosity: "concise", format } }),
    );
});

void test("compact does not manufacture a release for maintenance-only changes", async () => {
  const selected = await compact(
    await releaseFixture([{ title: "docs(api): explain exports", audience: "internal" }]),
  );
  assert.equal(await renderChangelog(selected.serialized, selected.config, version), null);
});

void test("compact orders historical and current internal PRs together by numeric source identity", async () => {
  const fixture = await releaseFixture(
    [
      { title: "feat(api): old entry", audience: "internal" },
      { title: "feat(api): current entry", audience: "internal", summary: "Current change." },
    ],
    null,
  );
  const first = fixture.snapshot.input.pullRequests[0];
  assert.ok(first);
  const config = {
    ...fixtureConfiguration,
    schemaVersion: 2,
    bootstrap: {
      baselineSha: fixture.snapshot.input.range.baseline.commitSha,
      onboardingSha: first.mergeCommitSha,
    },
    changelog: { verbosity: "concise", format: "compact" },
  } as const;
  const snapshot = await captureReleaseSnapshot(
    {
      ...fixture.snapshot.input,
      pullRequests: fixture.snapshot.input.pullRequests.map((pull) =>
        pull.number === first.number ? { ...pull, title: "Legacy import" } : pull,
      ),
    },
    config,
  );
  const rendered = await renderChangelog(await serializeReleaseSnapshot(snapshot), config, {
    kind: "bootstrap",
    initialVersion: "0.1.0",
  });
  assert.ok(rendered);
  assert.ok(rendered.indexOf("Legacy import") < rendered.indexOf("Current change"));
  assert.equal((rendered.match(/Legacy import/gu) ?? []).length, 1);
  assert.equal((rendered.match(/Current change/gu) ?? []).length, 1);
});
