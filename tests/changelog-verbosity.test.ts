import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";

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

const modes: readonly ChangelogVerbosity[] = ["detailed", "concise", "one-liner"];
const version = { kind: "released", currentVersion: "1.2.3" } as const;

async function configured(
  fixture: Awaited<ReturnType<typeof releaseFixture>>,
  verbosity: ChangelogVerbosity,
) {
  const config = { ...fixtureConfiguration, changelog: { verbosity } };
  const snapshot = await captureReleaseSnapshot(fixture.snapshot.input, config);

  return { config, snapshot, serialized: await serializeReleaseSnapshot(snapshot) };
}

void test("omitted verbosity keeps the current detailed format byte for byte", async () => {
  const fixture = await releaseFixture([
    { title: "feat(api): export rows", summary: "Export rows.", impact: "Retain selected rows." },
  ]);
  const detailed = await configured(fixture, "detailed");
  const rendered = await renderChangelog(detailed.serialized, detailed.config, version);

  assert.equal(rendered, await renderChangelog(fixture.serialized, fixtureConfiguration, version));
  assert.equal(
    rendered,
    [
      "## v1.3.0",
      "",
      "### Features",
      "",
      "- **api**: Export rows&#46; ([#1](https://github.com/example/project/pull/1))",
      "  - Impact: Retain selected rows&#46;",
      "",
    ].join("\n"),
  );
  assert.deepEqual(parseReleaseInputConfiguration(fixtureConfiguration), fixtureConfiguration);
});

