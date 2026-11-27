import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { verifyHistoricalRelease } from "../src/controller/legacy.ts";
import { Remote, object, sha } from "../src/controller/remote.ts";
const exec = promisify(execFile);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

void test("historical release requires its exact tag, trusted owner and reviewed generated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-release-"));
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "package.json"), '{"version":"0.0.0"}\n');
    await git("add", ".");
    await git("commit", "-qm", "source");
    const source = await git("rev-parse", "HEAD");
    await mkdir(join(root, ".release-log"));
    const snapshot = JSON.stringify({
      schemaVersion: 3,
      snapshotId: "abc",
      configurationId: "def",
      input: { range: { sourceCommitSha: source }, releaseBranch: "main" },
    });
    const changelog = "# Changelog\n\n## v0.1.0\n";
    await writeFile(join(root, ".release-log/inputs.json"), snapshot);
    await writeFile(join(root, "CHANGELOG.md"), changelog);
    await git("add", ".");
    await git("commit", "-qm", "proposal");
    const head = await git("rev-parse", "HEAD");
    await git("tag", "v0.1.0", head);
    const marker = {
      schemaVersion: 1,
      sourceSha: source,
      botUserId: 7,
      repositoryId: 10,
      releaseBranch: "main",
      snapshotId: "abc",
      configurationId: "def",
      files: [
        { path: ".release-log/inputs.json", sha256: digest(snapshot) },
        { path: "CHANGELOG.md", sha256: digest(changelog) },
      ],
    };
    const pull = {
      title: "chore(release): prepare v0.1.0",
      body: `<!-- release-log:proposal:v1 ${Buffer.from(JSON.stringify(marker)).toString("base64url")} -->`,
      user: { id: 7, login: "release[bot]", type: "Bot" },
      state: "closed",
      merged: true,
      merge_commit_sha: head,
      head: { sha: head, ref: "release-log/main", repo: { full_name: "acme/widget" } },
      base: { ref: "main", repo: { id: 10, full_name: "acme/widget" } },
    };
    const remote = new Remote("acme/widget", "synthetic", "release[bot]");
    Object.defineProperties(remote, {
      tag: { value: async () => head, configurable: true },
      ref: { value: async () => head },
      request: { value: async () => ({ sha: head, commit: { verification: { verified: true } } }) },
    });
    assert.equal(await verifyHistoricalRelease(root, remote, pull), head);
    Object.defineProperty(remote, "tag", { value: async () => source });
    await assert.rejects(
      verifyHistoricalRelease(root, remote, pull),
      /does not independently resolve/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [version, number] of [
  ["0.1.0", 62],
  ["0.8.3", 179],
] as const) {
  void test(`the captured v${version} legacy proposal matches its tagged tree`, async (context) => {
    const root = process.cwd();
    try {
      await exec("git", ["-C", root, "cat-file", "-e", `refs/tags/v${version}^{commit}`]);
    } catch {
      context.skip("historical tag is not available in this checkout");
      return;
    }
    const pull: Record<string, unknown> = JSON.parse(
      await readFile(join(root, `tests/fixtures/legacy-release-${number}.json`), "utf8"),
    );
    const landing = String(pull.merge_commit_sha);
    const head = sha(object(pull.head).sha);
    const remote = new Remote(
      "lhajoosten/rolling-release",
      "synthetic",
      "rolling-release-log[bot]",
    );
    Object.defineProperties(remote, {
      tag: { value: async () => landing },
      ref: { value: async () => landing },
      request: { value: async () => ({ sha: head, commit: { verification: { verified: true } } }) },
    });
    assert.equal(await verifyHistoricalRelease(root, remote, pull), landing);
  });
}

void test("the unpublished cutover verifies reviewed evidence independently of later v0.9.0 tags", async (context) => {
  const root = process.cwd();
  const landing = "f35f7ed711cc564d6fd71d51d9c781792a84f31c";
  try {
    await exec("git", ["-C", root, "cat-file", "-e", `${landing}^{commit}`]);
  } catch {
    context.skip("historical landing is not available in this checkout");
    return;
  }
  const pull: Record<string, unknown> = JSON.parse(
    await readFile(join(root, "tests/fixtures/legacy-release-183.json"), "utf8"),
  );
  const head = sha(object(pull.head).sha);
  const remote = new Remote("lhajoosten/rolling-release", "synthetic", "rolling-release-log[bot]");
  Object.defineProperties(remote, {
    tag: {
      value: async () => {
        throw new Error("cutover must not consult version tag");
      },
    },
    ref: { value: async () => landing },
    request: { value: async () => ({ sha: head, commit: { verification: { verified: true } } }) },
  });
  assert.equal(await verifyHistoricalRelease(root, remote, pull), landing);

  await assert.rejects(
    verifyHistoricalRelease(root, remote, { ...pull, title: "chore(release): prepare v0.9.1" }),
    /cutover proposal identity/u,
  );
  await assert.rejects(
    verifyHistoricalRelease(root, remote, {
      ...pull,
      head: { ...object(pull.head), sha: landing },
    }),
    /cutover proposal identity/u,
  );
  await assert.rejects(verifyHistoricalRelease(root, remote, { ...pull, number: 184 }));
  await assert.rejects(verifyHistoricalRelease(root, remote, { ...pull, merge_commit_sha: head }));
  const body = String(pull.body);
  const encoded = /<!-- release-log:proposal:v1 ([A-Za-z0-9_-]+) -->/u.exec(body)?.[1];
  assert.ok(encoded);
  const marker: Record<string, unknown> = JSON.parse(Buffer.from(encoded, "base64url").toString());
  marker.snapshotId = "tampered";
  const tampered = Buffer.from(JSON.stringify(marker)).toString("base64url");
  await assert.rejects(
    verifyHistoricalRelease(root, remote, { ...pull, body: body.replace(encoded, tampered) }),
    /snapshot disagrees/u,
  );
  await assert.rejects(
    verifyHistoricalRelease(root, remote, { ...pull, user: { ...object(pull.user), id: 1 } }),
    /identity is inconsistent/u,
  );
  const other = new Remote("acme/widget", "synthetic", "rolling-release-log[bot]");
  const otherPull = {
    ...pull,
    head: { ...object(pull.head), repo: { full_name: "acme/widget" } },
    base: {
      ...object(pull.base),
      repo: { ...object(object(pull.base).repo), full_name: "acme/widget" },
    },
  };
  Object.defineProperty(other, "tag", { value: async () => null });
  await assert.rejects(verifyHistoricalRelease(root, other, otherPull));
});
