import assert from "node:assert/strict";
import { test } from "node:test";

import { renderChangelog } from "../src/changelog.ts";
import { createReleasePlan } from "../src/release-plan.ts";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const base = "0".repeat(40);
const first = "1".padStart(40, "0");
const second = "2".padStart(40, "0");
const initial = { kind: "bootstrap", initialVersion: "0.1.0" } as const;

function configuration(onboardingSha = first) {
  return {
    ...fixtureConfiguration,
    schemaVersion: 2 as const,
    bootstrap: { baselineSha: base, onboardingSha },
  };
}

function commitHistory(message = "Start the application") {
  return {
    repository: "example/project",
    releaseBranch: "main",
    range: {
      baseline: { kind: "bootstrap" as const, commitSha: base },
      sourceCommitSha: first,
      baselineIsAncestor: true as const,
      commitShas: [first],
    },
    pullRequests: [],
    bootstrapCommits: [{ sha: first, parentShas: [base], message }],
  };
}

void test("initial adoption plans 0.1.0 from unstructured, maintenance-only and empty historical messages", async () => {
  for (const message of [
    "Start the application",
    "chore: initialize tooling",
    "docs: add readme",
    "",
  ]) {
    const config = configuration();
    const snapshot = await captureReleaseSnapshot(commitHistory(message), config);
    const serialized = await serializeReleaseSnapshot(snapshot);
    const plan = await createReleasePlan(serialized, config, initial);

    assert.equal(plan.nextVersion, "0.1.0");
    assert.equal(plan.bump, "initial");
    assert.equal(plan.onboardingSha, first);
    assert.equal(plan.contributions.length, 0);
    assert.equal(plan.bootstrapContributions.length, 0);
    assert.equal(plan.historicalContributions.length, 1);
    assert.equal(snapshot.normalized.historicalEntries[0]?.context, null);
    assert.deepEqual(plan.historicalContributions[0]?.source, {
      kind: "commit",
      sha: first,
      url: `https://github.com/example/project/commit/${first}`,
    });

    assert.deepEqual(await replayReleaseSnapshot(serialized, config), snapshot);
    assert.deepEqual(await createReleasePlan(serialized, config, initial), plan);
  }
});

void test("an explicitly selected initial release can describe an application entirely in the first commit", async () => {
  const input = commitHistory();
  const config = configuration(base);

  const snapshot = await captureReleaseSnapshot(
    {
      ...input,
      range: { ...input.range, sourceCommitSha: base, commitShas: [] },
      bootstrapCommits: [],
    },
    config,
  );
  const serialized = await serializeReleaseSnapshot(snapshot);
  const plan = await createReleasePlan(serialized, config, initial);
  const changelog = await renderChangelog(serialized, config, initial);

  assert.equal(plan.nextVersion, "0.1.0");
  assert.equal(plan.historicalContributions.length, 0);
  assert.equal(changelog, "## v0.1.0\n\nInitial release of the captured repository state.\n");
});

void test("legacy PRs retain actual identifiers, missing-metadata warnings and explicit breaking evidence", async () => {
  const fixture = await releaseFixture([{ title: "feat(app): initialize" }], null);
  const pull = fixture.snapshot.input.pullRequests[0];

  assert.ok(pull);

  const message =
    "Change startup behavior\n\nBREAKING CHANGE: Configure the new startup entry point";
  const input = {
    ...fixture.snapshot.input,
    pullRequests: [
      {
        ...pull,
        title: "Initial application <script> configuration",
        body: "Historical description without a release context block.",
        originalCommits: pull.originalCommits.map((entry) => ({ ...entry, message })),
        landedCommits: pull.landedCommits.map((entry) => ({ ...entry, message })),
      },
    ],
  };
  const config = configuration();
  const snapshot = await captureReleaseSnapshot(input, config);
  const entry = snapshot.normalized.historicalEntries[0];

  assert.ok(entry);
  assert.equal(snapshot.normalized.pullRequests.length, 0);
  assert.deepEqual(entry.source, {
    kind: "pull-request",
    number: 1,
    url: "https://github.com/example/project/pull/1",
  });
  assert.equal(entry.title, input.pullRequests[0]?.title);
  assert.equal(entry.context, null);
  assert.deepEqual(entry.breakingChanges, ["Configure the new startup entry point"]);
  assert.ok(entry.warnings.some((issue) => issue.code === "block-missing"));

  const serialized = await serializeReleaseSnapshot(snapshot);
  const plan = await createReleasePlan(serialized, config, initial);
  const changelog = await renderChangelog(serialized, config, initial);

  assert.equal(plan.nextVersion, "0.1.0");
  assert.equal(plan.historicalContributions[0]?.breaking, true);
  assert.ok(changelog?.includes("Initial application &#60;script&#62; configuration"));
  assert.ok(changelog?.includes("**Breaking change:** Configure the new startup entry point"));
  assert.ok(!changelog?.includes("<script>"));
  assert.ok(!changelog?.includes("Impact:"));
  assert.ok(!changelog?.includes("Required action:"));
});

