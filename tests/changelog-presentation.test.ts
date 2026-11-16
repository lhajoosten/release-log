import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderChangelog, updateChangelog, encodeComparisonRef } from "../src/changelog.ts";
import {
  captureReleaseSnapshot,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { createReleasePlan } from "../src/release-plan.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const capturedAt = "2026-11-16T20:34:56.789Z";
const version = { kind: "released", currentVersion: "1.2.3" } as const;

void test("schema-5 classic output matches a fixed golden and retains legacy decisions and bytes", async () => {
  const legacy = await releaseFixture([{ title: "fix(api): retain keys" }]);
  const input = {
    ...legacy.snapshot.input,
    pullRequests: legacy.snapshot.input.pullRequests.map((pull) => ({
      ...pull,
      authorLogin: "octocat",
    })),
  };
  const snapshot = await captureReleaseSnapshot(input, fixtureConfiguration, capturedAt);
  const serialized = await serializeReleaseSnapshot(snapshot);
  assert.equal(snapshot.schemaVersion, 5);
  assert.deepEqual(snapshot.normalized, legacy.snapshot.normalized);
  const expected = [
    "## v1.2.4 (2026-11-16)",
    "",
    `Inputs captured at: ${capturedAt} (UTC; not a release date).`,
    "",
    "### 🐛 Fixes",
    "",
    "- **api**: Preserve selected rows&#46; ([#1](https://github.com/example/project/pull/1)) by [&#64;octocat](https://github.com/octocat)",
    "  - Impact: Keep the selection&#46;",
    "",
    `Full changelog: [v1&#46;2&#46;3&#8230;${"0".repeat(39)}1](https://github.com/example/project/compare/v1.2.3...${"0".repeat(39)}1) (captured source).`,
    "",
  ].join("\n");
  assert.equal(await renderChangelog(serialized, fixtureConfiguration, version), expected);
  assert.equal(
    await serializeReleaseSnapshot(await replayReleaseSnapshot(serialized, fixtureConfiguration)),
    serialized,
  );
  const oldPlan = await createReleasePlan(legacy.serialized, fixtureConfiguration, version);
  const newPlan = await createReleasePlan(serialized, fixtureConfiguration, version);
  assert.deepEqual(
    { ...newPlan, schemaVersion: oldPlan.schemaVersion, snapshotId: oldPlan.snapshotId },
    oldPlan,
  );
  const released = "## v1.2.3\r\n\r\nOriginal prose.  \r\n";
  const pending = updateChangelog(`# Changelog\n\n${released}`, expected);
  const refreshed = updateChangelog(
    pending,
    expected.replace(capturedAt, "2026-11-17T20:34:56.789Z"),
  );
  assert.ok(refreshed.endsWith(released));
  const nextCycle = updateChangelog(pending, expected.replace("## v1.2.4", "## v1.2.5"), "1.2.4");
  assert.ok(nextCycle.includes(expected));
  assert.ok(nextCycle.endsWith(released));
  assert.equal(
    (await renderChangelog(legacy.serialized, fixtureConfiguration, version))?.includes(
      "Inputs captured",
    ),
    false,
  );
});

void test("compact modes retain bots, missing and hostile attribution without executable Markdown", async () => {
  const legacy = await releaseFixture([
    { title: "feat(api)!: change keys", audience: "internal", action: "Use new keys." },
    { title: "fix(api): retain keys" },
    { title: "fix(api): preserve keys" },
  ]);
  const logins = ["dependabot[bot]", null, "<img src=x>](https://evil.invalid)\n## forged"];
  for (const verbosity of ["detailed", "concise", "one-liner"] as const) {
    const config = {
      ...fixtureConfiguration,
      changelog: { verbosity, format: "compact" as const },
    };
    const snapshot = await captureReleaseSnapshot(
      {
        ...legacy.snapshot.input,
        pullRequests: legacy.snapshot.input.pullRequests.map((pull, index) => ({
          ...pull,
          authorLogin: logins[index] ?? null,
        })),
      },
      config,
      capturedAt,
    );
    const serialized = await serializeReleaseSnapshot(snapshot);
    const text = await renderChangelog(serialized, config, version);
    assert.ok(text);
    assert.ok(text.includes("### 💥 Breaking changes"));
    assert.ok(text.includes("### 🛠️ Required actions"));
    assert.ok(text.includes("<summary>🔧 Internal maintenance</summary>"));
    assert.ok(text.includes("</details>\n\n<br>\n\nFull changelog:"));
    assert.ok(text.includes("https://github.com/dependabot%5Bbot%5D"));
    assert.ok(!text.includes("<img"));
    assert.ok(!text.includes("\n## forged"));
    assert.ok(!text.split("\n").find((line) => line.includes("[#2]") && line.includes(" by ")));
    assert.equal(
      fromMarkdown(text).children.filter((node) => node.type === "heading" && node.depth === 2)
        .length,
      1,
    );
    assert.equal(await renderChangelog(serialized, config, version), text);
  }
});

void test("bootstrap, deleted authors and invalid or altered capture timestamps have explicit behavior", async () => {
  const legacy = await releaseFixture([{ title: "feat(api): retain keys" }], null);
  const snapshot = await captureReleaseSnapshot(
    {
      ...legacy.snapshot.input,
      pullRequests: legacy.snapshot.input.pullRequests.map((pull) => ({
        ...pull,
        authorId: null,
        authorType: "Unavailable",
        authorLogin: null,
      })),
    },
    fixtureConfiguration,
    capturedAt,
  );
  const serialized = await serializeReleaseSnapshot(snapshot);
  const text = await renderChangelog(serialized, fixtureConfiguration, {
    kind: "bootstrap",
    initialVersion: "0.1.0",
  });
  assert.ok(text);
  assert.ok(text.includes(capturedAt));
  assert.ok(!text.includes("Full changelog:"));
  assert.ok(!text.includes(" by "));
  for (const timestamp of [
    "2026-11-16",
    "2026-02-30T00:00:00.000Z",
    "2026-11-16T20:34:56Z",
    "bad",
  ]) {
    await assert.rejects(
      captureReleaseSnapshot(legacy.snapshot.input, fixtureConfiguration, timestamp),
      /canonical UTC/u,
    );
  }
  await assert.rejects(
    replayReleaseSnapshot(
      serialized.replace(capturedAt, "2026-11-17T20:34:56.789Z"),
      fixtureConfiguration,
    ),
    /identity or normalized/u,
  );
  await assert.rejects(
    replayReleaseSnapshot(
      serialized.replace('"schemaVersion":5', '"schemaVersion":3'),
      fixtureConfiguration,
    ),
    /Unexpected or missing/u,
  );
  assert.equal(encodeComparisonRef("release/a b#?()!'*"), "release%2Fa%20b%23%3F%28%29%21%27%2A");
});

void test("enriched replay and rendering work when network and current-clock access throw", async () => {
  const legacy = await releaseFixture([{ title: "fix(api): retain keys" }]);
  const snapshot = await captureReleaseSnapshot(
    legacy.snapshot.input,
    fixtureConfiguration,
    capturedAt,
  );
  const serialized = await serializeReleaseSnapshot(snapshot);
  const expected = await renderChangelog(serialized, fixtureConfiguration, version);
  const script = `
    globalThis.fetch = () => { throw new Error("Network is forbidden"); };
    const { renderChangelog } = await import(${JSON.stringify(new URL("../src/changelog.ts", import.meta.url).href)});
    globalThis.Date = new Proxy(Date, { construct(target, args) {
      if (!args.length) throw new Error("Current clock is forbidden");
      return Reflect.construct(target, args);
    }, get(target, key) {
      if (key === "now") return () => { throw new Error("Current clock is forbidden"); };
      return Reflect.get(target, key);
    }});
    process.stdout.write(await renderChangelog(${JSON.stringify(serialized)}, ${JSON.stringify(fixtureConfiguration)}, ${JSON.stringify(version)}));
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10_000 },
  );
  assert.equal(stdout, expected, stderr);
});
