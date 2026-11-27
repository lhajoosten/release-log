import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import {
  collectMergedPullRequests,
  PullRequestAssociationError,
} from "../src/github-association.ts";
import { inspectCommit, inspectPendingRelease } from "../src/git.ts";
import { GitHubReadError, readGitHubJson } from "../src/github.ts";
import type { GitHubRead } from "../src/github.ts";
const execute = promisify(execFile);
const apiBase = "https://api.github.com/repos/example/project";
const token = "synthetic-association-token";

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execute(
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
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Association Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Association Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    },
  );
  return stdout.trim();
}

async function createCommit(directory: string, message: string): Promise<string> {
  await git(directory, ["commit", "--allow-empty", "-m", message]);
  return git(directory, ["rev-parse", "HEAD"]);
}

async function repository(context: TestContext, format = "sha1"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "release-log-association-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await git(directory, ["init", "--initial-branch=main", `--object-format=${format}`]);
  return directory;
}

async function original(directory: string, sha: string) {
  const evidence = await inspectCommit(directory, sha);
  return {
    sha,
    commit: { message: evidence.message },
    parents: evidence.parentShas.map((parent) => ({ sha: parent })),
  };
}

async function commitTree(directory: string, sha: string) {
  return git(directory, ["rev-parse", `${sha}^{tree}`]);
}

function pullFixture(
  number: number,
  landing: string,
  originalHead: string,
  count = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    id: number + 1000,
    state: "closed",
    merged: true,
    merged_at: "2099-01-01T00:00:00Z",
    updated_at: "2026-11-08T10:00:00Z",
    merge_commit_sha: landing,
    title: "feat(api): add exports",
    body: "Raw PR context; do not execute $(touch sentinel).",
    commits: count,
    user: { id: 11, type: "User" },
    base: { ref: "main", repo: { id: 1, full_name: "example/project" } },
    head: { sha: originalHead, ref: "feature", repo: { id: 2 } },
    ...overrides,
  };
}

function http() {
  const pulls = new Map<number, Record<string, unknown>>();
  const originals = new Map<number, unknown[]>();
  const links = new Map<string, unknown[]>();
  const overrides = new Map<string, () => Response>();
  const calls: { path: string; options: RequestInit }[] = [];
  const read: GitHubRead = (url, options) => {
    assert.ok(url.startsWith(apiBase + "/"));
    const path = url.slice(apiBase.length);
    calls.push({ path, options });
    const override = overrides.get(path);
    if (override) return Promise.resolve(override());
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page") ?? 1);
    const association = parsed.pathname.match(/\/commits\/([a-f0-9]+)\/pulls$/u)?.[1];
    let data: unknown;
    let next = false;
    if (association) {
      const all = links.get(association) ?? [];
      data = all.slice((page - 1) * 100, page * 100);
      next = all.length > page * 100;
    } else {
      const number = Number(parsed.pathname.match(/\/pulls\/(\d+)/u)?.[1]);
      if (parsed.pathname.endsWith("/commits")) {
        const all = originals.get(number);
        assert.ok(all, `Missing original fixture for PR ${number}`);
        data = all.slice((page - 1) * 100, page * 100);
        next = all.length > page * 100;
      } else {
        data = pulls.get(number);
        assert.ok(data, `Missing PR fixture ${number}`);
      }
    }
    return Promise.resolve(
      Response.json(
        data,
        next
          ? { headers: { link: '<https://attacker.invalid/not-followed>; rel="next"' } }
          : undefined,
      ),
    );
  };
  return { read, pulls, originals, links, overrides, calls };
}

async function linear(context: TestContext, format = "sha1") {
  const directory = await repository(context, format);
  const base = await createCommit(directory, "chore: bootstrap");
  const source = await createCommit(directory, "feat: add exports");
  const range = await inspectPendingRelease(
    directory,
    { kind: "bootstrap", commitSha: base },
    source,
  );
  const api = http();
  const metadata = pullFixture(1, source, source);
  api.pulls.set(1, metadata);
  api.originals.set(1, [await original(directory, source)]);
  api.links.set(source, [metadata]);
  const request = {
    repository: "example/project",
    releaseBranch: "main",
    localRepository: directory,
    range,
    token,
  };
  return { directory, base, source, api, metadata, request };
}

function hasCode(code: PullRequestAssociationError["code"]) {
  return (error: unknown) => error instanceof PullRequestAssociationError && error.code === code;
}

