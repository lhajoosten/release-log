import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { createReleasePlan } from "../src/release-plan.ts";
import { renderChangelog } from "../src/changelog.ts";
import { prepareReleaseFiles } from "../src/proposal-files.ts";
import {
  captureReleaseSnapshot,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";

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

void test("squash histories retain original PR commits without requiring them in the landed range", async (context) => {
  const fixture = await linear(context);
  const first = fixture.source;
  const second = await createCommit(fixture.directory, "fix: revise original PR");
  await git(fixture.directory, ["switch", "-c", "squash", fixture.base]);
  const landing = await createCommit(fixture.directory, "feat: squashed change");
  const metadata = pullFixture(1, landing, second, 2);
  fixture.api.pulls.set(1, metadata);
  fixture.api.originals.set(1, [
    await original(fixture.directory, first),
    await original(fixture.directory, second),
  ]);
  fixture.api.links.clear();
  fixture.api.links.set(landing, [metadata]);
  const range = await inspectPendingRelease(
    fixture.directory,
    { kind: "bootstrap", commitSha: fixture.base },
    landing,
  );
  const result = await collectMergedPullRequests({ ...fixture.request, range }, fixture.api.read);
  assert.deepEqual(
    result.pullRequests[0]?.landedCommits.map((commit) => commit.sha),
    [landing],
  );
  assert.deepEqual(
    result.pullRequests[0]?.originalCommits.map((commit) => commit.sha),
    [first, second],
  );
});

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

for (const format of ["sha1", "sha256"]) {
  void test(`${format}: bootstrap preserves direct commits alongside PRs through planning, rendering and Node/Python preparation`, async (context) => {
    const directory = await repository(context, format);
    const nodeManifest = '{"version":"0.0.0"}\n';
    const pythonManifest = '[project]\nversion="0.0.0" # retain\n';

    await writeFile(join(directory, "package.json"), nodeManifest);
    await writeFile(join(directory, "pyproject.toml"), pythonManifest);
    await git(directory, ["add", "."]);

    const base = await createCommit(directory, "Initial repository state");
    const maintenance = await createCommit(directory, "chore: add the license");
    const feature = await createCommit(directory, "feat: add exports");
    const source = await createCommit(directory, "fix: retain selected rows");

    const range = await inspectPendingRelease(
      directory,
      { kind: "bootstrap", commitSha: base },
      source,
    );

    const api = http();
    const pull = pullFixture(1, source, source, 1, {
      title: "fix(api): retain selected rows",
      body: "```release-log\nversion: 1\naudience: users\nsummary: Retain selected rows.\nimpact: Keep the selection.\nrequired_action: null\n```",
    });
    api.links.set(source, [pull]);
    api.pulls.set(1, pull);
    api.originals.set(1, [await original(directory, source)]);

    const associated = await collectMergedPullRequests(
      {
        repository: "example/project",
        releaseBranch: "main",
        localRepository: directory,
        range,
        token,
      },
      api.read,
    );

    assert.deepEqual(
      associated.bootstrapCommits?.map((entry) => entry.sha),
      [maintenance, feature].toSorted(),
    );
    assert.deepEqual(
      associated.pullRequests.map((entry) => entry.number),
      [1],
    );

    const config = {
      schemaVersion: 1 as const,
      repository: "example/project",
      repositoryId: 1,
      releaseBranch: "main",
      releasePolicy: "release-policy-v1" as const,
    };
    const reads = api.calls.length;
    const snapshot = await captureReleaseSnapshot(associated, config);
    const serialized = await serializeReleaseSnapshot(snapshot);

    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(await replayReleaseSnapshot(serialized, config), snapshot);

    const version = { kind: "bootstrap", initialVersion: "0.1.0" } as const;
    const plan = await createReleasePlan(serialized, config, version);

    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.nextVersion, "0.1.0");
    assert.equal(plan.bump, "initial");
    assert.equal(plan.contributions.length, 1);
    assert.deepEqual(
      plan.bootstrapContributions.find((entry) => entry.sha === feature),
      {
        sha: feature,
        url: `https://github.com/example/project/commit/${feature}`,
        type: "feat",
        scope: null,
        breaking: false,
        bump: "minor",
      },
    );

    const changelog = await renderChangelog(serialized, config, version);

    assert.ok(changelog);
    assert.ok(
      changelog.includes(
        `- [bootstrap commit]: add exports ([${feature.slice(0, 12)}](https://github.com/example/project/commit/${feature}))`,
      ),
    );
    assert.ok(changelog.includes("([#1](https://github.com/example/project/pull/1))"));
    assert.ok(changelog.includes("without structured PR impact or migration actions"));
    assert.equal(changelog, await renderChangelog(serialized, config, version));

    const prepared = await prepareReleaseFiles(directory, serialized, config, version);

    assert.deepEqual(
      prepared.files.map((entry) => entry.path),
      ["package.json", "pyproject.toml", "CHANGELOG.md", ".release-log/inputs.json"],
    );
    assert.equal(
      prepared.files.find((entry) => entry.path === "package.json")?.after,
      '{"version":"0.1.0"}\n',
    );
    assert.equal(
      prepared.files.find((entry) => entry.path === "pyproject.toml")?.after,
      '[project]\nversion="0.1.0" # retain\n',
    );

    assert.equal(await readFile(join(directory, "package.json"), "utf8"), nodeManifest);
    assert.equal(api.calls.length, reads);
    assert.ok(!serialized.includes(token));
  });
}

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

