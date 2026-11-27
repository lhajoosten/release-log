import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { selectProducer } from "../scripts/resolve-release-producer.ts";

void test("only an immutable producer in the trusted provider ancestry can be selected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-producer-test-"));
  const execute = promisify(execFile);
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", directory, ...args])).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(directory, "source"), "first");
    await git("add", "source");
    await git("commit", "-qm", "first");
    const first = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "source"), "second");
    await git("commit", "-qam", "second");
    const current = await git("rev-parse", "HEAD");
    await git("update-ref", "refs/remotes/origin/main", current);
    assert.equal(await selectProducer(directory, current, first), first);
    assert.equal(await selectProducer(directory, current, current), current);
    await assert.rejects(selectProducer(directory, current, "main"), /full commit SHAs/u);
    await git("checkout", "-q", "--orphan", "untrusted");
    await git("commit", "--allow-empty", "-qm", "untrusted");
    const untrusted = await git("rev-parse", "HEAD");
    await git("checkout", "-q", "--detach", current);
    await assert.rejects(selectProducer(directory, current, untrusted), /outside protected/u);
    await git("update-ref", "refs/remotes/origin/main", first);
    await assert.rejects(selectProducer(directory, current, first), /outside protected/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("verification workflows build the selected provider before write credentials and retain the current writer", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["release-promote", "release-publish", "release-quality"]) {
    const workflow = await readFile(
      new URL(`../.github/workflows/${name}.yaml`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /resolve-release-producer\.ts/u);
    assert.match(workflow, /ROLLING_RELEASE_REVIEW_HEAD/u);
    assert.match(workflow, /ROLLING_RELEASE_REVIEW_SHA/u);
    assert.match(workflow, /ROLLING_RELEASE_REVIEW_RUNTIME/u);
    assert.match(workflow, /\$GITHUB_WORKSPACE\/tool\/dist\/src\/cli\.js/u);
    const build = workflow.indexOf("Build the verified reviewed producer before credentials");
    assert.ok(build > 0);
    const mint = workflow.indexOf("Mint scoped repository token");
    if (mint >= 0) assert.ok(build < mint);
  }
});