async function individuallySquashedStack(context: TestContext) {
  const directory = await repository(context);
  const base = await createCommit(directory, "chore: bootstrap");
  await git(directory, ["tag", "v1.0.0", base]);
  await git(directory, ["switch", "-c", "stack"]);
  const api = http();
  const heads = [base];
  const landings = [base];
  let precedingHead = base;
  let precedingLanding = base;
  let precedingBranch = "main";
  for (const [index, branch] of ["root", "middle", "tip"].entries()) {
    const number = index + 1;
    const title = `fix(app): add ${branch}`;
    await writeFile(join(directory, "entries"), String(number));
    await git(directory, ["add", "entries"]);
    const head = await createCommit(directory, title);
    const tree = await commitTree(directory, head);
    const landing = await git(directory, [
      "commit-tree",
      tree,
      "-p",
      precedingLanding,
      "-m",
      `${title} (#${number})`,
    ]);
    heads.push(head);
    landings.push(landing);

    const metadata = pullFixture(number, landing, head, 1, {
      title,
      body: "",
      base: {
        ref: precedingBranch,
        sha: precedingHead,
        repo: { id: 1, full_name: "example/project" },
      },
      head: { sha: head, ref: branch, repo: { id: 1 } },
    });
    api.pulls.set(number, metadata);
    api.originals.set(number, [await original(directory, head)]);
    api.links.set(landing, [metadata]);
    api.overrides.set(`/git/commits/${head}`, () =>
      Response.json({ sha: head, tree: { sha: tree } }),
    );
    precedingHead = head;
    precedingLanding = landing;
    precedingBranch = branch;
  }
  const range = await inspectPendingRelease(
    directory,
    { kind: "tag", name: "v1.0.0" },
    precedingLanding,
  );
  const request = {
    repository: "example/project",
    releaseBranch: "main",
    localRepository: directory,
    range,
    token,
  };
  const config = {
    schemaVersion: 1,
    repository: request.repository,
    repositoryId: 1,
    releaseBranch: "main",
    releasePolicy: "release-policy-v1",
    contextPolicy: "optional",
  } as const;
  return { api, config, request, heads, landings };
}

