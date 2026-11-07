import assert from "node:assert/strict";
import { test } from "node:test";

import { validateConventionalMessage } from "../src/conventional.ts";

void test("extracts conventional metadata without rewriting the source message", async () => {
  const raw = "feat(exports): support selected rows\n\nKeep the selection when exporting.\n";

  const result = await validateConventionalMessage(raw);

  assert.deepEqual(result, {
    valid: true,
    commit: {
      raw,
      type: "feat",
      scope: "exports",
      description: "support selected rows",
      breaking: false,
      breakingChanges: [],
    },
    warnings: [],
  });
});

for (const type of [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]) {
  void test(`accepts the existing conventional type ${type}`, async () => {
    const result = await validateConventionalMessage(`${type}: update release processing`);

    assert.ok(result.valid);
    assert.equal(result.commit.type, type);
    assert.equal(result.commit.scope, null);
  });
}

const invalidMessages: readonly (readonly [string, string])[] = [
  ["empty input", ""],
  ["whitespace input", " \r\n\t"],
  ["missing type", "support selected rows"],
  ["missing description", "feat: "],
  ["unsupported type", "feature: support selected rows"],
  ["uppercase type", "FEAT: support selected rows"],
  ["sentence-case subject", "feat: Support selected rows"],
  ["subject full stop", "feat: support selected rows."],
  ["oversized header", `feat: ${"a".repeat(100)}`],
  ["generated merge message", "Merge pull request #1 from example/branch"],
];

for (const [name, raw] of invalidMessages) {
  void test(`reports structured validation errors for ${name}`, async () => {
    const result = await validateConventionalMessage(raw);

    assert.equal(result.valid, false);
    assert.ok(!result.valid);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.every(({ rule, message }) => rule.length > 0 && message.length > 0));
    assert.equal("commit" in result, false);
  });
}

void test("identifies a breaking header without requiring a footer", async () => {
  const result = await validateConventionalMessage("feat(api)!: remove legacy export");

  assert.ok(result.valid);
  assert.equal(result.commit.breaking, true);
  assert.deepEqual(result.commit.breakingChanges, ["remove legacy export"]);
});

for (const keyword of ["BREAKING CHANGE", "BREAKING-CHANGE"]) {
  void test(`preserves the explanation from a ${keyword} footer`, async () => {
    const raw = `fix: require an export key\n\n${keyword}: callers must supply a key\n  for every export.`;

    const result = await validateConventionalMessage(raw);

    assert.ok(result.valid);
    assert.equal(result.commit.breaking, true);
    assert.deepEqual(result.commit.breakingChanges, [
      "callers must supply a key\n  for every export.",
    ]);
    assert.equal(result.commit.raw, raw);
  });
}

void test("does not infer a breaking change from ordinary prose", async () => {
  const result = await validateConventionalMessage(
    "fix: avoid breaking exports\n\nThis mentions BREAKING CHANGE without declaring a footer.",
  );

  assert.ok(result.valid);
  assert.equal(result.commit.breaking, false);
});

void test("retains warnings without changing the existing error-only rejection policy", async () => {
  const raw = "feat: support selected rows\nBody without a leading blank line.";

  const result = await validateConventionalMessage(raw);

  assert.ok(result.valid);
  assert.equal(result.commit.raw, raw);
  assert.ok(result.warnings.some(({ rule }) => rule === "body-leading-blank"));
});

void test("treats shell-like text as data", async () => {
  const raw = "fix: preserve $(touch sentinel) and `commands` literally";

  const result = await validateConventionalMessage(raw);

  assert.ok(result.valid);
  assert.equal(result.commit.raw, raw);
  assert.equal(result.commit.description, "preserve $(touch sentinel) and `commands` literally");
});

void test("preserves original CRLF input", async () => {
  const raw = "feat: support selected rows\r\n\r\nKeep the selection.\r\n";

  const result = await validateConventionalMessage(raw);

  assert.ok(result.valid);
  assert.equal(result.commit.raw, raw);
});

void test("produces the same structured result for repeated input", async () => {
  const raw = "feat(api)!: remove legacy export";

  const first = await validateConventionalMessage(raw);
  const second = await validateConventionalMessage(raw);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
