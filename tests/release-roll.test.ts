import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { parse } from "yaml";
import { inspectCommit } from "../src/git.ts";
import type { GitHubRead } from "../src/github.ts";
import { rollRelease } from "../src/release-roll.ts";
import type { ReleaseRollRequest } from "../src/release-roll.ts";
import { fixture, json, object, text } from "./proposal-fixture.ts";

async function lifecycle(context: TestContext) {
  const f = await fixture(context, "node", "feat(api): export rows", {
    bootstrap: true,
    adoption: true,
  });
  const inputs = await f.request();
  const token = "synthetic-installation-token";
  const collectionCalls: string[] = [];
  function ordinary(index: number) {
    const change = f.changes[index];
    assert.ok(change);
    return {
      number: index + 101,
      id: index + 1001,
      title: change.title,
      body:
        '```release-log\nversion: 1\naudience: users\nsummary: "Change ' +
        (index + 1) +
        '"\nimpact: Preserve rows.\nrequired_action: null\n```',
      state: "closed",
      merged: true,
      merged_at: "2026-11-14T12:00:00Z",
      updated_at: "2026-11-14T12:00:00Z",
      merge_commit_sha: change.sha,
      commits: 1,
      head: { ref: "feature", sha: change.sha, repo: { id: 17 } },
      base: { ref: "main", repo: { id: 17, full_name: "example/project" } },
      user: { id: 7, type: "User" },
    };
  }
  const transport: GitHubRead = async (url, options) => {
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${token}`);
    const path = decodeURIComponent(new URL(url).pathname.slice("/repos/example/project".length));
    const method = options.method ?? "GET";
    const association = /^\/commits\/([a-f0-9]+)\/pulls$/u.exec(path);
    if (association) {
      collectionCalls.push(path);
      return json(
        f.changes.flatMap((change, index) =>
          change.sha === association[1] ? [ordinary(index)] : [],
        ),
      );
    }
    const detail = /^\/pulls\/(\d+)(\/commits)?$/u.exec(path);
    if (detail && Number(detail[1]) >= 101) {
      collectionCalls.push(path);
      const index = Number(detail[1]) - 101;
      const pull = ordinary(index);
      if (!detail[2]) return json(pull);
      const commit = await inspectCommit(f.directory, pull.merge_commit_sha);
      return json([
        {
          sha: commit.sha,
          commit: { message: commit.message },
          parents: commit.parentShas.map((sha) => ({ sha })),
        },
      ]);
    }
    if (method === "GET" && path.startsWith("/git/tags/")) {
      const sha = path.slice("/git/tags/".length);
      const headers = f.git(["cat-file", "-p", sha]).split("\n");
      const target = headers.find((line) => line.startsWith("object "));
      const type = headers.find((line) => line.startsWith("type "));
      assert.ok(target && type);
      return json({ sha, object: { sha: target.slice(7), type: type.slice(5) } });
    }
    const response = await f.transport(url, options);
    if (!response.ok) return response;
    if (path.startsWith("/git/ref/tags/") || (method === "POST" && path === "/git/refs")) {
      const data = object(await response.json());
      const target = object(data.object);
      return json(
        {
          ...data,
          object: { ...target, type: f.git(["cat-file", "-t", text(target.sha)]).trim() },
        },
        response.status,
      );
    }
    const enrich = (value: unknown) => {
      const data = object(value);
      const original = f.pulls.find((pull) => pull.number === data.number);
      return {
        ...data,
        ...(data.state === "closed" && original ? { head: original.head } : {}),
        merged: data.merged_at !== null,
        base: { ...object(data.base), repo: { id: 17, full_name: "example/project" } },
      };
    };
    if (method === "GET" && path === "/pulls") {
      const data: unknown = await response.json();
      assert.ok(Array.isArray(data));
      return json(data.map(enrich));
    }
    if (method === "GET" && /^\/pulls\/\d+$/u.test(path))
      return json(enrich(await response.json()));
    return response;
  };
  function event(pull = ordinary(f.changes.length - 1)) {
    return {
      action: "closed",
      number: pull.number,
      repository: { id: 17, full_name: "example/project" },
      pull_request: pull,
    };
  }
  function request(): ReleaseRollRequest {
    return {
      configuration: inputs.configuration,
      automation: inputs.automation,
      repository: f.directory,
      token,
      eventName: "pull_request_target",
      event: event(),
      write: true,
    };
  }
  async function merge(kind: "merge" | "squash") {
    const head = f.ref("heads/release-log/main");
    const source = f.ref("heads/main");
    assert.ok(head && source);
    const landing = f
      .git(
        [
          "commit-tree",
          f.git(["rev-parse", `${head}^{tree}`]).trim(),
          "-p",
          source,
          ...(kind === "merge" ? ["-p", head] : []),
        ],
        "chore: merge generated release\n",
      )
      .trim();
    f.git(["update-ref", "refs/heads/main", landing, source]);
    const pull = f.pulls.at(-1);
    assert.ok(pull);
    Object.assign(pull, {
      state: "closed",
      merged: true,
      merged_at: "2026-11-14T12:00:00Z",
      merge_commit_sha: landing,
      merged_by: { id: 7, type: "User" },
    });
    const mergedEvent = {
      action: "closed",
      number: pull.number,
      repository: { id: 17, full_name: "example/project" },
      pull_request: { ...pull, base: { ref: "main" } },
    };
    f.git(["read-tree", "--reset", "-u", "HEAD"]);
    return { landing, event: mergedEvent, head };
  }
  return { f, inputs, ordinary, event, request, transport, collectionCalls, merge };
}

void test("ordinary delayed events refresh one complete proposal and identical retries write nothing", async (context) => {
  const s = await lifecycle(context);
  const firstEvent = s.event();
  const { write: _write, ...readOnly } = s.request();
  const dry = await rollRelease(readOnly, s.transport);
  assert.equal(dry.route, "proposal");
  if (dry.route !== "proposal") return;
  assert.equal(dry.result.outcome, "would-create");
  assert.equal(s.f.pulls.length, 0);
  const first = await rollRelease(s.request(), s.transport);
  assert.equal(first.route, "proposal");
  await s.f.advance("fix(api): retain selections");
  const second = await rollRelease({ ...s.request(), event: firstEvent }, s.transport);
  assert.equal(second.route, "proposal");
  if (first.route !== "proposal" || second.route !== "proposal") return;
  assert.equal(second.result.outcome, "refreshed");
  assert.equal(second.result.pullNumber, first.result.pullNumber);
  assert.equal(s.f.pulls.length, 1);
  assert.equal(second.result.sourceSha, s.f.ref("heads/main"));
  assert.ok(second.result.headSha);
  const captured = JSON.parse(
    s.f.git(["show", `${second.result.headSha}:.release-log/inputs.json`]),
  ) as unknown;
  assert.match(JSON.stringify(captured), /Change 1/u);
  assert.match(JSON.stringify(captured), /Change 2/u);
  const before = s.f.calls.length;
  const retry = await rollRelease(s.request(), s.transport);
  assert.equal(retry.route, "proposal");
  if (retry.route === "proposal") assert.equal(retry.result.outcome, "unchanged");
  assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
});

for (const kind of ["merge", "squash"] as const) {
  void test(`${kind} routes only to exact-landing tagging, pending blocks collection, and next cycle retains all changes`, async (context) => {
    const s = await lifecycle(context);
    await rollRelease(s.request(), s.transport);
    await s.f.advance("fix(api): keep the second change");
    await rollRelease(s.request(), s.transport);
    const merged = await s.merge(kind);
    await s.f.advance("fix(api): retain post-release work");
    // A failed tag must block before touching local history or collection.
    const collected = s.collectionCalls.length;
    const before = s.f.calls.length;
    await assert.rejects(
      rollRelease({ ...s.request(), repository: "/nonexistent/local-history" }, s.transport),
      /release-tag-pending/u,
    );
    assert.equal(s.collectionCalls.length, collected + 1); // event detail read only
    assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
    const tag = await rollRelease({ ...s.request(), event: merged.event }, s.transport);
    assert.deepEqual(tag, {
      route: "tag",
      result: { outcome: "created", tag: "v0.1.0", landingSha: merged.landing, pullNumber: 1 },
    });
    assert.equal(s.f.pulls.length, 1);
    assert.equal(s.collectionCalls.length, collected + 1);
    assert.equal(s.f.ref("tags/v0.1.0"), merged.landing);
    const taggedBefore = s.f.calls.length;
    const retry = await rollRelease({ ...s.request(), event: merged.event }, s.transport);
    assert.equal(retry.route, "tag");
    if (retry.route === "tag") assert.equal(retry.result.outcome, "unchanged");
    assert.ok(s.f.calls.slice(taggedBefore).every((call) => call.method === "GET"));
    // Matching annotated tags are also no-ops.
    s.f.git(["tag", "-d", "v0.1.0"]);
    s.f.git(["tag", "-a", "v0.1.0", merged.landing, "-m", "version boundary"]);
    const annotated = await rollRelease({ ...s.request(), event: merged.event }, s.transport);
    assert.equal(annotated.route, "tag");
    if (annotated.route === "tag") assert.equal(annotated.result.outcome, "unchanged");
    await s.f.advance("feat(api): keep all next-cycle work");
    const next = await rollRelease(s.request(), s.transport);
    assert.equal(next.route, "proposal");
    if (next.route !== "proposal") return;
    assert.equal(next.result.outcome, "created");
    assert.equal(next.result.pullNumber, 2);
    assert.ok(next.result.headSha);
    const changelog = s.f.git(["show", `${next.result.headSha}:CHANGELOG.md`]);
    assert.equal((changelog.match(/^## v0\.1\.0 \(\d{4}-\d{2}-\d{2}\)$/gmu) ?? []).length, 1);
    assert.match(changelog, /## v0\.2\.0/u);
    for (let i = 1; i <= 4; i++) assert.match(changelog, new RegExp(`Change ${i}`, "u"));
  });
}

void test("release verification failures never fall through to collection or writes", async (context) => {
  const s = await lifecycle(context);
  await rollRelease(s.request(), s.transport);
  const merged = await s.merge("merge");
  s.f.git(["tag", "v0.1.0", s.f.baseline]);
  const collected = s.collectionCalls.length;
  const before = s.f.calls.length;
  await assert.rejects(
    rollRelease({ ...s.request(), event: merged.event }, s.transport),
    /tag already points/u,
  );
  assert.equal(s.collectionCalls.length, collected);
  assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
  assert.equal(s.f.ref("tags/v0.1.0"), s.f.baseline);
  s.f.git(["tag", "-d", "v0.1.0"]);
  const pull = s.f.pulls[0];
  assert.ok(pull);
  pull.title = "chore(release): malicious altered metadata";
  await assert.rejects(
    rollRelease({ ...s.request(), event: merged.event }, s.transport),
    /metadata|identity/u,
  );
  assert.equal(s.collectionCalls.length, collected);
});

void test("tags, unmerged PRs and other branches are ignored; event landing mismatches fail", async (context) => {
  const s = await lifecycle(context);
  assert.deepEqual(
    await rollRelease({ ...s.request(), eventName: "push", event: {} }, s.transport),
    { route: "ignored" },
  );
  const e = s.event();
  assert.deepEqual(
    await rollRelease(
      { ...s.request(), event: { ...e, pull_request: { ...e.pull_request, merged: false } } },
      s.transport,
    ),
    { route: "ignored" },
  );
  assert.deepEqual(
    await rollRelease(
      {
        ...s.request(),
        event: { ...e, pull_request: { ...e.pull_request, base: { ref: "other" } } },
      },
      s.transport,
    ),
    { route: "ignored" },
  );
  assert.equal(s.f.calls.length, 0);
  await assert.rejects(
    rollRelease(
      {
        ...s.request(),
        event: { ...e, pull_request: { ...e.pull_request, merge_commit_sha: s.f.baseline } },
      },
      s.transport,
    ),
    /differs from its event/u,
  );
});

void test("local tag annotation identity must match remote before collecting the next cycle", async (context) => {
  const s = await lifecycle(context);
  await rollRelease(s.request(), s.transport);
  const merged = await s.merge("squash");
  await rollRelease({ ...s.request(), event: merged.event }, s.transport);
  const remoteObject = merged.landing;
  s.f.git(["tag", "-d", "v0.1.0"]);
  s.f.git(["tag", "-a", "v0.1.0", merged.landing, "-m", "different local object"]);
  await s.f.advance("fix(api): keep later work");
  const read: GitHubRead = (url, options) =>
    url.includes("/git/ref/tags/v0.1.0")
      ? Promise.resolve(
          json({ ref: "refs/tags/v0.1.0", object: { sha: remoteObject, type: "commit" } }),
        )
      : s.transport(url, options);
  const before = s.f.calls.length;
  const collected = s.collectionCalls.length;
  await assert.rejects(
    rollRelease(s.request(), read),
    /Local baseline tag\/object\/commit differs/u,
  );
  assert.equal(s.collectionCalls.length, collected + 1);
  assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
});

void test("reusable workflow mints scoped App tokens after queueing and runs only pinned packaged code", async () => {
  const workflow = object(
    parse(
      await readFile(new URL("../.github/workflows/rolling-release.yml", import.meta.url), "utf8"),
    ) as unknown,
  );
  assert.deepEqual(Object.keys(object(workflow.on)), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "release-log-${{ github.repository }}-${{ inputs.release-branch }}",
    "cancel-in-progress": false,
  });
  const roll = object(object(workflow.jobs).roll);
  assert.ok(Array.isArray(roll.steps));
  const steps = roll.steps.map(object);
  for (const step of steps) if (step.uses) assert.match(text(step.uses), /@[a-f0-9]{40}$/u);
  const mint = steps.find((step) => step.id === "app");
  assert.ok(mint);
  assert.deepEqual(mint.with, {
    "app-id": "${{ inputs.app-id }}",
    "private-key": "${{ secrets.app-private-key }}",
    "permission-contents": "write",
    "permission-pull-requests": "write",
  });
  const route = steps.at(-1);
  assert.ok(route);
  assert.equal(object(route.env).RELEASE_LOG_APP_TOKEN, "${{ steps.app.outputs.token }}");
  assert.ok(steps.indexOf(mint) < steps.indexOf(route));
  for (const step of steps.filter((candidate) => candidate.run)) {
    assert.ok(!text(step.run).includes("${{"));
    assert.ok(!text(step.run).includes("github.event.pull_request.head"));
  }
});

void test("a source change before collection fails without collecting or writing", async (context) => {
  const s = await lifecycle(context);
  let sourceReads = 0;
  s.f.intercept(async (method, path) => {
    if (method === "GET" && path === "/git/ref/heads/main" && ++sourceReads === 3)
      await s.f.advance("fix(api): raced before collection");
    return null;
  });
  await assert.rejects(rollRelease(s.request(), s.transport), /source changed before collection/u);
  assert.equal(s.collectionCalls.length, 1);
  assert.ok(s.f.calls.every((call) => call.method === "GET"));
});

void test("a source change during collection prevents subsequent proposal writes", async (context) => {
  const s = await lifecycle(context);
  let changed = false;
  const racing: GitHubRead = async (url, options) => {
    const response = await s.transport(url, options);
    if (!changed && url.includes("/pulls/101/commits")) {
      changed = true;
      await s.f.advance("fix(api): raced during collection");
    }
    return response;
  };
  await assert.rejects(rollRelease(s.request(), racing), /Main changed after capture/u);
  assert.ok(changed);
  assert.equal(s.f.pulls.length, 0);
  assert.ok(s.f.calls.every((call) => call.method === "GET"));
});