async function individuallySquashedStackWithFinalSyncMerge(
  context: TestContext,
  forkAtMiddleCommit = false,
) {
  const directory = await repository(context);
  const baseline = await createCommit(directory, "chore: bootstrap");
  await git(directory, ["tag", "v1.0.0", baseline]);

  await git(directory, ["switch", "-c", "root"]);
  await writeFile(join(directory, "root-first"), "first\n");
  await git(directory, ["add", "root-first"]);
  const rootFork = await createCommit(directory, "feat(api): add root first part");
  await writeFile(join(directory, "root-middle"), "middle\n");
  await git(directory, ["add", "root-middle"]);
  const rootMiddle = await createCommit(directory, "fix(api): add root middle part");
  const rootOriginals = [rootFork, rootMiddle];
  let rootHead = rootMiddle;
  for (const index of [1, 2, 3]) {
    const branch = `root-update-${index}`;
    await git(directory, ["switch", "-c", branch, baseline]);
    await writeFile(join(directory, `root-update-${index}`), `${index}\n`);
    await git(directory, ["add", `root-update-${index}`]);
    const update = await createCommit(directory, `docs(api): capture root update ${index}`);
    await git(directory, ["switch", "root"]);
    await git(directory, ["merge", "--no-ff", branch, "-m", `Merge root update ${index}`]);
    rootHead = await git(directory, ["rev-parse", "HEAD"]);
    rootOriginals.push(update, rootHead);
  }
  const rootTree = await commitTree(directory, rootHead);
  const rootLanding = await git(directory, [
    "commit-tree",
    rootTree,
    "-p",
    baseline,
    "-m",
    "feat(api): add root part (#1)",
  ]);

  await git(directory, ["switch", "-c", "tip", forkAtMiddleCommit ? rootMiddle : rootFork]);
  await writeFile(join(directory, "tip-first"), "first\n");
  await git(directory, ["add", "tip-first"]);
  const tipFirst = await createCommit(directory, "feat(api): add tip first part");
  await writeFile(join(directory, "tip-last"), "last\n");
  await git(directory, ["add", "tip-last"]);
  const tipLast = await createCommit(directory, "test(api): finish tip part");

  await git(directory, ["merge", "--no-commit", "--no-ff", rootHead]);
  const syncTree = await git(directory, ["write-tree"]);
  await git(directory, ["merge", "--abort"]);
  const syncHead = await git(directory, [
    "commit-tree",
    syncTree,
    "-p",
    tipLast,
    "-p",
    rootHead,
    "-m",
    "Merge root into tip",
  ]);
  const tipLanding = await git(directory, [
    "commit-tree",
    syncTree,
    "-p",
    rootLanding,
    "-m",
    "feat(api): add tip part (#2)",
  ]);

  const api = http();
  const rootPull = pullFixture(1, rootLanding, rootHead, rootOriginals.length, {
    title: "feat(api): add root part",
    body: "",
    base: {
      ref: "main",
      sha: baseline,
      repo: { id: 1, full_name: "example/project" },
    },
    head: { sha: rootHead, ref: "root", repo: { id: 1 } },
  });
  const tipPull = pullFixture(2, tipLanding, syncHead, 3, {
    title: "fix(api): add tip part",
    body: "",
    base: {
      ref: "root",
      sha: rootHead,
      repo: { id: 1, full_name: "example/project" },
    },
    head: { sha: syncHead, ref: "tip", repo: { id: 1 } },
  });
  api.pulls.set(1, rootPull);
  api.pulls.set(2, tipPull);
  api.originals.set(1, await Promise.all(rootOriginals.map((sha) => original(directory, sha))));
  api.originals.set(2, [
    ...(forkAtMiddleCommit ? [await original(directory, rootMiddle)] : []),
    await original(directory, tipFirst),
    await original(directory, tipLast),
    await original(directory, syncHead),
  ]);
  if (forkAtMiddleCommit) tipPull.commits = 4;
  api.links.set(rootLanding, [rootPull]);
  api.links.set(tipLanding, [tipPull]);
  api.overrides.set(`/git/commits/${rootHead}`, () =>
    Response.json({ sha: rootHead, tree: { sha: rootTree } }),
  );
  api.overrides.set(`/git/commits/${syncHead}`, () =>
    Response.json({ sha: syncHead, tree: { sha: syncTree } }),
  );
  api.overrides.set("/pulls?state=closed&base=root&per_page=100&page=1", () =>
    Response.json([tipPull]),
  );

  const range = await inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, tipLanding);
  const request = {
    repository: "example/project",
    releaseBranch: "main",
    localRepository: directory,
    range,
    token,
  };
  const config = {
    schemaVersion: 1,
    repository: request.repository,
    repositoryId: 1,
    releaseBranch: "main",
    releasePolicy: "release-policy-v1",
    contextPolicy: "optional",
  } as const;
  return {
    api,
    config,
    request,
    rootFork,
    rootMiddle,
    rootHead,
    rootLanding,
    tipFirst,
    tipLast,
    syncHead,
    tipLanding,
  };
}

void test("accepts an individually squashed stack continuation with an exact terminal base sync merge", async (context) => {
  const fixture = await individuallySquashedStackWithFinalSyncMerge(context);
  const associated = await collectMergedPullRequests(fixture.request, fixture.api.read);
  assert.deepEqual(
    associated.pullRequests.map((pull) => [
      pull.number,
      ...pull.landedCommits.map(({ sha }) => sha),
    ]),
    [
      [1, fixture.rootLanding],
      [2, fixture.tipLanding],
    ],
  );
});

void test("rejects missing, reordered, or already inherited commits in a base-sync merge", async (context) => {
  for (const mode of ["missing", "reordered"] as const) {
    const fixture = await individuallySquashedStackWithFinalSyncMerge(context);
    const originals = fixture.api.originals.get(2);
    const pull = fixture.api.pulls.get(2);
    assert.ok(originals && pull);
    const tipCommits = originals;
    const changed =
      mode === "missing" ? tipCommits.slice(1) : [tipCommits[1], tipCommits[0], tipCommits[2]];
    const updated = { ...pull, commits: changed.length };
    fixture.api.originals.set(2, changed);
    fixture.api.pulls.set(2, updated);
    fixture.api.overrides.set("/pulls?state=closed&base=root&per_page=100&page=1", () =>
      Response.json([updated]),
    );
    await assert.rejects(
      collectMergedPullRequests(fixture.request, fixture.api.read),
      /complete linear sequence or end in an exact stack-base sync merge/u,
    );
  }

  const inherited = await individuallySquashedStackWithFinalSyncMerge(context, true);
  await assert.rejects(
    collectMergedPullRequests(inherited.request, inherited.api.read),
    /complete linear sequence or end in an exact stack-base sync merge/u,
  );
});