void test("a bootstrap commit acquiring a qualifying PR during collection requires a fresh capture", async (context) => {
  const fixture = await linear(context);
  fixture.api.links.clear();
  let reads = 0;
  fixture.api.overrides.set(`/commits/${fixture.source}/pulls?per_page=100&page=1`, () =>
    Response.json(++reads === 1 ? [] : [fixture.metadata]),
  );
  await assert.rejects(
    collectMergedPullRequests(fixture.request, fixture.api.read),
    hasCode("metadata-changed"),
  );
});

void test("bootstrap commit support does not bypass known PR metadata checks", async (context) => {
  const fixture = await linear(context);
  const associated = await collectMergedPullRequests(fixture.request, fixture.api.read);
  await assert.rejects(
    captureReleaseSnapshot(associated, {
      schemaVersion: 1,
      repository: "example/project",
      repositoryId: 1,
      releaseBranch: "main",
      releasePolicy: "release-policy-v1",
    }),
    /metadata must be repaired/u,
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

void test("real Git and mocked HTTP collection feed a validated offline snapshot without more reads", async (context) => {
  const fixture = await linear(context);
  fixture.metadata.body = [
    "```release-log",
    "version: 1",
    "audience: internal",
    "summary: Collect release evidence.",
    "impact: Preserve exact PR membership.",
    "required_action: null",
    "```",
  ].join("\n");
  const associated = await collectMergedPullRequests(fixture.request, fixture.api.read);
  const config = {
    schemaVersion: 1 as const,
    repository: "example/project",
    repositoryId: 1,
    releaseBranch: "main",
    releasePolicy: "release-policy-v1" as const,
  };
  const reads = fixture.api.calls.length;
  const snapshot = await captureReleaseSnapshot(associated, config);
  const encoded = await serializeReleaseSnapshot(snapshot);
  const replayed = await replayReleaseSnapshot(encoded, config);
  assert.equal(fixture.api.calls.length, reads);
  assert.deepEqual(
    replayed.normalized.pullRequests.map((entry) => entry.number),
    [1],
  );
  assert.equal(replayed.normalized.sourceCommitSha, fixture.source);
  assert.equal(replayed.normalized.pullRequests[0]?.context.audience, "internal");
  assert.equal(await serializeReleaseSnapshot(replayed), encoded);
});

void test("identical captured input and remote fixtures yield stable ordering and content", async (context) => {
  const fixture = await linear(context);
  const first = await collectMergedPullRequests(fixture.request, fixture.api.read);
  const second = await collectMergedPullRequests(fixture.request, fixture.api.read);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
