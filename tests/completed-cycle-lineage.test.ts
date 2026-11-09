import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";

const inheritedGitVariables = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
] as const;

function runGit(directory: string, args: readonly string[]) {
  const environment = { ...process.env };
  for (const variable of inheritedGitVariables) delete environment[variable];

  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      `core.hooksPath=${join(directory, "disabled-hooks")}`,
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment,
        GIT_AUTHOR_NAME: "Release Log Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Release Log Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );

  if (result.error) throw result.error;
  return result;
}

function git(directory: string, args: readonly string[]): string {
  const result = runGit(directory, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

function isAncestor(directory: string, ancestor: string, descendant: string): boolean {
  const result = runGit(directory, ["merge-base", "--is-ancestor", ancestor, descendant]);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.status === 0;
}

async function temporaryRepository(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "release-log-cycle-lineage-"));
  const repository = join(directory, "work");
  const remote = join(directory, "remote.git");
  await mkdir(repository);
  context.after(async () => rm(directory, { recursive: true, force: true }));

  git(repository, ["init", "--initial-branch=main", "--object-format=sha1"]);
  git(repository, ["init", "--bare", "--initial-branch=main", remote]);
  git(repository, ["config", "user.name", "Release Log Test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);

  await writeFile(join(repository, "app.txt"), "initial application\n");
  git(repository, ["add", "app.txt"]);
  git(repository, ["commit", "-m", "chore: initialize test repository"]);

  return { repository, remote };
}

function commitTree(
  repository: string,
  tree: string,
  parents: readonly string[],
  message: string,
): string {
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  args.push("-m", message);
  return git(repository, args);
}

for (const landingKind of ["merge", "squash"] as const) {
  void test(`${landingKind} landing permits a fast-forward-only next proposal on the stable branch`, async (context) => {
    const { repository, remote } = await temporaryRepository(context);

    await writeFile(join(repository, "feature.txt"), "first-cycle change\n");
    git(repository, ["add", "feature.txt"]);
    git(repository, ["commit", "-m", "feat: add first-cycle behavior"]);
    const source1 = git(repository, ["rev-parse", "HEAD"]);

    git(repository, ["switch", "-c", "release-log/main"]);
    await writeFile(join(repository, "CHANGELOG.md"), "# Changelog\n\n## v1.3.0\n\nFirst cycle.\n");
    git(repository, ["add", "CHANGELOG.md"]);
    git(repository, ["commit", "-m", "chore: prepare v1.3.0"]);
    const head1 = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["push", "--porcelain", remote, `${head1}:refs/heads/release-log/main`]);
    git(repository, ["switch", "main"]);

    let landing1: string;
    if (landingKind === "merge") {
      git(repository, ["merge", "--no-ff", "--no-edit", "release-log/main"]);
      landing1 = git(repository, ["rev-parse", "HEAD"]);
      assert.deepEqual(git(repository, ["show", "-s", "--format=%P", landing1]).split(" "), [
        source1,
        head1,
      ]);
      assert.equal(isAncestor(repository, head1, landing1), true);
    } else {
      landing1 = commitTree(
        repository,
        git(repository, ["rev-parse", `${head1}^{tree}`]),
        [source1],
        "chore: prepare v1.3.0\n\nDistinct squash landing fixture",
      );
      git(repository, ["update-ref", "refs/heads/main", landing1, source1]);
      git(repository, ["reset", "--hard", landing1]);
      assert.deepEqual(git(repository, ["show", "-s", "--format=%P", landing1]).split(" "), [
        source1,
      ]);
      assert.equal(isAncestor(repository, head1, landing1), false);
    }

    const originalChangelog = await readFile(join(repository, "CHANGELOG.md"), "utf8");
    await writeFile(
      join(repository, "CHANGELOG.md"),
      `${originalChangelog}\n## Maintainer follow-up\n\nKeep this ordinary post-release change.\n`,
    );
    await writeFile(join(repository, "post-release.txt"), "ordinary change after landing\n");
    git(repository, ["add", "CHANGELOG.md", "post-release.txt"]);
    git(repository, ["commit", "-m", "docs: record post-release follow-up"]);
    const source2 = git(repository, ["rev-parse", "HEAD"]);

    assert.equal(isAncestor(repository, landing1, source2), true);
    assert.equal(isAncestor(repository, head1, source2), landingKind === "merge");

    git(repository, ["switch", "-c", "release-log/next-cycle"]);
    const sourceChangelog = await readFile(join(repository, "CHANGELOG.md"), "utf8");
    const nextChangelog = sourceChangelog.replace(
      "# Changelog\n\n",
      "# Changelog\n\n## v1.4.0\n\nSecond-cycle generated entry.\n\n",
    );
    assert.notEqual(nextChangelog, sourceChangelog);
    await writeFile(join(repository, "CHANGELOG.md"), nextChangelog);
    git(repository, ["add", "CHANGELOG.md"]);
    git(repository, ["commit", "-m", "chore: prepare v1.4.0"]);
    const nextProposalTree = git(repository, ["rev-parse", "HEAD^{tree}"]);

    const unbridgedHead = commitTree(
      repository,
      nextProposalTree,
      [source2],
      "chore: prepare v1.4.0",
    );
    const unbridgedPush = runGit(repository, [
      "push",
      "--porcelain",
      remote,
      `${unbridgedHead}:refs/heads/release-log/main`,
    ]);

    if (landingKind === "merge") {
      assert.equal(unbridgedPush.status, 0, unbridgedPush.stderr);
      assert.deepEqual(git(repository, ["show", "-s", "--format=%P", unbridgedHead]).split(" "), [
        source2,
      ]);
    } else {
      assert.notEqual(unbridgedPush.status, 0);
      assert.equal(
        git(repository, ["--git-dir", remote, "rev-parse", "refs/heads/release-log/main"]),
        head1,
      );

      const bridgedHead = commitTree(
        repository,
        nextProposalTree,
        [source2, head1],
        "chore: prepare v1.4.0",
      );
      assert.deepEqual(git(repository, ["show", "-s", "--format=%P", bridgedHead]).split(" "), [
        source2,
        head1,
      ]);
      assert.equal(isAncestor(repository, head1, bridgedHead), true);
      git(repository, [
        "push",
        "--porcelain",
        remote,
        `${bridgedHead}:refs/heads/release-log/main`,
      ]);
      assert.equal(
        git(repository, ["--git-dir", remote, "rev-parse", "refs/heads/release-log/main"]),
        bridgedHead,
      );
    }

    const nextHead =
      landingKind === "merge"
        ? unbridgedHead
        : git(repository, ["--git-dir", remote, "rev-parse", "refs/heads/release-log/main"]);
    assert.equal(isAncestor(repository, head1, nextHead), true);
    assert.equal(
      git(repository, ["show", `${nextHead}:post-release.txt`]),
      "ordinary change after landing",
    );
    const nextChangelogText = git(repository, ["show", `${nextHead}:CHANGELOG.md`]);
    assert.match(nextChangelogText, /## v1\.4\.0/u);
    assert.match(nextChangelogText, /Keep this ordinary post-release change\./u);
  });
}

void test("an ordinary change before merge makes the captured source differ from the landing first parent", async (context) => {
  const { repository } = await temporaryRepository(context);

  await writeFile(join(repository, "feature.txt"), "proposal change\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["commit", "-m", "feat: add proposed behavior"]);
  const capturedSource = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "-c", "release-log/main"]);
  await writeFile(join(repository, "CHANGELOG.md"), "# Changelog\n\nPending release.\n");
  git(repository, ["add", "CHANGELOG.md"]);
  git(repository, ["commit", "-m", "chore: prepare v1.3.0"]);
  const proposalHead = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "main"]);
  await writeFile(join(repository, "ordinary-before-merge.txt"), "must remain in history\n");
  git(repository, ["add", "ordinary-before-merge.txt"]);
  git(repository, ["commit", "-m", "docs: add ordinary change before release merge"]);
  const changedSource = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["merge", "--no-ff", "--no-edit", "release-log/main"]);
  const landing = git(repository, ["rev-parse", "HEAD"]);

  assert.equal(isAncestor(repository, capturedSource, landing), true);
  assert.deepEqual(git(repository, ["show", "-s", "--format=%P", landing]).split(" "), [
    changedSource,
    proposalHead,
  ]);
  assert.notEqual(changedSource, capturedSource);
  assert.notDeepEqual(git(repository, ["show", "-s", "--format=%P", landing]).split(" "), [
    capturedSource,
    proposalHead,
  ]);
  assert.equal(
    git(repository, ["show", `${landing}:ordinary-before-merge.txt`]),
    "must remain in history",
  );
});