void test("rejects unsupported merges and mismatched endpoint trees in a base-sync merge", async (context) => {
  const merged = await individuallySquashedStackWithFinalSyncMerge(context);
  const originals = merged.api.originals.get(2);
  assert.ok(originals);
  const terminal = originals.at(-1);
  assert.ok(terminal && typeof terminal === "object" && "parents" in terminal);
  const parents = terminal.parents;
  assert.ok(Array.isArray(parents));
  merged.api.originals.set(2, [
    ...originals.slice(0, -1),
    { ...terminal, parents: [...parents, { sha: merged.rootFork }] },
  ]);
  await assert.rejects(
    collectMergedPullRequests(merged.request, merged.api.read),
    /complete linear sequence or end in an exact stack-base sync merge/u,
  );

  const badBaseTree = await individuallySquashedStackWithFinalSyncMerge(context);
  const baseTreePath = `/git/commits/${badBaseTree.rootHead}`;
  badBaseTree.api.overrides.set(baseTreePath, () =>
    Response.json({ sha: badBaseTree.rootHead, tree: { sha: "f".repeat(40) } }),
  );
  await assert.rejects(
    collectMergedPullRequests(badBaseTree.request, badBaseTree.api.read),
    /original base and head trees must match the consecutive landed trees/u,
  );

  const badHeadTree = await individuallySquashedStackWithFinalSyncMerge(context);
  const headTreePath = `/git/commits/${badHeadTree.syncHead}`;
  badHeadTree.api.overrides.set(headTreePath, () =>
    Response.json({ sha: badHeadTree.syncHead, tree: { sha: "e".repeat(40) } }),
  );
  await assert.rejects(
    collectMergedPullRequests(badHeadTree.request, badHeadTree.api.read),
    /original base and head trees must match the consecutive landed trees/u,
  );
});

void test("individually squashed stack landings retain separate PR owners", async (context) => {
  const { api, request, landings } = await individuallySquashedStack(context);
  const associated = await collectMergedPullRequests(request, api.read);
  assert.deepEqual(
    associated.pullRequests.map((pull) => [
      pull.number,
      ...pull.landedCommits.map(({ sha }) => sha),
    ]),
    landings.slice(1).map((sha, index) => [index + 1, sha]),
  );
});
void test("rejects an individually squashed stack with mismatched trees or competing landing links", async (context) => {
  const { api, request, heads, landings } = await individuallySquashedStack(context);
  const [, , middleHead] = heads;
  const [, , middleLanding] = landings;
  const middle = api.pulls.get(2);
  assert.ok(middle && middleHead && middleLanding);
  const path = `/git/commits/${middleHead}`;
  const tree = api.overrides.get(path);
  assert.ok(tree);
  api.overrides.set(path, () => Response.json({ sha: middleHead, tree: { sha: middleLanding } }));
  await assert.rejects(
    collectMergedPullRequests(request, api.read),
    /must match the consecutive landed trees/u,
  );
  api.overrides.set(path, tree);

  api.links.set(middleLanding, [middle, { ...middle, number: 4 }]);
  await assert.rejects(
    collectMergedPullRequests(request, api.read),
    hasCode("ambiguous-association"),
  );
});

void test("requires the preceding PR of an individually squashed stack within the captured range", async (context) => {
  const { api, request, landings } = await individuallySquashedStack(context);
  const [, rootLanding] = landings;
  assert.ok(rootLanding);
  await git(request.localRepository, ["tag", "v1.0.1", rootLanding]);
  const range = await inspectPendingRelease(
    request.localRepository,
    { kind: "tag", name: "v1.0.1" },
    request.range.sourceCommitSha,
  );
  await assert.rejects(
    collectMergedPullRequests({ ...request, range }, api.read),
    hasCode("unassociated-commit"),
  );
});

void test("collects one PR per landing, retains raw evidence, and never selects by merge date", async (context) => {
  const fixture = await linear(context);
  const result = await collectMergedPullRequests(fixture.request, fixture.api.read);
  assert.equal(result.pullRequests.length, 1);
  const entry = result.pullRequests[0];
  assert.ok(entry);
  assert.equal(entry.number, 1);
  assert.equal(entry.body, fixture.metadata.body);
  assert.equal(entry.url, "https://github.com/example/project/pull/1");
  assert.equal(entry.landingKind, "linear");
  assert.deepEqual(
    entry.landedCommits.map((commit) => commit.sha),
    [fixture.source],
  );
  assert.equal(entry.mergedAt, "2099-01-01T00:00:00Z");
  assert.equal(JSON.stringify(result).includes(token), false);
  for (const call of fixture.api.calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.body, undefined);
    assert.equal(new Headers(call.options.headers).get("Authorization"), `Bearer ${token}`);
  }
});

