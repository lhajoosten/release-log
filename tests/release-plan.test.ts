import assert from "node:assert/strict";
import { test } from "node:test";
import { createReleasePlan, ReleasePlanError } from "../src/release-plan.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

for (const [title, current, next, bump] of [
  ["feat(api): export rows", "1.2.3", "1.3.0", "minor"],
  ["fix(api): retain keys", "1.2.3", "1.2.4", "patch"],
  ["perf(api): reduce allocations", "1.2.3", "1.2.4", "patch"],
  ["revert(api): restore keys", "1.2.3", "1.2.4", "patch"],
  ["feat(api)!: remove keys", "1.2.3", "2.0.0", "major"],
  ["docs(api)!: remove the contract", "1.2.3", "2.0.0", "major"],
  ["chore(api)!: remove the contract", "0.4.7", "0.5.0", "minor"],
  ["feat(api): export rows", "0.4.7", "0.5.0", "minor"],
  ["fix(api): retain keys", "0.4.7", "0.4.8", "patch"],
  ["feat(api)!: remove keys", "0.99.9", "0.100.0", "minor"],
  ["fix(api): retain keys", "9007199254740993.0.0", "9007199254740993.0.1", "patch"],
] as const) {
  void test(`${title} at ${current} produces ${next}`, async () => {
    const { serialized } = await releaseFixture(
      [{ title, action: title.includes("!") ? "Migrate keys." : null }],
      current,
    );
    const plan = await createReleasePlan(serialized, fixtureConfiguration, {
      kind: "released",
      currentVersion: current,
    });
    assert.equal(plan.nextVersion, next);
    assert.equal(plan.bump, bump);
    assert.equal(plan.release, true);
    assert.equal(plan.contributions[0]?.breaking, title.includes("!"));
  });
}

for (const type of ["build", "chore", "ci", "docs", "refactor", "style", "test"]) {
  void test(`${type} retains evidence without advancing the baseline`, async () => {
    const { serialized } = await releaseFixture([
      { title: `${type}(api): explain keys`, audience: "internal" },
    ]);
    const plan = await createReleasePlan(serialized, fixtureConfiguration, {
      kind: "released",
      currentVersion: "1.2.3",
    });
    assert.equal(plan.release, false);
    assert.equal(plan.nextVersion, null);
    assert.equal(plan.bump, "none");
    assert.equal(plan.contributions.length, 1);
    assert.equal(plan.currentVersion, "1.2.3");
  });
}

void test("mixed batches choose the highest PR-title bump once, preserving internal and nonreleasing entries", async () => {
  const { serialized, snapshot } = await releaseFixture([
    { title: "fix(api): retain keys", message: "feat: add internal support" },
    { title: "docs(api): explain keys" },
    { title: "feat(engine): cache results", audience: "internal" },
  ]);
  const plan = await createReleasePlan(serialized, fixtureConfiguration, {
    kind: "released",
    currentVersion: "1.2.3",
  });
  assert.equal(plan.nextVersion, "1.3.0");
  assert.deepEqual(
    plan.contributions.map(({ number, bump }) => [number, bump]),
    [
      [1, "patch"],
      [2, "none"],
      [3, "minor"],
    ],
  );
  assert.equal(plan.snapshotId, snapshot.snapshotId);
  assert.deepEqual(await createReleasePlan(serialized, fixtureConfiguration, plan.version), plan);
});

for (const changes of [
  [],
  [{ title: "docs(api): explain keys" }],
  [{ title: "feat(api): export rows" }],
  [{ title: "feat(api)!: remove keys", action: "Migrate keys." }],
]) {
  void test(`bootstrap with ${JSON.stringify(changes)} follows the fixed initial-version policy`, async () => {
    const { serialized } = await releaseFixture(changes, null);
    const plan = await createReleasePlan(serialized, fixtureConfiguration, {
      kind: "bootstrap",
      initialVersion: "0.1.0",
    });
    const releases = changes.some(({ title }) => title.startsWith("feat"));
    assert.equal(plan.nextVersion, releases ? "0.1.0" : null);
    assert.equal(plan.bump, releases ? "initial" : "none");
    assert.equal(plan.currentVersion, null);
  });
}

void test("breaking commit evidence is preserved and conflicting metadata cannot produce a plan", async () => {
  const { serialized } = await releaseFixture([
    {
      title: "fix(api)!: require keys",
      action: "Supply a key.",
      message: "fix: require keys\n\nBREAKING CHANGE: supply a key",
    },
  ]);
  const plan = await createReleasePlan(serialized, fixtureConfiguration, {
    kind: "released",
    currentVersion: "1.2.3",
  });
  assert.equal(plan.nextVersion, "2.0.0");
  assert.equal(plan.contributions[0]?.breaking, true);
  const altered = serialized.replaceAll("fix(api)!: require keys", "fix(api): require keys");
  await assert.rejects(
    createReleasePlan(altered, fixtureConfiguration, plan.version),
    /metadata must be repaired/u,
  );
});

void test("invalid versions, mode mismatches, and unknown configuration fail explicitly", async () => {
  const { serialized } = await releaseFixture([{ title: "fix(api): retain keys" }]);
  for (const currentVersion of [
    "",
    "v1.2.3",
    "01.2.3",
    "1.2",
    "1.2.3-beta",
    "1.2.3+build",
    "-1.2.3",
    "1.2.3\n",
    "9".repeat(129) + ".0.0",
    "2.0.0",
  ]) {
    await assert.rejects(
      createReleasePlan(serialized, fixtureConfiguration, { kind: "released", currentVersion }),
      ReleasePlanError,
    );
  }
  await assert.rejects(
    createReleasePlan(serialized, fixtureConfiguration, {
      kind: "bootstrap",
      initialVersion: "0.1.0",
    }),
    ReleasePlanError,
  );
  await assert.rejects(
    Reflect.apply(createReleasePlan, undefined, [
      serialized,
      fixtureConfiguration,
      { kind: "bootstrap", initialVersion: "1.0.0" },
    ]),
    ReleasePlanError,
  );
  await assert.rejects(
    Reflect.apply(createReleasePlan, undefined, [
      serialized,
      fixtureConfiguration,
      { kind: "released", currentVersion: "1.2.3", override: "major" },
    ]),
    ReleasePlanError,
  );
  const bootstrap = await releaseFixture([], null);
  await assert.rejects(
    createReleasePlan(bootstrap.serialized, fixtureConfiguration, {
      kind: "released",
      currentVersion: "1.2.3",
    }),
    ReleasePlanError,
  );
});