void test("historical breaking headers and either footer spelling remain explicit review evidence", async () => {
  for (const message of [
    "feat!: change startup",
    "feat(old)!: change startup",
    "Change startup\n\nBREAKING CHANGE: change startup",
    "Change startup\n\nBREAKING-CHANGE: change startup",
  ]) {
    const config = configuration();
    const snapshot = await captureReleaseSnapshot(commitHistory(message), config);
    const serialized = await serializeReleaseSnapshot(snapshot);
    const plan = await createReleasePlan(serialized, config, initial);
    const changelog = await renderChangelog(serialized, config, initial);

    assert.deepEqual(snapshot.normalized.historicalEntries[0]?.breakingChanges, ["change startup"]);
    assert.equal(plan.historicalContributions[0]?.breaking, true);
    assert.ok(changelog?.includes("**Breaking change:** change startup"));
  }
});

void test("valid historical context is retained even when the old PR title lacks a scope", async () => {
  const fixture = await releaseFixture(
    [
      {
        title: "feat(app): initialize",
        audience: "internal",
        summary: "Initialize the application.",
        impact: "Provide the first application entry point.",
      },
    ],
    null,
  );
  const pull = fixture.snapshot.input.pullRequests[0];

  assert.ok(pull);

  const config = configuration();
  const snapshot = await captureReleaseSnapshot(
    {
      ...fixture.snapshot.input,
      pullRequests: [{ ...pull, title: "feat: initialize the application" }],
    },
    config,
  );
  const entry = snapshot.normalized.historicalEntries[0];

  assert.equal(entry?.context?.audience, "internal");
  assert.equal(entry?.context?.summary, "Initialize the application.");
  assert.equal(entry?.context?.impact, "Provide the first application entry point.");
  assert.ok(entry?.warnings.some((issue) => issue.code === "scope-empty"));
});

void test("the same invalid PR is rejected after onboarding and in tagged cycles", async () => {
  const fixture = await releaseFixture([{ title: "feat(app): initialize" }], null);
  const pull = fixture.snapshot.input.pullRequests[0];

  assert.ok(pull);

  const invalid = { ...pull, title: "Initial application", body: "No release metadata" };
  const input = { ...fixture.snapshot.input, pullRequests: [invalid] };

  await assert.rejects(
    captureReleaseSnapshot(input, configuration(base)),
    /metadata must be repaired/u,
  );
  await assert.rejects(
    captureReleaseSnapshot(
      {
        ...input,
        range: {
          ...input.range,
          baseline: { kind: "tag", name: "v1.2.3", objectSha: base, commitSha: base },
        },
      },
      configuration(),
    ),
    /metadata must be repaired/u,
  );
});

void test("new unassociated commits cannot reuse the legacy exemption while the first release is pending", async () => {
  const input = commitHistory();
  const mixed = {
    ...input,
    range: { ...input.range, sourceCommitSha: second, commitShas: [first, second] },
    bootstrapCommits: [
      ...input.bootstrapCommits,
      { sha: second, parentShas: [first], message: "fix: add a new direct change" },
    ],
  };

  await assert.rejects(
    captureReleaseSnapshot(mixed, configuration()),
    /after onboarding require verified/u,
  );
});

void test("onboarding configuration and snapshots reject moved, missing, mismatched and forged boundaries", async () => {
  const config = configuration();

  for (const value of [
    { ...config, schemaVersion: "2" },
    { ...config, bootstrap: null },
    { ...config, bootstrap: { baselineSha: base } },
    { ...config, bootstrap: { ...config.bootstrap, onboardingSha: "main" } },
    { ...config, bootstrap: { ...config.bootstrap, valid: true } },
    { ...config, schemaVersion: 1 },
  ])
    assert.throws(() => parseReleaseInputConfiguration(value));

  await assert.rejects(
    captureReleaseSnapshot(commitHistory(), configuration(second)),
    /pinned onboarding SHA/u,
  );
  await assert.rejects(
    captureReleaseSnapshot(commitHistory(), {
      ...config,
      bootstrap: { ...config.bootstrap, baselineSha: second },
    }),
    /baseline differs/u,
  );

  const serialized = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(commitHistory(), config),
  );

  await assert.rejects(
    replayReleaseSnapshot(serialized, configuration(base)),
    /configuration differs/u,
  );

  const changed: unknown = JSON.parse(serialized);

  assert.ok(typeof changed === "object" && changed !== null && "normalized" in changed);

  const normalized = changed.normalized;

  assert.ok(
    typeof normalized === "object" && normalized !== null && "historicalEntries" in normalized,
  );
  assert.ok(Array.isArray(normalized.historicalEntries));

  const entry: unknown = normalized.historicalEntries[0];

  assert.ok(typeof entry === "object" && entry !== null && "warnings" in entry);

  entry.warnings = [];

  await assert.rejects(
    replayReleaseSnapshot(JSON.stringify(changed), config),
    /normalized output differs/u,
  );
});

void test("adopting an existing released application never resets its version to 0.1.0", async () => {
  const fixture = await releaseFixture([{ title: "fix(app): retain configuration" }], "1.2.3");
  const config = configuration();
  const serialized = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(fixture.snapshot.input, config),
  );
  const plan = await createReleasePlan(serialized, config, {
    kind: "released",
    currentVersion: "1.2.3",
  });

  assert.equal(plan.nextVersion, "1.2.4");
  assert.equal(plan.onboardingSha, null);
  assert.deepEqual(plan.historicalContributions, []);

  await assert.rejects(
    createReleasePlan(serialized, config, initial),
    /cannot replace a captured released baseline/u,
  );
});