void test("merge histories retain side-branch and structural merge evidence as one entry", async (context) => {
  const directory = await repository(context);
  const base = await createCommit(directory, "chore: bootstrap");
  await git(directory, ["switch", "-c", "feature"]);
  const first = await createCommit(directory, "feat: add exports");
  const second = await createCommit(directory, "fix: retain keys");
  await git(directory, ["switch", "main"]);
  await git(directory, [
    "merge",
    "--no-ff",
    "feature",
    "-m",
    "Merge pull request #1 from contributor/feature",
  ]);
  const source = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["switch", "-c", "unmerged"]);
  const excluded = await createCommit(directory, "feat: not merged");
  const range = await inspectPendingRelease(
    directory,
    { kind: "bootstrap", commitSha: base },
    source,
  );
  const api = http();
  const metadata = pullFixture(1, source, second, 2);
  api.pulls.set(1, metadata);
  api.originals.set(1, [await original(directory, first), await original(directory, second)]);
  api.links.set(first, [metadata]);
  api.links.set(second, [metadata]);
  const request = {
    repository: "example/project",
    releaseBranch: "main",
    localRepository: directory,
    range,
    token,
  };
  const result = await collectMergedPullRequests(request, api.read);
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.pullRequests[0]?.landingKind, "merge");
  assert.deepEqual(
    result.pullRequests[0]?.landedCommits.map((commit) => commit.sha),
    [first, second, source].toSorted(),
  );
  assert.ok(
    result.pullRequests[0]?.landedCommits.some(
      (commit) => commit.message.startsWith("Merge pull request") && commit.parentShas.length === 2,
    ),
  );
  assert.equal(
    api.calls.some((call) => call.path.includes(excluded)),
    false,
  );
  assert.equal(api.calls.filter((call) => call.path === "/pulls/1").length, 2);
});

// Upkeep #4 links 398cdc2 to the feature branch. Upkeep #5 lands that stack on main,
// before the fixed cutoff at #6. Recreate the topology with synthetic commits.
async function rebase(context: TestContext) {
  const fixture = await linear(context);
  const originalFirst = fixture.source;
  const originalSecond = await createCommit(fixture.directory, "fix: revise original PR");
  await git(fixture.directory, ["switch", "-c", "rebased", fixture.base]);
  const before = await createCommit(fixture.directory, "chore: new base");
  const first = await createCommit(fixture.directory, "feat: add exports");
  const source = await createCommit(fixture.directory, "fix: revise original PR");
  assert.notEqual(first, originalFirst);
  assert.notEqual(source, originalSecond);
  const metadata = pullFixture(1, source, originalSecond, 2);
  fixture.api.pulls.set(1, metadata);
  fixture.api.originals.set(1, [
    await original(fixture.directory, originalFirst),
    await original(fixture.directory, originalSecond),
  ]);
  fixture.api.links.clear();
  fixture.api.links.set(first, [metadata]);
  fixture.api.links.set(source, [metadata]);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "bootstrap", commitSha: before },
    source,
  );
  return { ...fixture, first, source, request: { ...fixture.request, range } };
}

void test("rebase histories verify actual rewritten sequence through graph and GitHub mapping", async (context) => {
  const fixture = await rebase(context);
  const result = await collectMergedPullRequests(fixture.request, fixture.api.read);
  const entry = result.pullRequests[0];
  assert.ok(entry);
  assert.deepEqual(
    entry.landedCommits.map((commit) => commit.sha),
    [fixture.first, fixture.source].toSorted(),
  );
  assert.ok(
    entry.originalCommits.every(
      (commit) => !entry.landedCommits.some((landed) => landed.sha === commit.sha),
    ),
  );
});

void test("rejects rebase membership split by the baseline", async (context) => {
  const fixture = await rebase(context);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "bootstrap", commitSha: fixture.first },
    fixture.source,
  );
  await assert.rejects(
    collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read),
    hasCode("partial-membership"),
  );
});