for (const verbosity of modes) {
  void test(`${verbosity}: presentation never changes membership, metadata evidence or version decisions`, async () => {
    const fixture = await releaseFixture([
      { title: "feat(api): export rows", audience: "internal" },
      { title: "docs(api): explain exports" },
    ]);
    const selected = await configured(fixture, verbosity);
    const original = await createReleasePlan(fixture.serialized, fixtureConfiguration, version);
    const plan = await createReleasePlan(selected.serialized, selected.config, version);
    const rendered = await renderChangelog(selected.serialized, selected.config, version);

    assert.equal(plan.nextVersion, "1.3.0");
    assert.equal(plan.bump, original.bump);
    assert.deepEqual(plan.contributions, original.contributions);
    assert.deepEqual(selected.snapshot.normalized, fixture.snapshot.normalized);
    assert.notEqual(selected.snapshot.configurationId, fixture.snapshot.configurationId);
    assert.notEqual(selected.snapshot.snapshotId, fixture.snapshot.snapshotId);
    assert.equal((rendered?.match(/\(\[#/gu) ?? []).length, 2);
    assert.ok(rendered?.includes("[internal]"));
    assert.deepEqual(
      await replayReleaseSnapshot(selected.serialized, selected.config),
      selected.snapshot,
    );
    assert.equal(await renderChangelog(selected.serialized, selected.config, version), rendered);
  });

  void test(`${verbosity}: breaking warnings and migration actions remain visible and escaped`, async () => {
    const hostile =
      '<script>alert("x")</script>\n\n## forged\n[click](javascript:evil) ![track](https://evil.invalid) `run` <!-- release-log:pending:end -->';
    const fixture = await releaseFixture([
      {
        title: "feat(api)!: remove old keys",
        summary: hostile,
        impact: "Old keys are no longer supported.",
        action: hostile,
        message: "feat!: remove old keys\n\nBREAKING CHANGE: supply <new> keys",
      },
    ]);
    const selected = await configured(fixture, verbosity);
    const rendered = await renderChangelog(selected.serialized, selected.config, version);

    assert.ok(rendered);
    assert.ok(rendered.startsWith("## v2.0.0\n"));
    assert.ok(rendered.includes("**Breaking change:**"));
    assert.ok(rendered.includes("supply &#60;new&#62; keys"));
    assert.ok(rendered.includes("**Required action:**"));
    assert.ok(!rendered.includes("<script>"));
    assert.ok(!rendered.includes("<!-- release-log:"));
    assert.equal(rendered.includes("  - Impact:"), verbosity === "detailed");

    const tree = JSON.stringify(fromMarkdown(rendered));

    assert.ok(!tree.includes('"type":"html"'));
    assert.ok(!tree.includes('"type":"image"'));
    assert.equal((tree.match(/"type":"link"/gu) ?? []).length, 1);
    assert.ok(tree.includes('"url":"https://github.com/example/project/pull/1"'));

    if (verbosity === "one-liner") {
      const entries = rendered.split("\n").filter((line) => line.startsWith("- "));

      assert.equal(entries.length, 1);
      assert.ok(entries[0]?.includes("**Breaking change:**"));
      assert.ok(entries[0]?.includes("**Required action:**"));
      assert.ok(!rendered.includes("\n  - "));
    } else {
      assert.ok(rendered.includes("\n  - **Breaking change:**"));
      assert.ok(rendered.includes("\n  - **Required action:**"));
    }
  });

  void test(`${verbosity}: no-release batches remain no-release`, async () => {
    const fixture = await releaseFixture([{ title: "docs(api): explain exports" }]);
    const selected = await configured(fixture, verbosity);

    assert.equal(await renderChangelog(selected.serialized, selected.config, version), null);
  });

  void test(`${verbosity}: historical PRs and bootstrap commits keep source links, warnings and available actions`, async () => {
    const fixture = await releaseFixture(
      [
        {
          title: "feat(app)!: replace startup",
          summary: "Replace startup.",
          impact: "Select the new startup path.",
          action: "Configure the new startup path.",
          message: "feat!: replace startup\n\nBREAKING CHANGE: select the new startup path",
        },
      ],
      null,
      ["feat!: initialize state\n\nBREAKING CHANGE: old state format removed"],
    );
    const config = {
      ...fixtureConfiguration,
      schemaVersion: 2 as const,
      bootstrap: {
        baselineSha: fixture.snapshot.input.range.baseline.commitSha,
        onboardingSha: fixture.snapshot.input.range.sourceCommitSha,
      },
      changelog: { verbosity },
    };
    const input = {
      ...fixture.snapshot.input,
      pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({
        ...pull,
        title: "Initial old application",
      })),
    };
    const snapshot = await captureReleaseSnapshot(input, config);
    const rendered = await renderChangelog(await serializeReleaseSnapshot(snapshot), config, {
      kind: "bootstrap",
      initialVersion: "0.1.0",
    });

    assert.ok(rendered);
    assert.ok(rendered.startsWith("## v0.1.0\n"));
    assert.ok(rendered.includes("Historical entries predate onboarding"));
    assert.ok(rendered.includes("[historical PR]"));
    assert.ok(rendered.includes("[historical commit]"));
    assert.ok(rendered.includes("https://github.com/example/project/pull/1"));
    assert.ok(rendered.includes("https://github.com/example/project/commit/"));
    assert.ok(rendered.includes("**Required action:** Configure the new startup path&#46;"));
    assert.ok(rendered.includes("old state format removed"));
    assert.ok(rendered.includes("select the new startup path"));
    assert.equal(rendered.includes("Metadata review:"), verbosity === "detailed");
    assert.equal(rendered.includes("Impact:"), verbosity === "detailed");

    if (verbosity === "one-liner") {
      const entries = rendered.split("\n").filter((line) => line.startsWith("- "));

      assert.equal(entries.length, 2);
      assert.ok(entries.every((line) => line.includes("**Breaking change:**")));
      assert.ok(entries.some((line) => line.includes("**Required action:**")));
      assert.ok(!rendered.includes("\n  - "));
    }
  });
}

void test("concise and one-liner ordinary entries match their shared minimal golden", async () => {
  const fixture = await releaseFixture([
    { title: "feat(api): export rows", summary: "Export rows.", impact: "Retain selected rows." },
  ]);
  const golden = [
    "## v1.3.0",
    "",
    "### Features",
    "",
    "- **api**: Export rows&#46; ([#1](https://github.com/example/project/pull/1))",
    "",
  ].join("\n");

  for (const mode of ["concise", "one-liner"] as const) {
    const selected = await configured(fixture, mode);

    assert.equal(await renderChangelog(selected.serialized, selected.config, version), golden);
  }
});

void test("verbosity is pinned to capture identity and pending updates preserve released content", async () => {
  const fixture = await releaseFixture([{ title: "feat(api): export rows" }]);
  const detailed = await configured(fixture, "detailed");
  const concise = await configured(fixture, "concise");

  await assert.rejects(
    renderChangelog(detailed.serialized, concise.config, version),
    /configuration differs/u,
  );

  const released = "## v1.2.3\r\n\r\nPreserve **this** released content.\r\n";
  const first = updateChangelog(
    released,
    await renderChangelog(detailed.serialized, detailed.config, version),
  );
  const second = updateChangelog(
    first,
    await renderChangelog(concise.serialized, concise.config, version),
  );

  assert.notEqual(first, second);
  assert.ok(second.endsWith(released));
  assert.equal(
    updateChangelog(second, await renderChangelog(concise.serialized, concise.config, version)),
    second,
  );
});

void test("verbosity configuration rejects missing, unknown and malformed settings instead of silently defaulting", () => {
  for (const value of [
    null,
    [],
    {},
    { verbosity: null },
    { verbosity: "compact" },
    { verbosity: "Concise" },
    { verbosity: " concise " },
    { verbosity: "one-liner", hideBreaking: true },
  ])
    assert.throws(() =>
      parseReleaseInputConfiguration({ ...fixtureConfiguration, changelog: value }),
    );

  for (const verbosity of modes)
    assert.deepEqual(
      parseReleaseInputConfiguration({ ...fixtureConfiguration, changelog: { verbosity } })
        .changelog,
      { verbosity },
    );
});
