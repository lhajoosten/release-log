import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { inspectCommit, inspectPendingRelease } from "../src/git.ts";
import { captureReleaseSnapshot, serializeReleaseSnapshot } from "../src/release-snapshot.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { requestGitHubJson, GitHubReadError } from "../src/github.ts";
import type { GitHubRead } from "../src/github.ts";
import { fixtureConfiguration } from "./release-fixture.ts";

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
}
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
const botId = 42;
const version = { kind: "released", currentVersion: "1.2.3" } as const;

async function fixture(
  context: TestContext,
  mode: "node" | "python" | "both" = "node",
  title = "feat(api): export rows",
) {
  const directory = await mkdtemp(join(tmpdir(), "release-proposal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE",
  ])
    delete environment[name];
  function git(args: string[], input?: string, separateIndex = false): string {
    const result = spawnSync("git", ["--no-pager", ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment,
        ...(separateIndex ? { GIT_INDEX_FILE: join(directory, ".git", "proposal-index") } : {}),
      },
      ...(input === undefined ? {} : { input }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Fixture Bot"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  if (mode !== "python")
    await writeFile(join(directory, "package.json"), '{ "version": "1.2.3", "private": true }\n');
  if (mode !== "node")
    await writeFile(
      join(directory, "pyproject.toml"),
      '# preserve\n[project]\nversion = "1.2.3" # preserve\n',
    );
  await writeFile(join(directory, "unrelated.txt"), "keep me\n");
  git(["add", "."]);
  git(["commit", "-m", "chore: initialize fixture"]);
  const baseline = git(["rev-parse", "HEAD"]).trim();
  git(["tag", "v1.2.3"]);
  const changes: { sha: string; title: string }[] = [];
  async function advance(selectedTitle = title) {
    const index = changes.length + 1;
    await writeFile(join(directory, `change-${index}.txt`), `source change ${index}\n`);
    git(["add", "."]);
    git(["commit", "-m", "chore: preserve authored evidence"]);
    changes.push({ sha: git(["rev-parse", "HEAD"]).trim(), title: selectedTitle });
  }
  await advance();
  async function snapshot() {
    const source = git(["rev-parse", "refs/heads/main"]).trim();
    const range = await inspectPendingRelease(directory, { kind: "tag", name: "v1.2.3" }, source);
    const pulls = await Promise.all(
      changes.map(async (change, index) => {
        const commit = await inspectCommit(directory, change.sha);
        return {
          number: index + 1,
          id: index + 1001,
          title: change.title,
          body: "```release-log\nversion: 1\naudience: internal\nsummary: Preserve selected rows.\nimpact: Retain the selection.\nrequired_action: null\n```",
          updatedAt: "2026-11-08T10:00:00Z",
          mergedAt: "2026-11-08T09:00:00Z",
          mergeCommitSha: change.sha,
          commitCount: 1,
          headSha: change.sha,
          headRef: "feature",
          headRepositoryId: 23,
          baseRepositoryId: 17,
          authorId: 7,
          authorType: "User",
          url: `https://github.com/example/project/pull/${index + 1}`,
          landingKind: "linear" as const,
          originalCommits: [commit],
          landedCommits: [commit],
        };
      }),
    );
    return serializeReleaseSnapshot(
      await captureReleaseSnapshot(
        { repository: "example/project", releaseBranch: "main", range, pullRequests: pulls },
        fixtureConfiguration,
      ),
    );
  }
  function ref(name: string): string | null {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/${name}`], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  function createTree(treeSha: string, entries: readonly Record<string, unknown>[]): string {
    git(["read-tree", treeSha], undefined, true);
    for (const entry of entries) {
      const sha = git(["hash-object", "-w", "--stdin"], text(entry.content)).trim();
      git(
        ["update-index", "--add", "--cacheinfo", text(entry.mode), sha, text(entry.path)],
        undefined,
        true,
      );
    }
    return git(["write-tree"], undefined, true).trim();
  }
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const pulls: Record<string, unknown>[] = [];
  let intercept:
    | ((method: string, path: string) => Response | null | Promise<Response | null>)
    | null = null;
  const transport: GitHubRead = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.github.com");
    const path = decodeURIComponent(target.pathname.slice("/repos/example/project".length));
    const method = options.method ?? "GET";
    const parsed: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
    const body = parsed === null ? null : object(parsed);
    calls.push({ method, path, body });
    const replaced = await intercept?.(method, path);
    if (replaced) return replaced;
    if (method === "GET" && !path) return json({ id: 17, full_name: "example/project" });
    if (method === "GET" && path.startsWith("/git/ref/")) {
      const name = path.slice("/git/ref/".length);
      const sha = ref(name);
      return sha
        ? json({ ref: `refs/${name}`, object: { sha } })
        : json({ message: "not found" }, 404);
    }
    if (method === "GET" && path.startsWith("/git/commits/")) {
      const sha = path.slice("/git/commits/".length);
      const commit = await inspectCommit(directory, sha);
      return json({
        sha,
        message: commit.message,
        parents: commit.parentShas.map((parentSha) => ({ sha: parentSha })),
        tree: { sha: git(["rev-parse", `${sha}^{tree}`]).trim() },
      });
    }
    if (method === "GET" && path.startsWith("/git/trees/")) {
      const sha = path.slice("/git/trees/".length);
      const tree = git(["ls-tree", "-r", "-t", "-z", sha])
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/u.exec(row);
          assert.ok(match);
          return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
        });
      return json({ sha, truncated: false, tree });
    }
    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const sha = path.slice("/git/blobs/".length);
      const bytes = Buffer.from(git(["cat-file", "blob", sha]));
      return json({
        sha,
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
      });
    }
    if (method === "GET" && path.startsWith("/compare/")) {
      const [base, targetSha] = path.slice("/compare/".length).split("...");
      assert.ok(base && targetSha);
      const mergeBase = git(["merge-base", base, targetSha]).trim();
      const ahead = Number(git(["rev-list", "--count", targetSha, "--not", base]).trim());
      const behind = Number(git(["rev-list", "--count", base, "--not", targetSha]).trim());
      return json({
        status: behind === 0 && ahead > 0 ? "ahead" : "behind",
        base_commit: { sha: base },
        merge_base_commit: { sha: mergeBase },
        ahead_by: ahead,
        behind_by: behind,
      });
    }
    const currentPull = (raw: Record<string, unknown>) => ({
      ...raw,
      head: { ...object(raw.head), sha: ref("heads/release-log/main") ?? object(raw.head).sha },
    });
    if (method === "GET" && path === "/pulls") return json(pulls.map(currentPull));
    if (method === "GET" && path.startsWith("/pulls/")) {
      const pull = pulls.find((entry) => entry.number === Number(path.split("/")[2]));
      return pull ? json(currentPull(pull)) : json({}, 404);
    }
    assert.ok(body);
    if (method === "POST" && path === "/git/trees") {
      assert.ok(Array.isArray(body.tree));
      return json({ sha: createTree(text(body.base_tree), body.tree.map(object)) }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      assert.ok(Array.isArray(body.parents));
      const parents: unknown[] = body.parents;
      const sha = git(
        ["commit-tree", text(body.tree), ...parents.flatMap((parent) => ["-p", text(parent)])],
        text(body.message),
      ).trim();
      return json({ sha }, 201);
    }
    if (path === "/git/refs" || path.startsWith("/git/refs/heads/")) {
      const name =
        method === "POST" ? text(body.ref).slice("refs/".length) : path.slice("/git/refs/".length);
      const previous = ref(name);
      const sha = text(body.sha);
      if (method === "POST" && previous) return json({}, 422);
      if (method === "PATCH") {
        assert.equal(body.force, false);
        if (
          !previous ||
          spawnSync("git", ["merge-base", "--is-ancestor", previous, sha], {
            cwd: directory,
            env: environment,
            timeout: 10_000,
          }).status !== 0
        )
          return json({}, 422);
      }
      git(["update-ref", `refs/${name}`, sha, previous ?? "0".repeat(40)]);
      return json({ ref: `refs/${name}`, object: { sha } }, method === "POST" ? 201 : 200);
    }
    if (method === "POST" && path === "/pulls") {
      assert.equal(body.draft, true);
      const pull = {
        number: pulls.length + 1,
        title: body.title,
        body: body.body,
        state: "open",
        merged_at: null,
        user: { id: botId, type: "Bot" },
        head: { ref: "release-log/main", sha: ref("heads/release-log/main"), repo: { id: 17 } },
        base: { ref: "main", repo: { id: 17 } },
      };
      pulls.push(pull);
      return json(pull, 201);
    }
    if (method === "PATCH" && path.startsWith("/pulls/")) {
      const pull = pulls.find((entry) => entry.number === Number(path.split("/")[2]));
      assert.ok(pull);
      Object.assign(pull, { title: body.title, body: body.body });
      return json(currentPull(pull));
    }
    throw new Error(`Unexpected API request ${method} ${path}`);
  };
  return {
    directory,
    git,
    ref,
    createTree,
    snapshot,
    advance,
    calls,
    pulls,
    changes,
    transport,
    baseline,
    intercept(value: typeof intercept) {
      intercept = value;
    },
    async request(write?: boolean) {
      return {
        snapshot: await snapshot(),
        configuration: fixtureConfiguration,
        version,
        automation: { schemaVersion: 1 as const, botUserId: botId },
        token: "synthetic-secret",
        ...(write === undefined ? {} : { write }),
      };
    },
  };
}

for (const mode of ["node", "python", "both"] as const) {
  void test(`${mode}: real Git branch creation, stable rolling PR refresh, and retries preserve the complete generated diff`, async (context) => {
    const f = await fixture(context, mode);
    const dry = await reconcileReleaseProposal(await f.request(), f.transport);
    assert.equal(dry.outcome, "would-create");
    assert.equal(f.ref("heads/release-log/main"), null);
    assert.ok(f.calls.every(({ method }) => method === "GET"));
    const created = await reconcileReleaseProposal(await f.request(true), f.transport);
    assert.equal(created.outcome, "created");
    assert.equal(created.pullNumber, 1);
    assert.equal(f.pulls.length, 1);
    const head = f.ref("heads/release-log/main");
    assert.ok(head);
    const changelog = f.git(["show", `${head}:CHANGELOG.md`]);
    assert.match(changelog, /^# Changelog/u);
    assert.match(changelog, /## v1\.3\.0/u);
    assert.ok(changelog.includes("[#1]"));
    if (mode !== "python")
      assert.match(f.git(["show", `${head}:package.json`]), /"version": "1.3.0"/u);
    if (mode !== "node")
      assert.equal(
        f.git(["show", `${head}:pyproject.toml`]),
        '# preserve\n[project]\nversion = "1.3.0" # preserve\n',
      );
    assert.equal(f.git(["show", `${head}:unrelated.txt`]), "keep me\n");
    const writes = f.calls.filter(({ method }) => method !== "GET").length;
    const retry = await reconcileReleaseProposal(await f.request(true), f.transport);
    assert.equal(retry.outcome, "unchanged");
    assert.equal(retry.proposalId, created.proposalId);
    assert.equal(f.calls.filter(({ method }) => method !== "GET").length, writes);
    await f.advance("fix(api): retain keys");
    const request = await f.request(true);
    const preview = await reconcileReleaseProposal({ ...request, write: false }, f.transport);
    assert.equal(preview.outcome, "would-refresh");
    const refreshed = await reconcileReleaseProposal(request, f.transport);
    assert.equal(refreshed.outcome, "refreshed");
    assert.equal(refreshed.pullNumber, 1);
    assert.equal(f.pulls.length, 1);
    assert.notEqual(refreshed.headSha, head);
    assert.ok(refreshed.headSha);
    const complete = f.git(["show", `${refreshed.headSha}:CHANGELOG.md`]);
    assert.equal((complete.match(/pending:v1/gu) ?? []).length, 1);
    assert.ok(complete.includes("[#1]") && complete.includes("[#2]"));
    assert.ok(
      !f.calls.some(({ path }) => path.includes("/releases") || path.includes("/git/refs/tags")),
    );
    assert.equal(f.git(["status", "--porcelain"]), "");
  });
}

void test("no-release batches create neither a branch nor a PR", async (context) => {
  const f = await fixture(context, "node", "docs(api): explain keys");
  assert.equal(
    (await reconcileReleaseProposal(await f.request(true), f.transport)).outcome,
    "no-release",
  );
  assert.ok(f.calls.every(({ method }) => method === "GET"));
  assert.equal(f.ref("heads/release-log/main"), null);
});

void test("stale source and moved baseline fail before writes", async (context) => {
  const f = await fixture(context);
  const request = await f.request(true);
  await f.advance();
  await assert.rejects(reconcileReleaseProposal(request, f.transport), /Main changed/u);
  const refreshed = await f.request(true);
  f.git(["tag", "-f", "v1.2.3", "HEAD"]);
  await assert.rejects(reconcileReleaseProposal(refreshed, f.transport), /baseline tag moved/u);
  assert.ok(f.calls.every(({ method }) => method === "GET"));
});

void test("a rewound main cannot replace a newer proposal with an older captured range", async (context) => {
  const f = await fixture(context);
  const old = await f.request(true);
  await reconcileReleaseProposal(old, f.transport);
  const firstSource = f.ref("heads/main");
  assert.ok(firstSource);
  await f.advance();
  await reconcileReleaseProposal(await f.request(true), f.transport);
  const latestSource = f.ref("heads/main");
  assert.ok(latestSource);
  const proposal = f.ref("heads/release-log/main");
  f.git(["update-ref", "refs/heads/main", firstSource, latestSource]);
  await assert.rejects(reconcileReleaseProposal(old, f.transport), /rewound or diverged/u);
  assert.equal(f.ref("heads/release-log/main"), proposal);
});

void test("closed PRs, deleted branches and wrong bot identity are conflicts, not permission to recreate", async (context) => {
  const f = await fixture(context);
  await reconcileReleaseProposal(await f.request(true), f.transport);
  const pull = f.pulls[0];
  assert.ok(pull);
  pull.state = "closed";
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /closed\/merged/u,
  );
  pull.state = "open";
  pull.user = { id: 99, type: "Bot" };
  await assert.rejects(reconcileReleaseProposal(await f.request(true), f.transport), /identity/u);
  pull.user = { id: botId, type: "Bot" };
  f.git(["update-ref", "-d", "refs/heads/release-log/main"]);
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /deleted, moved/u,
  );
});

void test("human PR metadata edits are preserved instead of being overwritten", async (context) => {
  const f = await fixture(context);
  await reconcileReleaseProposal(await f.request(true), f.transport);
  const pull = f.pulls[0];
  assert.ok(pull);
  pull.body = text(pull.body) + "Human review note.\n";
  const writes = f.calls.filter(({ method }) => method !== "GET").length;
  await f.advance();
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /metadata, ancestry/u,
  );
  assert.ok(text(pull.body).endsWith("Human review note.\n"));
  assert.equal(f.calls.filter(({ method }) => method !== "GET").length, writes);
});

for (const path of ["CHANGELOG.md", "unrelated.txt"] as const) {
  void test(`edited ${path} on the existing branch blocks refresh without overwriting files`, async (context) => {
    const f = await fixture(context);
    await reconcileReleaseProposal(await f.request(true), f.transport);
    const old = f.ref("heads/release-log/main");
    assert.ok(old);
    const original = await inspectCommit(f.directory, old);
    const tree = f.createTree(f.git(["rev-parse", `${old}^{tree}`]).trim(), [
      { path, mode: "100644", content: "Human changes\n" },
    ]);
    const forged = f
      .git(
        ["commit-tree", tree, ...original.parentShas.flatMap((sha) => ["-p", sha])],
        original.message,
      )
      .trim();
    f.git(["update-ref", "refs/heads/release-log/main", forged, old]);
    await f.advance();
    await assert.rejects(
      reconcileReleaseProposal(await f.request(true), f.transport),
      path === "unrelated.txt" ? /unrelated file/u : /content was edited/u,
    );
    assert.equal(f.ref("heads/release-log/main"), forged);
  });
}

void test("an existing reserved branch without a PR is never adopted automatically", async (context) => {
  const f = await fixture(context);
  f.git(["branch", "release-log/main"]);
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /without a verified PR/u,
  );
  assert.ok(f.calls.every(({ method }) => method === "GET"));
});

void test("a main change during commit preparation prevents the branch update", async (context) => {
  const f = await fixture(context);
  const request = await f.request(true);
  let moved = false;
  f.intercept(async (method, path) => {
    if (!moved && method === "POST" && path === "/git/commits") {
      moved = true;
      await f.advance();
    }
    return null;
  });
  await assert.rejects(reconcileReleaseProposal(request, f.transport), /Main changed/u);
  assert.equal(f.ref("heads/release-log/main"), null);
  assert.equal(f.pulls.length, 0);
});

void test("concurrent branch changes reject non-fast-forward updates without force", async (context) => {
  const f = await fixture(context);
  await reconcileReleaseProposal(await f.request(true), f.transport);
  await f.advance();
  const previous = f.ref("heads/release-log/main");
  assert.ok(previous);
  let raced: string | null = null;
  f.intercept((method, path) => {
    if (method === "PATCH" && path.startsWith("/git/refs/heads/")) {
      const tree = f.git(["rev-parse", `${previous}^{tree}`]).trim();
      raced = f.git(["commit-tree", tree, "-p", previous], "chore: concurrent update\n").trim();
      f.git(["update-ref", "refs/heads/release-log/main", raced, previous]);
    }
    return null;
  });
  await assert.rejects(reconcileReleaseProposal(await f.request(true), f.transport), /HTTP 422/u);
  assert.ok(raced);
  assert.equal(f.ref("heads/release-log/main"), raced);
});

void test("partial PR creation failures do not create duplicates or adopt an orphan on retry", async (context) => {
  const f = await fixture(context);
  f.intercept((method, path) =>
    method === "POST" && path === "/pulls" ? json({ private: "synthetic-secret" }, 503) : null,
  );
  await assert.rejects(reconcileReleaseProposal(await f.request(true), f.transport), /HTTP 503/u);
  assert.ok(f.ref("heads/release-log/main"));
  assert.equal(f.pulls.length, 0);
  f.intercept(null);
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /without a verified PR/u,
  );
});

void test("an open proposal cannot disappear silently after a metadata refresh becomes no-release", async (context) => {
  const f = await fixture(context);
  await reconcileReleaseProposal(await f.request(true), f.transport);
  const change = f.changes[0];
  assert.ok(change);
  change.title = "docs(api): explain keys";
  const head = f.ref("heads/release-log/main");
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /new plan has no release/u,
  );
  assert.equal(f.ref("heads/release-log/main"), head);
  assert.equal(f.pulls[0]?.state, "open");
});

void test("partial refresh failures preserve the PR and require explicit recovery rather than overwriting it", async (context) => {
  const f = await fixture(context);
  await reconcileReleaseProposal(await f.request(true), f.transport);
  const body = f.pulls[0]?.body;
  await f.advance();
  f.intercept((method, path) =>
    method === "PATCH" && path.startsWith("/pulls/") ? json({}, 503) : null,
  );
  await assert.rejects(reconcileReleaseProposal(await f.request(true), f.transport), /HTTP 503/u);
  assert.equal(f.pulls.length, 1);
  assert.equal(f.pulls[0]?.body, body);
  f.intercept(null);
  const writes = f.calls.filter(({ method }) => method !== "GET").length;
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /partially saved/u,
  );
  assert.equal(f.calls.filter(({ method }) => method !== "GET").length, writes);
});

void test("complete PR-history pagination is required and remote pagination URLs are never followed", async (context) => {
  const f = await fixture(context);
  f.intercept((method, path) =>
    method === "GET" && path === "/pulls"
      ? json([], 200, { link: '<https://attacker.invalid/collect>; rel="next"' })
      : null,
  );
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /exceeds ten pages/u,
  );
  assert.equal(f.calls.filter(({ path }) => path === "/pulls").length, 10);
  assert.ok(f.calls.every(({ method }) => method === "GET"));
});

for (const fault of [
  "truncated-tree",
  "oversized-blob",
  "malformed-blob",
  "hash-mismatch",
] as const) {
  void test(`${fault} blocks a usable proposal before writes`, async (context) => {
    const f = await fixture(context);
    f.intercept((method, path) => {
      if (method !== "GET") return null;
      if (fault === "truncated-tree" && path.startsWith("/git/trees/"))
        return json({ sha: path.slice("/git/trees/".length), truncated: true, tree: [] });
      if (fault === "hash-mismatch" && path.startsWith("/git/blobs/")) {
        const content = Buffer.from('{"version":"9.9.9"}');
        return json({
          sha: path.slice("/git/blobs/".length),
          encoding: "base64",
          size: content.length,
          content: content.toString("base64"),
        });
      }
      if (fault !== "truncated-tree" && path.startsWith("/git/blobs/"))
        return json({
          sha: path.slice("/git/blobs/".length),
          encoding: "base64",
          size: fault === "oversized-blob" ? 2 * 1024 * 1024 + 1 : 1,
          content: "%%%",
        });
      return null;
    });
    await assert.rejects(
      reconcileReleaseProposal(await f.request(true), f.transport),
      fault === "truncated-tree"
        ? /complete bounded Git tree/u
        : fault === "oversized-blob"
          ? /2 MiB/u
          : fault === "hash-mismatch"
            ? /immutable object ID/u
            : /complete UTF-8/u,
    );
    assert.ok(f.calls.every(({ method }) => method === "GET"));
  });
}

void test("a symlinked source manifest is rejected without following its target or writing", async (context) => {
  const f = await fixture(context);
  f.intercept((method, path) => {
    if (method === "GET" && path.startsWith("/git/trees/"))
      return json({
        sha: path.slice("/git/trees/".length),
        truncated: false,
        tree: [{ path: "package.json", type: "blob", mode: "120000", sha: "a".repeat(40) }],
      });
    return null;
  });
  await assert.rejects(reconcileReleaseProposal(await f.request(true), f.transport), /symlinks/u);
  assert.ok(
    f.calls.every(({ method, path }) => method === "GET" && !path.startsWith("/git/blobs/")),
  );
});

void test("shared write transport bounds requests, rejects redirects/failures and never returns raw secrets", async () => {
  await assert.rejects(
    requestGitHubJson(
      "https://api.github.com/repos/example/project/pulls",
      "synthetic-secret",
      { method: "POST", body: {} },
      () => Promise.resolve(json({ token: "synthetic-secret" }, 403)),
    ),
    (error: unknown) =>
      error instanceof GitHubReadError &&
      error.status === 403 &&
      !error.message.includes("synthetic-secret"),
  );
  await assert.rejects(
    requestGitHubJson(
      "https://attacker.invalid/repos/example/project/pulls",
      "synthetic-secret",
      { method: "POST", body: {} },
      () => Promise.reject(new Error("should not run")),
    ),
    /GitHub.com/u,
  );
  await assert.rejects(
    requestGitHubJson("https://api.github.com/repos/example/project/pulls", "synthetic-secret", {
      method: "POST",
      body: "x".repeat(16 * 1024 * 1024),
    }),
    /16 MiB/u,
  );
  await assert.rejects(
    requestGitHubJson(
      "https://api.github.com/repos/example/project/pulls",
      "synthetic-secret",
      { method: "POST", body: {} },
      (_url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.method, "POST");
        return Promise.resolve(
          new Response("", { status: 302, headers: { location: "https://attacker.invalid" } }),
        );
      },
    ),
    /HTTP 302/u,
  );
  await assert.rejects(
    requestGitHubJson(
      "https://api.github.com/repos/example/project/pulls",
      "synthetic-secret",
      { method: "POST", body: {} },
      () => Promise.resolve(new Response("{private response", { status: 201 })),
    ),
    (error: unknown) =>
      error instanceof GitHubReadError &&
      error.message.includes("reconcile remote") &&
      !error.message.includes("private response"),
  );
});