void test("tagged cycles fail when rewritten commit mapping leaves an in-range change unexplained", async (context) => {
  const fixture = await rebase(context);
  fixture.api.links.delete(fixture.first);
  await git(fixture.directory, ["tag", "v1.2.3", fixture.request.range.baseline.commitSha]);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "tag", name: "v1.2.3" },
    fixture.source,
  );
  await assert.rejects(
    collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read),
    hasCode("unassociated-commit"),
  );
});

void test("deduplicates each PR but rejects multiple qualifying owners of one commit", async (context) => {
  const fixture = await linear(context);
  const other = pullFixture(2, fixture.source, fixture.source);
  fixture.api.pulls.set(2, other);
  fixture.api.links.set(fixture.source, [fixture.metadata, other]);
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("ambiguous-association"),
  );
});

void test("excludes open, closed-unmerged, wrong-branch, wrong-repository, and later-landed PR associations", async (context) => {
  const fixture = await linear(context);
  const later = await createCommit(fixture.directory, "feat: later change");
  const excluded = [
    pullFixture(2, later, later),
    pullFixture(3, fixture.source, fixture.source, 1, {
      state: "open",
      merged_at: null,
      merged: false,
    }),
    pullFixture(4, fixture.source, fixture.source, 1, { merged_at: null, merged: false }),
    pullFixture(5, fixture.source, fixture.source, 1, {
      base: { ref: "other", repo: { full_name: "example/project" } },
    }),
    pullFixture(6, fixture.source, fixture.source, 1, {
      base: { ref: "main", repo: { full_name: "another/project" } },
    }),
  ];
  fixture.api.links.set(fixture.source, [...excluded, fixture.metadata]);
  const result = await collectMergedPullRequests(fixture.request, fixture.api.read);
  assert.deepEqual(
    result.pullRequests.map((pull) => pull.number),
    [1],
  );
  assert.equal(
    fixture.api.calls.some((call) => /^\/pulls\/[2-6]$/u.test(call.path)),
    false,
  );
});

void test("tagged cycles reject direct commits without producing partial success", async (context) => {
  const fixture = await linear(context);
  fixture.api.links.clear();
  await git(fixture.directory, ["tag", "v1.2.3", fixture.base]);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "tag", name: "v1.2.3" },
    fixture.source,
  );
  await assert.rejects(
    collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read),
    hasCode("unassociated-commit"),
  );
});

void test("bootstrap does not reclassify unexplained structural merges as direct commits", async (context) => {
  const directory = await repository(context);
  const base = await createCommit(directory, "chore: bootstrap");

  await git(directory, ["switch", "-c", "feature"]);
  await createCommit(directory, "feat: add exports");
  await git(directory, ["switch", "main"]);
  await git(directory, ["merge", "--no-ff", "feature", "-m", "Merge unexplained feature"]);

  const source = await git(directory, ["rev-parse", "HEAD"]);
  const range = await inspectPendingRelease(
    directory,
    { kind: "bootstrap", commitSha: base },
    source,
  );
  await assert.rejects(
    collectMergedPullRequests(
      {
        repository: "example/project",
        releaseBranch: "main",
        localRepository: directory,
        range,
        token,
      },
      http().read,
    ),
    hasCode("unassociated-commit"),
  );
});

void test("orders multiple deduplicated PRs independently of commit traversal order", async (context) => {
  const fixture = await linear(context);
  const second = await createCommit(fixture.directory, "fix: revise exports");
  const last = await createCommit(fixture.directory, "fix: add another PR");
  const firstPull = pullFixture(20, second, second, 2);
  const lastPull = pullFixture(3, last, last);
  fixture.api.pulls.clear();
  fixture.api.pulls.set(20, firstPull);
  fixture.api.pulls.set(3, lastPull);
  fixture.api.originals.clear();
  fixture.api.originals.set(20, [
    await original(fixture.directory, fixture.source),
    await original(fixture.directory, second),
  ]);
  fixture.api.originals.set(3, [await original(fixture.directory, last)]);
  fixture.api.links.set(fixture.source, [firstPull]);
  fixture.api.links.set(second, [firstPull]);
  fixture.api.links.set(last, [lastPull]);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "bootstrap", commitSha: fixture.base },
    last,
  );
  const result = await collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read);
  assert.deepEqual(
    result.pullRequests.map((entry) => entry.number),
    [3, 20],
  );
  assert.deepEqual(
    result.pullRequests[1]?.landedCommits.map((entry) => entry.sha),
    [fixture.source, second].toSorted(),
  );
});

