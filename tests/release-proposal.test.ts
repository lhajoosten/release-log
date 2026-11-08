import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCommit } from "../src/git.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { requestGitHubJson, GitHubReadError } from "../src/github.ts";
import { fixture, json, text, botId } from "./proposal-fixture.ts";

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
