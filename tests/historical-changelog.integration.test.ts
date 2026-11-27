import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { historicalChangelog } from "../src/controller/backfill.ts";

void test("backfill ranges and bytes depend only on tags and captured PR data", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "backfill-tags-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-qm", "Root");
  const first = git("rev-parse", "HEAD");
  git("tag", "v0.1.0");
  git("commit", "--allow-empty", "-qm", "Fix");
  const second = git("rev-parse", "HEAD");
  git("tag", "-a", "v0.1.1", "-m", "Stable");
  git("tag", "v0.1.2-rc.1");
  const ranges: (string | null)[][] = [];
  const collect = async (_root: string, _repo: string, base: string | null, head: string) => {
    ranges.push([base, head]);
    return [
      {
        number: base ? 2 : 1,
        title: base ? "fix: second" : "feat: first",
        author: null,
        requiredAction: null,
      },
    ];
  };
  const missing = await historicalChangelog(root, "acme/widget", second, null, collect);
  assert.deepEqual(ranges, [
    [null, first],
    [first, second],
  ]);
  writeFileSync(join(root, "CHANGELOG.md"), "unrelated completely inconsistent prose");
  assert.deepEqual(await historicalChangelog(root, "acme/widget", second, null, collect), missing);
  assert.equal(missing.markdown.match(/Full changelog/gu)?.length, 1);
  assert.ok(missing.markdown.startsWith("# Changelog\n\n## v0.1.1\n"));
  assert.ok(missing.markdown.endsWith("([#1](https://github.com/acme/widget/pull/1))\n"));
  await assert.rejects(
    historicalChangelog(root, "acme/widget", second, null, async (r, repo, b, h) => {
      if (b) throw new Error("Ambiguous commit " + h);
      return collect(r, repo, b, h);
    }),
    (error) =>
      error instanceof Error &&
      error.message.includes("v0.1.1") &&
      error.message.includes("Ambiguous commit " + second),
  );
});