void test("rejects a merge footprint crossing the exclusive baseline", async (context) => {
  const fixture = await linear(context);
  await git(fixture.directory, ["switch", "-c", "feature"]);
  const second = await createCommit(fixture.directory, "fix: second feature commit");
  await git(fixture.directory, ["switch", "-c", "release", fixture.base]);
  await git(fixture.directory, ["merge", "--no-ff", "feature", "-m", "Merge feature"]);
  const merge = await git(fixture.directory, ["rev-parse", "HEAD"]);
  const metadata = pullFixture(1, merge, second, 2);
  fixture.api.pulls.set(1, metadata);
  fixture.api.originals.set(1, [
    await original(fixture.directory, fixture.source),
    await original(fixture.directory, second),
  ]);
  fixture.api.links.clear();
  fixture.api.links.set(second, [metadata]);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "bootstrap", commitSha: fixture.source },
    merge,
  );
  await assert.rejects(
    collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read),
    hasCode("partial-membership"),
  );
});

void test("empty captured ranges require no GitHub calls", async (context) => {
  const fixture = await linear(context);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "bootstrap", commitSha: fixture.base },
    fixture.base,
  );
  const result = await collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read);
  assert.deepEqual(result.pullRequests, []);
  assert.equal(fixture.api.calls.length, 0);
});

void test("validates captured range membership before sending credentials", async (context) => {
  const fixture = await linear(context);
  const range = { ...fixture.request.range, commitShas: [] };
  await assert.rejects(
    collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read),
    hasCode("invalid-input"),
  );
  await assert.rejects(
    collectMergedPullRequests(
      { ...fixture.request, repository: "https://attacker.invalid/x" },
      fixture.api.read,
    ),
    hasCode("invalid-input"),
  );
  assert.equal(fixture.api.calls.length, 0);
});

void test("follows all numbered association pages without following remote URLs", async (context) => {
  const fixture = await linear(context);
  const open = Array.from({ length: 100 }, (_, index) =>
    pullFixture(index + 2, fixture.source, fixture.source, 1, { state: "open", merged_at: null }),
  );
  fixture.api.links.set(fixture.source, [...open, fixture.metadata]);
  assert.equal(
    (await collectMergedPullRequests(fixture.request, fixture.api.read)).pullRequests.length,
    1,
  );
  assert.ok(fixture.api.calls.some((call) => call.path.endsWith("/pulls?per_page=100&page=2")));
});

void test("association page limits reject silent truncation", async (context) => {
  const fixture = await linear(context);
  fixture.api.links.set(
    fixture.source,
    Array.from({ length: 1001 }, (_, index) =>
      pullFixture(index + 2, fixture.source, fixture.source, 1, { state: "open", merged_at: null }),
    ),
  );
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("collection-limit"),
  );
  assert.equal(fixture.api.calls.filter((call) => call.path.includes("/commits/")).length, 10);
});

void test("duplicate associations, malformed entries, and inconsistent pagination fail visibly", async (context) => {
  const fixture = await linear(context);
  for (const values of [
    [fixture.metadata, fixture.metadata],
    [{}],
    [{ ...fixture.metadata, state: { toString: null } }],
  ]) {
    fixture.api.links.set(fixture.source, values);
    await assert.rejects(
      collectMergedPullRequests(fixture.request, fixture.api.read),
      hasCode("invalid-response"),
    );
  }
  fixture.api.overrides.set(`/commits/${fixture.source}/pulls?per_page=100&page=1`, () =>
    Response.json([], { headers: { link: '<https://attacker.invalid/>; rel="next"' } }),
  );
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("invalid-response"),
  );
});

void test("retains complete original commit pages and rejects truncation/duplicates/wrong heads", async (context) => {
  const fixture = await linear(context);
  const remote = await original(fixture.directory, fixture.source);
  const originals = Array.from({ length: 100 }, (_, index) => ({
    ...remote,
    sha: index.toString(16).padStart(40, "0"),
  }));
  fixture.metadata.commits = 101;
  fixture.api.originals.set(1, [...originals, remote]);
  assert.equal(
    (await collectMergedPullRequests(fixture.request, fixture.api.read)).pullRequests[0]
      ?.originalCommits.length,
    101,
  );
  assert.ok(fixture.api.calls.some((call) => call.path === "/pulls/1/commits?per_page=100&page=2"));
  fixture.api.originals.set(1, [remote]);
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("invalid-response"),
  );
  fixture.metadata.commits = 2;
  fixture.api.originals.set(1, [remote, remote]);
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("invalid-response"),
  );
  fixture.metadata.commits = 1;
  fixture.api.originals.set(1, [await original(fixture.directory, fixture.base)]);
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("incomplete-evidence"),
  );
});

