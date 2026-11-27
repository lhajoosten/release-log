import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readChanges } from "../src/controller/history.ts";

void test("full-history collection includes only a uniquely verified root PR", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-history-"));
  const previousToken = process.env.GITHUB_TOKEN;
  const previousBranch = process.env.ROLLING_RELEASE_BRANCH;
  process.env.GITHUB_TOKEN = "synthetic-token";
  process.env.ROLLING_RELEASE_BRANCH = "main";
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "-q");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    const head = git("rev-parse", "HEAD");
    const pull = {
      number: 1,
      state: "closed",
      merged: true,
      merged_at: "2026-01-01",
      merge_commit_sha: head,
      base: { ref: "main", repo: { full_name: "acme/widget" } },
      title: "feat: initialize",
      body: "Required action: configure it",
      updated_at: "2026-01-01",
      user: { login: "alice" },
    };
    const read = (url: string) =>
      Promise.resolve(Response.json(url.includes("/commits/") ? [pull] : pull));
    assert.deepEqual(await readChanges(directory, "acme/widget", null, head, read), [
      { number: 1, title: "feat: initialize", author: "alice", requiredAction: "configure it" },
    ]);
    await assert.rejects(
      readChanges(directory, "acme/widget", null, head, () => Promise.resolve(Response.json([]))),
      /no unique verified PR landing/u,
    );
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "generated release",
    );
    const landing = git("rev-parse", "HEAD");
    const automation = {
      number: 2,
      state: "closed",
      merged: true,
      merged_at: "2026-01-01",
      merge_commit_sha: landing,
      base: { ref: "main", repo: { full_name: "acme/widget" } },
      head: { ref: "release/next", repo: { full_name: "acme/widget" } },
    };
    const automationRead = (url: string) =>
      Promise.resolve(Response.json(url.includes("/commits/") ? [automation] : automation));
    let verified = 0;
    assert.deepEqual(
      await readChanges(directory, "acme/widget", head, landing, automationRead, () => {
        verified++;
        return Promise.resolve(landing);
      }),
      [],
    );
    assert.equal(verified, 1);
    await assert.rejects(
      readChanges(directory, "acme/widget", head, landing, automationRead, () =>
        Promise.resolve(head),
      ),
      /failed landing verification/u,
    );
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    if (previousBranch === undefined) delete process.env.ROLLING_RELEASE_BRANCH;
    else process.env.ROLLING_RELEASE_BRANCH = previousBranch;
    await rm(directory, { recursive: true, force: true });
  }
});
