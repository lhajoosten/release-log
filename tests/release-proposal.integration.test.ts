import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectCommit } from "../src/git.ts";
import {
  captureReleaseSnapshot,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { prepareReleaseFiles } from "../src/proposal-files.ts";
import { capturedIdentity, describe } from "../src/proposal-identity.ts";
import { requestGitHubJson, GitHubReadError } from "../src/github.ts";
import { fixture, json, object, text, botId } from "./proposal-fixture.ts";

for (const mode of ["node", "python", "python-uv", "both", "cargo", "cargo-workspace"] as const) {
  void test(`${mode}: real Git branch creation, stable rolling PR refresh, and retries preserve the complete generated diff`, async (context) => {
    const f = await fixture(context, mode);
    const dry = await reconcileReleaseProposal(await f.request(), f.transport);
    assert.equal(dry.outcome, "would-create");
    assert.equal(f.ref("heads/release-log/main"), null);
    assert.ok(f.calls.every(({ method }) => method === "GET"));
    if (mode === "python-uv") {
      assert.ok(dry.changedPaths.includes("pyproject.toml"));
      assert.ok(dry.changedPaths.includes("uv.lock"));
    }
    const created = await reconcileReleaseProposal(await f.request(true), f.transport);
    assert.equal(created.outcome, "created");
    assert.match(created.proposalId, /^[a-f0-9]{64}$/u);
    assert.match(created.headSha, /^[a-f0-9]{40,64}$/u);
    assert.equal(created.pullNumber, 1);
    assert.equal(f.pulls.length, 1);
    const head = f.ref("heads/release-log/main");
    assert.ok(head);
    const changelog = f.git(["show", `${head}:CHANGELOG.md`]);
    assert.match(changelog, /^# Changelog/u);
    assert.match(changelog, /## v1\.3\.0/u);
    assert.ok(changelog.includes("[#1]"));
    const firstBody = text(f.pulls[0]?.body);
    assert.match(firstBody, /^### Features$/mu);
    assert.ok(firstBody.includes("[#1]"));
    assert.ok(!firstBody.includes("[#2]"));
    if (mode === "node" || mode === "both")
      assert.match(f.git(["show", `${head}:package.json`]), /"version": "1.3.0"/u);
    if (mode === "python" || mode === "both")
      assert.equal(
        f.git(["show", `${head}:pyproject.toml`]),
        '# preserve\n[project]\nversion = "1.3.0" # preserve\n',
      );
    if (mode === "python-uv") {
      for (const path of ["pyproject.toml", "uv.lock"])
        assert.equal(
          f.git(["show", `${head}:${path}`]),
          f.git(["show", `${dry.sourceSha}:${path}`]).replace("1.2.3", "1.3.0"),
        );
    }
    if (mode === "cargo") {
      assert.equal(
        f.git(["show", `${head}:Cargo.toml`]),
        "[package]\nname = \"standalone\"\nversion = '1.3.0' # preserve\n",
      );
      assert.equal(f.git(["ls-tree", head, "Cargo.lock"]), "");
    }
    if (mode === "cargo-workspace") {
      const root = f.git(["show", `${head}:Cargo.toml`]);
      assert.match(root, /version = "1\.3\.0"\n/u);
      assert.match(root, /upkeep-core = \{ version = "=1\.3\.0", path = "crates\/upkeep-core" \}/u);
      const lock = f.git(["show", `${head}:Cargo.lock`]);
      assert.deepEqual(lock.match(/version = "1\.3\.0"/gu), [
        'version = "1.3.0"',
        'version = "1.3.0"',
      ]);
      const member = f.git(["show", `${head}:crates/upkeep-cli/Cargo.toml`]);
      assert.match(member, /version\.workspace = true/u);
      assert.match(member, /version = "~1\.3\.0"/u);
      assert.deepEqual(f.git(["diff", "--name-only", dry.sourceSha, head]).trim().split("\n"), [
        ".release-log/inputs.json",
        "CHANGELOG.md",
        "Cargo.lock",
        "Cargo.toml",
        "crates/upkeep-cli/Cargo.toml",
      ]);
    }
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
    if (mode === "python-uv") {
      assert.ok(preview.changedPaths.includes("uv.lock"));
      assert.equal(
        f.git(["show", `${refreshed.headSha}:uv.lock`]),
        f.git(["show", `${head}:uv.lock`]),
      );
    }
    assert.equal(f.pulls.length, 1);
    assert.notEqual(refreshed.headSha, head);
    assert.ok(refreshed.headSha);
    const complete = f.git(["show", `${refreshed.headSha}:CHANGELOG.md`]);
    assert.equal((complete.match(/pending:v1/gu) ?? []).length, 1);
    assert.ok(complete.includes("[#1]") && complete.includes("[#2]"));
    const refreshedBody = text(f.pulls[0]?.body);
    assert.match(refreshedBody, /^### Features$/mu);
    assert.match(refreshedBody, /^### Fixes$/mu);
    const pending =
      /<!-- release-log:pending:v1 [^>]+ -->\n\n([\s\S]+?)\n<!-- release-log:pending:end -->/u.exec(
        complete,
      )?.[1];
    assert.ok(pending);
    assert.ok(refreshedBody.endsWith(pending));
    assert.ok(
      !f.calls.some(({ path }) => path.includes("/releases") || path.includes("/git/refs/tags")),
    );
    assert.equal(f.git(["status", "--porcelain"]), "");
  });
}

void test("a legacy proposal stays verifiable and gains a changelog on the next refresh", async (context) => {
  const f = await fixture(context);
  const request = await f.request(true);
  const initial = await reconcileReleaseProposal(request, f.transport);
  const pull = f.pulls[0];
  assert.ok(initial.headSha && pull);
  const snapshot = await replayReleaseSnapshot(request.snapshot, request.configuration);
  const prepared = await prepareReleaseFiles(
    f.directory,
    request.snapshot,
    request.configuration,
    request.version,
  );
  const legacy = describe(snapshot, prepared, botId, null, undefined, "legacy");
  const tree = f.git(["rev-parse", `${initial.headSha}^{tree}`]).trim();
  const legacyHead = f.git(["commit-tree", tree, "-p", initial.sourceSha], legacy.message).trim();
  f.git(["update-ref", "refs/heads/release-log/main", legacyHead]);
  pull.body = legacy.body;

  assert.equal(capturedIdentity(legacy.message).bodyFormat, "legacy");
  assert.ok(!legacy.body.includes("[#1]"));
  const unchanged = await reconcileReleaseProposal(request, f.transport);
  assert.equal(unchanged.outcome, "unchanged");
  assert.equal(unchanged.proposalId, legacy.id);

  await f.advance("fix(api): retain keys");
  const refreshed = await reconcileReleaseProposal(await f.request(true), f.transport);
  assert.equal(refreshed.outcome, "refreshed");
  assert.equal(refreshed.pullNumber, initial.pullNumber);
  const refreshedBody = text(pull.body);
  assert.ok(refreshedBody.includes("[#1]") && refreshedBody.includes("[#2]"));
  pull.body = refreshedBody.replace("### Fixes", "### Changed");
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /Proposal metadata, ancestry or generated identity was edited/u,
  );
});

void test("a changelog that exceeds the proposal body budget stays available in Files changed", async (context) => {
  const f = await fixture(context);
  const { snapshot: serialized, configuration, version } = await f.request();
  const snapshot = await replayReleaseSnapshot(serialized, configuration);
  const prepared = await prepareReleaseFiles(f.directory, serialized, configuration, version);
  const pendingChangelog = `${prepared.pendingChangelog ?? ""}${"é".repeat(32 * 1024)}\n`;
  const description = describe(snapshot, { ...prepared, pendingChangelog }, botId, null);

  assert.match(description.body, /## Included changes/u);
  assert.match(description.body, /See `CHANGELOG.md` in \*\*Files changed\*\*/u);
  assert.ok(!description.body.includes("é"));
  assert.equal(capturedIdentity(description.message).bodyFormat, "changelog-v1");
});

void test("an independently versioned Cargo member stops reconciliation before proposal writes", async (context) => {
  const f = await fixture(context, "cargo-workspace");
  const path = join(f.directory, "crates/upkeep-core/Cargo.toml");
  const manifest = await readFile(path, "utf8");
  await writeFile(path, manifest.replace("version.workspace = true", 'version = "1.2.3"'));
  await f.advance();
  await assert.rejects(
    reconcileReleaseProposal(await f.request(true), f.transport),
    /must inherit the shared workspace version/u,
  );
  assert.equal(f.ref("heads/release-log/main"), null);
  assert.ok(f.calls.every(({ method }) => method === "GET"));
});

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

for (const edit of ["stale source", "missing bump", "tampered lock"] as const) {
  void test(`uv proposal rejects a ${edit} without changing GitHub refs or local files`, async (context) => {
    const f = await fixture(context, "python-uv");
    const lock = await readFile(join(f.directory, "uv.lock"), "utf8");
    if (edit === "stale source") {
      await writeFile(join(f.directory, "uv.lock"), lock.replace("1.2.3", "1.2.2"));
    } else {
      const proposal = await reconcileReleaseProposal(await f.request(true), f.transport);
      assert.ok(proposal.headSha);
      const original = await inspectCommit(f.directory, proposal.headSha);
      const tree = f.createTree(f.git(["rev-parse", `${proposal.headSha}^{tree}`]).trim(), [
        {
          path: "uv.lock",
          mode: "100644",
          content: edit === "missing bump" ? lock : lock + "# tampered\n",
        },
      ]);
      const forged = f
        .git(["commit-tree", tree, "-p", proposal.sourceSha], original.message)
        .trim();
      f.git(["update-ref", "refs/heads/release-log/main", forged, proposal.headSha]);
      const pull = f.pulls[0];
      assert.ok(pull);
      pull.head = { ...object(pull.head), sha: forged };
    }

    await f.advance();
    const head = f.ref("heads/release-log/main");
    const main = f.ref("heads/main");
    const before = f.calls.length;
    const current = await readFile(join(f.directory, "uv.lock"), "utf8");
    await assert.rejects(
      reconcileReleaseProposal(await f.request(true), f.transport),
      edit === "stale source" ? /root version disagrees/u : /content was edited/u,
    );
    assert.ok(f.calls.slice(before).every(({ method }) => method === "GET"));
    assert.equal(f.ref("heads/release-log/main"), head);
    assert.equal(f.ref("heads/main"), main);
    assert.equal(await readFile(join(f.directory, "uv.lock"), "utf8"), current);
    assert.equal(f.git(["status", "--porcelain"]), "");
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

void test("optional-context proposals reconstruct deterministically and reject policy changes and body additions", async (context) => {
  const f = await fixture(context);
  const original = await f.request(true);
  const captured = await replayReleaseSnapshot(original.snapshot, original.configuration);
  const configuration = { ...original.configuration, contextPolicy: "optional" } as const;
  const snapshot = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(
      {
        ...captured.input,
        pullRequests: captured.input.pullRequests.map((pull) => ({
          ...pull,
          body: "Dynamic ordinary PR description.",
        })),
      },
      configuration,
    ),
  );
  const request = { ...original, configuration, snapshot };
  const created = await reconcileReleaseProposal(request, f.transport);
  assert.equal(created.outcome, "created");
  const retry = await reconcileReleaseProposal(request, f.transport);
  assert.equal(retry.outcome, "unchanged");
  assert.equal(retry.proposalId, created.proposalId);
  const writes = f.calls.filter(({ method }) => method !== "GET").length;
  await assert.rejects(
    reconcileReleaseProposal(
      { ...request, configuration: { ...configuration, contextPolicy: "required" } },
      f.transport,
    ),
    { code: "configuration-mismatch" },
  );
  const pull = f.pulls[0];
  assert.ok(pull);
  pull.body += "\nWorkflow-added text.\n";
  await assert.rejects(reconcileReleaseProposal(request, f.transport), /Proposal metadata/u);
  assert.equal(f.calls.filter(({ method }) => method !== "GET").length, writes);
});

void test("GitHub commit messages without the final newline support creation, retry and refresh", async (context) => {
  const f = await fixture(context);
  const transport: typeof f.transport = async (url, options) => {
    const response = await f.transport(url, options);
    if (options.method === "GET" && url.includes("/git/commits/")) {
      const data = object(await response.json());
      return json({ ...data, message: text(data.message).replace(/\n$/u, "") });
    }
    return response;
  };
  const request = await f.request(true);
  const created = await reconcileReleaseProposal(request, transport);
  assert.equal(created.outcome, "created");
  assert.equal((await reconcileReleaseProposal(request, transport)).outcome, "unchanged");
  await f.advance("fix(api): retain keys");
  assert.equal(
    (await reconcileReleaseProposal(await f.request(true), transport)).outcome,
    "refreshed",
  );
});

for (const corruption of ["message", "extra-newline", "parents"] as const) {
  void test(`API newline normalization still rejects altered proposal ${corruption} before ref writes`, async (context) => {
    const f = await fixture(context);
    const transport: typeof f.transport = async (url, options) => {
      const response = await f.transport(url, options);
      if (options.method !== "GET" || !url.includes("/git/commits/")) return response;
      const data = object(await response.json());
      const message = text(data.message);
      if (!message.includes("Release-Log-Proposal:")) return json(data);
      if (corruption === "parents") return json({ ...data, parents: [] });
      return json({
        ...data,
        message:
          corruption === "extra-newline"
            ? `${message}\n\n`
            : message.replace("chore: prepare", "chore: publish"),
      });
    };
    await assert.rejects(
      reconcileReleaseProposal(await f.request(true), transport),
      /unexpected proposal commit evidence/u,
    );
    assert.equal(f.ref("heads/release-log/main"), null);
    assert.equal(f.pulls.length, 0);
    assert.ok(!f.calls.some((call) => call.method !== "GET" && call.path.startsWith("/git/refs")));
  });
}

void test("API messages retaining their terminal newline are accepted unchanged", async (context) => {
  const f = await fixture(context);
  const transport: typeof f.transport = async (url, options) => {
    const response = await f.transport(url, options);
    if (options.method !== "GET" || !url.includes("/git/commits/")) return response;
    const data = object(await response.json());
    return json({ ...data, message: `${text(data.message)}\n` });
  };
  const request = await f.request(true);
  assert.equal((await reconcileReleaseProposal(request, transport)).outcome, "created");
  assert.equal((await reconcileReleaseProposal(request, transport)).outcome, "unchanged");
});

void test("refresh reasserts the configured base so GitHub drops already-merged source files from the PR diff", async (context) => {
  const f = await fixture(context);
  await reconcileReleaseProposal(await f.request(true), f.transport);
  await f.advance("fix(api): retain keys");
  await reconcileReleaseProposal(await f.request(true), f.transport);
  const update = f.calls.findLast(
    (call) => call.method === "PATCH" && call.path.startsWith("/pulls/"),
  );
  assert.equal(update?.body?.base, "main");
  assert.equal(object(f.pulls[0]?.base).sha, f.ref("heads/main"));
  const head = f.ref("heads/release-log/main");
  assert.ok(head);
  assert.deepEqual(
    f
      .git(["diff", "--name-only", `refs/heads/main...${head}`])
      .trim()
      .split("\n"),
    [".release-log/inputs.json", "CHANGELOG.md", "package.json"],
  );
});

void test("compact format refresh verifies the old proposal in its original format and preserves replay identity", async (context) => {
  const f = await fixture(context, "node", "feat(api): export rows", {
    changelogVerbosity: "concise",
  });
  const original = await f.request(true);
  await reconcileReleaseProposal(original, f.transport);
  await f.advance("fix(api): retain keys");
  const current = await f.request(true);
  const captured = await replayReleaseSnapshot(current.snapshot, current.configuration);
  const configuration = {
    ...current.configuration,
    changelog: { verbosity: "concise", format: "compact" },
  } as const;
  const snapshot = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(captured.input, configuration),
  );
  await assert.rejects(replayReleaseSnapshot(original.snapshot, configuration), {
    code: "configuration-mismatch",
  });
  const request = { ...current, configuration, snapshot };
  const refreshed = await reconcileReleaseProposal(request, f.transport);
  assert.equal(refreshed.outcome, "refreshed");
  assert.ok(refreshed.headSha);
  const changelog = f.git(["show", `${refreshed.headSha}:CHANGELOG.md`]);
  assert.ok(changelog.includes("<summary>Internal maintenance</summary>"));
  assert.ok(!changelog.includes("[internal]"));
  assert.equal((await reconcileReleaseProposal(request, f.transport)).outcome, "unchanged");
  assert.equal(f.pulls.length, 1);
});

void test("presentation transition cannot change context policy or verbosity", async (context) => {
  const f = await fixture(context, "node", "feat(api): export rows", {
    changelogVerbosity: "concise",
  });
  const original = await f.request(true);
  await reconcileReleaseProposal(original, f.transport);
  const captured = await replayReleaseSnapshot(original.snapshot, original.configuration);
  for (const configuration of [
    {
      ...original.configuration,
      contextPolicy: "optional" as const,
      changelog: { verbosity: "concise" as const, format: "compact" as const },
    },
    {
      ...original.configuration,
      changelog: { verbosity: "detailed" as const, format: "compact" as const },
    },
  ]) {
    const snapshot = await serializeReleaseSnapshot(
      await captureReleaseSnapshot(captured.input, configuration),
    );
    await assert.rejects(
      reconcileReleaseProposal({ ...original, configuration, snapshot }, f.transport),
      { code: "configuration-mismatch" },
    );
  }
});

void test("compact format selection preserves omitted verbosity's detailed interpretation", async (context) => {
  const f = await fixture(context);
  const original = await f.request(true);
  await reconcileReleaseProposal(original, f.transport);
  const captured = await replayReleaseSnapshot(original.snapshot, original.configuration);
  const configuration = {
    ...original.configuration,
    changelog: { verbosity: "detailed", format: "compact" },
  } as const;
  const snapshot = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(captured.input, configuration),
  );
  assert.equal(
    (await reconcileReleaseProposal({ ...original, configuration, snapshot }, f.transport)).outcome,
    "refreshed",
  );
});

void test("compact format selection cannot advance the trusted onboarding boundary", async (context) => {
  const f = await fixture(context, "node", "feat(api): export rows", {
    bootstrap: true,
    adoption: true,
    changelogVerbosity: "concise",
  });
  const original = await f.request(true);
  await reconcileReleaseProposal(original, f.transport);
  await f.advance("fix(api): retain keys");
  const current = await f.request(true);
  assert.equal(current.configuration.schemaVersion, 2);
  if (current.configuration.schemaVersion !== 2) throw new Error("Expected onboarding fixture");
  const captured = await replayReleaseSnapshot(current.snapshot, current.configuration);
  const configuration = {
    ...current.configuration,
    bootstrap: {
      ...current.configuration.bootstrap,
      onboardingSha: captured.input.range.sourceCommitSha,
    },
    changelog: { verbosity: "concise", format: "compact" },
  } as const;
  const snapshot = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(captured.input, configuration),
  );
  await assert.rejects(
    reconcileReleaseProposal({ ...current, configuration, snapshot }, f.transport),
    { code: "configuration-mismatch" },
  );
});

void test("schema-5 collection retries retain the first capture time while changed author evidence refreshes", async (context) => {
  const f = await fixture(context);
  const request = await f.request(true);
  const legacy = await replayReleaseSnapshot(request.snapshot, request.configuration);
  const capture = async (capturedAt: string, login = "octocat") =>
    serializeReleaseSnapshot(
      await captureReleaseSnapshot(
        {
          ...legacy.input,
          pullRequests: legacy.input.pullRequests.map((pull) => ({ ...pull, authorLogin: login })),
        },
        request.configuration,
        capturedAt,
      ),
    );
  const firstTime = "2026-11-16T20:00:00.000Z";
  const nextTime = "2026-11-17T20:00:00.000Z";
  const created = await reconcileReleaseProposal(
    { ...request, snapshot: await capture(firstTime) },
    f.transport,
  );
  const writes = f.calls.filter(({ method }) => method !== "GET").length;
  const retry = await reconcileReleaseProposal(
    { ...request, snapshot: await capture(nextTime) },
    f.transport,
  );
  assert.equal(retry.outcome, "unchanged");
  assert.equal(retry.snapshotId, created.snapshotId);
  assert.equal(f.calls.filter(({ method }) => method !== "GET").length, writes);
  const refreshed = await reconcileReleaseProposal(
    { ...request, snapshot: await capture(nextTime, "new-author") },
    f.transport,
  );
  assert.equal(refreshed.outcome, "refreshed");
  assert.ok(refreshed.headSha);
  assert.ok(f.git(["show", `${refreshed.headSha}:.release-log/inputs.json`]).includes(nextTime));
  assert.ok(
    f.git(["show", `${refreshed.headSha}:CHANGELOG.md`]).includes("https://github.com/new-author"),
  );
});