for (const status of [301, 401, 403, 404, 429, 500, 503]) {
  void test(`HTTP ${status} fails without exposing tokens or response bodies`, async (context) => {
    const fixture = await linear(context);
    fixture.api.overrides.set(
      `/commits/${fixture.source}/pulls?per_page=100&page=1`,
      () => new Response(token, { status }),
    );
    await assert.rejects(
      collectMergedPullRequests(fixture.request, fixture.api.read),
      (error: unknown) => {
        assert.ok(error instanceof PullRequestAssociationError);
        assert.equal(error.code, "github-read-failed");
        assert.match(error.message, new RegExp(`HTTP ${status}`, "u"));
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
  });
}

for (const [name, response] of [
  ["malformed JSON", () => new Response("{private data")],
  ["oversized response", () => new Response(" ".repeat(4 * 1024 * 1024 + 1))],
  [
    "interrupted stream",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private token"));
          },
        }),
      ),
  ],
] as const) {
  void test(`${name} cannot yield partial associations`, async (context) => {
    const fixture = await linear(context);
    fixture.api.overrides.set(`/commits/${fixture.source}/pulls?per_page=100&page=1`, response);
    await assert.rejects(
      collectMergedPullRequests(fixture.request, fixture.api.read),
      hasCode("github-read-failed"),
    );
  });
}

void test("transport and timeout errors remain actionable and sanitized", async (context) => {
  const fixture = await linear(context);
  const failure = new Error(`timeout ${token}`);
  const read: GitHubRead = () => Promise.reject(failure);
  await assert.rejects(collectMergedPullRequests(fixture.request, read), (error: unknown) => {
    assert.ok(error instanceof PullRequestAssociationError);
    assert.match(error.message, /timed out/u);
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

void test("changed PR metadata is detected instead of mixing input snapshots", async (context) => {
  const fixture = await linear(context);
  let reads = 0;
  fixture.api.overrides.set("/pulls/1", () =>
    Response.json({ ...fixture.metadata, body: ++reads === 1 ? "captured" : "edited" }),
  );
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("metadata-changed"),
  );
});

void test("oversized PR histories fail rather than accept the endpoint's 250-commit truncation", async (context) => {
  const fixture = await linear(context);
  fixture.metadata.commits = 251;
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("collection-limit"),
  );
});

void test("release-looking human PRs are ordinary changes, while unverified bot release branches fail closed", async (context) => {
  const fixture = await linear(context);
  fixture.metadata.title = "chore(release): prepare v1.0.0";
  assert.equal(
    (await collectMergedPullRequests(fixture.request, fixture.api.read)).pullRequests.length,
    1,
  );
  fixture.metadata.user = { id: 99, type: "Bot" };
  fixture.metadata.head = { sha: fixture.source, ref: "release-log/main", repo: { id: 1 } };
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("automation-unverified"),
  );
});

void test("supports SHA-256 and deleted fork repositories without losing original head evidence", async (context) => {
  const fixture = await linear(context, "sha256");
  fixture.metadata.head = { sha: fixture.source, ref: "feature", repo: null };
  const result = await collectMergedPullRequests(fixture.request, fixture.api.read);
  assert.equal(result.pullRequests[0]?.headSha.length, 64);
  assert.equal(result.pullRequests[0]?.headRepositoryId, null);
});

void test("shared HTTP reader rejects untrusted origins and embedded URL credentials before sending a token", async () => {
  const calls: string[] = [];
  const read: GitHubRead = (url) => {
    calls.push(url);
    return Promise.resolve(Response.json({}));
  };
  for (const url of [
    "https://attacker.invalid/repos/example/project",
    "http://api.github.com/repos/example/project",
    "https://untrusted@api.github.com/repos/example/project",
    "https://api.github.com/users/example",
  ]) {
    await assert.rejects(readGitHubJson(url, token, read), GitHubReadError);
  }
  assert.deepEqual(calls, []);
});

void test("identical captured input and remote fixtures yield stable ordering and content", async (context) => {
  const fixture = await linear(context);
  const first = await collectMergedPullRequests(fixture.request, fixture.api.read);
  const second = await collectMergedPullRequests(fixture.request, fixture.api.read);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
