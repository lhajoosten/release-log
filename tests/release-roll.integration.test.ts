import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parse } from "yaml";
import { inspectCommit, inspectPendingRelease } from "../src/git.ts";
import type { GitHubRead } from "../src/github.ts";
import { collectMergedPullRequests } from "../src/github-association.ts";
import { createReleasePlan } from "../src/release-plan.ts";
import { preflightRelease } from "../src/release-preflight.ts";
import { rollRelease } from "../src/release-roll.ts";
import type { ReleaseRollRequest } from "../src/release-roll.ts";
import { replayReleaseSnapshot } from "../src/release-snapshot.ts";
import { fixture, json, object, text } from "./proposal-fixture.ts";

async function lifecycle(context: TestContext, bootstrapCommit = false) {
  const f = await fixture(context, "node", "feat(api): export rows", {
    bootstrap: true,
    adoption: true,
    bootstrapCommit,
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
      base: { ref: "main", sha: change.sha, repo: { id: 17, full_name: "example/project" } },
      user: { id: 7, type: "User" },
    };
  }
  const stackedPulls = new Map<number, ReturnType<typeof ordinary>>();
  const stackedOriginals = new Map<number, string[]>();
  const stackedLinks = new Map<string, number[]>();
  const stackedBases = new Map<string, number[]>();
  async function commits(shas: readonly string[]) {
    return Promise.all(
      shas.map(async (sha) => {
        const commit = await inspectCommit(f.directory, sha);
        return {
          sha,
          commit: { message: commit.message },
          parents: commit.parentShas.map((parent) => ({ sha: parent })),
        };
      }),
    );
  }

  const transport: GitHubRead = async (url, options) => {
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${token}`);
    const requestUrl = new URL(url);
    const path = decodeURIComponent(requestUrl.pathname.slice("/repos/example/project".length));
    const method = options.method ?? "GET";
    const association = /^\/commits\/([a-f0-9]+)\/pulls$/u.exec(path);
    if (association) {
      collectionCalls.push(path);
      const stack = stackedLinks.get(association[1] ?? "");
      if (stack) return json(stack.map((number) => stackedPulls.get(number)));
      return json(
        f.changes.flatMap((change, index) =>
          change.sha === association[1] ? [ordinary(index)] : [],
        ),
      );
    }
    const detail = /^\/pulls\/(\d+)(\/commits)?$/u.exec(path);
    const stacked = stackedPulls.get(Number(detail?.[1]));
    if (detail && stacked) {
      collectionCalls.push(path);
      return json(detail[2] ? await commits(stackedOriginals.get(stacked.number) ?? []) : stacked);
    }
    const base = requestUrl.searchParams.get("base");
    if (path === "/pulls" && base !== null && base !== "main") {
      collectionCalls.push(path);
      return json((stackedBases.get(base) ?? []).map((number) => stackedPulls.get(number)));
    }
    if (detail && Number(detail[1]) >= 101) {
      collectionCalls.push(path);
      const index = Number(detail[1]) - 101;
      const pull = ordinary(index);
      if (!detail[2]) return json(pull);
      return json(await commits([pull.merge_commit_sha]));
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
  async function landStack(titles: readonly [string, string, string], breakingCommit = false) {
    await rollRelease(request(), transport);
    const released = await merge("merge");
    await rollRelease({ ...request(), event: released.event }, transport);

    const tree = f.git(["rev-parse", "HEAD^{tree}"]).trim();
    const commit = (parents: readonly string[], message: string) =>
      f.git(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], message).trim();
    const root = commit([released.landing], "refactor: reorganize modules");
    const middle = commit([root], "fix: preserve selected rows");
    const topChange = commit(
      [middle],
      breakingCommit
        ? "feat!: allow exports\n\nBREAKING CHANGE: the export flag changed"
        : "refactor: share export layout",
    );
    const top = commit([topChange, root], "Merge the parent branch");
    const landing = commit([released.landing, top], "Merge the stacked changes");
    f.git(["update-ref", "refs/heads/main", landing, released.landing]);
    const refs = ["main", "stack/base", "stack/middle", "stack/top"];
    const heads = [released.landing, root, middle, top];
    for (const [index, originals] of [[root], [middle], [topChange, top]].entries()) {
      const ref = refs[index];
      const headRef = refs[index + 1];
      const baseSha = heads[index];
      const headSha = heads[index + 1];
      const title = titles[index];
      assert.ok(ref && headRef && baseSha && headSha && title);
      const number = 201 + index;
      stackedPulls.set(number, {
        ...ordinary(0),
        number,
        id: 2001 + index,
        title,
        body: [
          "~~~release-log",
          "version: 1",
          "audience: users",
          `summary: Stack change ${number}`,
          "impact: Preserve rows.",
          `required_action: ${index === 2 && breakingCommit ? "Use the new export flag." : "null"}`,
          "~~~",
        ].join("\n"),
        merge_commit_sha: landing,
        commits: originals.length,
        base: { ref, sha: baseSha, repo: { id: 17, full_name: "example/project" } },
        head: { sha: headSha, ref: headRef, repo: { id: 17 } },
      });
      stackedOriginals.set(number, originals);
      stackedBases.set(ref, [number]);
      for (const sha of originals) stackedLinks.set(sha, [201]);
    }
    stackedLinks.set(landing, [201]);
    const rootPull = stackedPulls.get(201);
    assert.ok(rootPull);
    return { event: event(rootPull), released, landing, root, middle, topChange, top };
  }
  return {
    f,
    inputs,
    ordinary,
    event,
    request,
    transport,
    collectionCalls,
    merge,
    landStack,
    stackedPulls,
    stackedOriginals,
    stackedLinks,
    stackedBases,
  };
}

void test("a tagged refactor stack makes no release and survives into the next proposal", async (context) => {
  const s = await lifecycle(context);
  const stack = await s.landStack([
    "refactor(stack): organize modules",
    "refactor(stack): organize selections",
    "refactor(stack): organize exports",
  ]);
  const request = { ...s.request(), event: stack.event };
  const before = s.f.calls.length;
  const noRelease = await rollRelease(request, s.transport);
  assert.equal(noRelease.route, "proposal");
  assert.equal(noRelease.result.outcome, "no-release");
  assert.equal(noRelease.result.baselineSha, stack.released.landing);
  assert.equal(noRelease.result.sourceSha, stack.landing);
  const retry = await rollRelease(request, s.transport);
  assert.equal(retry.route, "proposal");
  assert.equal(retry.result.outcome, "no-release");
  assert.equal(retry.result.baselineSha, noRelease.result.baselineSha);
  assert.equal(retry.result.sourceSha, noRelease.result.sourceSha);
  assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
  assert.equal(s.f.ref("tags/v0.1.0"), stack.released.landing);
  assert.equal(s.f.pulls.length, 1);

  await s.f.advance("fix(api): keep future rows");
  const proposal = await rollRelease(s.request(), s.transport);
  assert.equal(proposal.route, "proposal");
  assert.equal(proposal.result.outcome, "created");
  const { headSha } = proposal.result;
  const captured = await replayReleaseSnapshot(
    s.f.git(["show", `${headSha}:.release-log/inputs.json`]),
    s.inputs.configuration,
  );
  const latest = s.f.changes.at(-1)?.sha;
  assert.ok(latest);
  const expected = [
    latest,
    stack.root,
    stack.middle,
    stack.topChange,
    stack.top,
    stack.landing,
  ].toSorted();
  assert.deepEqual(captured.input.range.commitShas, expected);
  assert.deepEqual(
    captured.input.pullRequests
      .flatMap((pull) => pull.landedCommits.map((commit) => commit.sha))
      .toSorted(),
    expected,
  );
  assert.deepEqual(
    captured.input.pullRequests
      .filter((pull) => pull.stackBase)
      .map((pull) => ({
        number: pull.number,
        base: pull.stackBase,
        originals: pull.originalCommits.map((commit) => commit.sha),
        owned: pull.landedCommits.map((commit) => commit.sha),
      })),
    [
      {
        number: 201,
        base: { ref: "main", sha: stack.released.landing },
        originals: [stack.root],
        owned: [stack.landing, stack.root].toSorted(),
      },
      {
        number: 202,
        base: { ref: "stack/base", sha: stack.root },
        originals: [stack.middle],
        owned: [stack.middle],
      },
      {
        number: 203,
        base: { ref: "stack/middle", sha: stack.middle },
        originals: [stack.topChange, stack.top],
        owned: [stack.top, stack.topChange].toSorted(),
      },
    ],
  );
  const changelog = s.f.git(["show", `${headSha}:CHANGELOG.md`]);
  assert.match(changelog, /## v0\.1\.1/u);
  for (const number of [201, 202, 203]) {
    assert.match(changelog, new RegExp(`Stack change ${number}`, "u"));
    assert.match(changelog, new RegExp(`/pull/${number}\\)`, "u"));
  }
});

void test("stack PR titles contribute independently and breaking commits require their own metadata", async (context) => {
  const s = await lifecycle(context);
  const stack = await s.landStack(
    [
      "refactor(stack): organize modules",
      "fix(stack): preserve selections",
      "feat(stack): improve exports",
    ],
    true,
  );
  const request = { ...s.request(), event: stack.event };
  const before = s.f.calls.length;
  await assert.rejects(rollRelease(request, s.transport), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /PR #203 shared landing.*breaking/u);
    assert.ok(error.message.includes(stack.landing));
    return true;
  });
  assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
  const top = s.stackedPulls.get(203);
  assert.ok(top);
  top.title = "feat(stack)!: improve exports";
  const required = top.body;
  top.body = top.body.replace("Use the new export flag.", "null");
  await assert.rejects(
    rollRelease(request, s.transport),
    /PR #203 shared landing.*breaking-action-required/u,
  );
  top.body = required;

  const proposal = await rollRelease(request, s.transport);
  assert.equal(proposal.route, "proposal");
  assert.equal(proposal.result.outcome, "created");
  const { headSha } = proposal.result;
  const snapshotText = s.f.git(["show", `${headSha}:.release-log/inputs.json`]);
  const captured = await replayReleaseSnapshot(snapshotText, s.inputs.configuration);
  const plan = await createReleasePlan(snapshotText, s.inputs.configuration, {
    kind: "released",
    currentVersion: "0.1.0",
  });
  assert.equal(plan.nextVersion, "0.2.0");
  assert.deepEqual(
    plan.contributions.map(({ number, bump, breaking }) => ({ number, bump, breaking })),
    [
      { number: 201, bump: "none", breaking: false },
      { number: 202, bump: "patch", breaking: false },
      { number: 203, bump: "minor", breaking: true },
    ],
  );
  const changelog = s.f.git(["show", `${headSha}:CHANGELOG.md`]);
  assert.match(changelog, /Stack change 202/u);
  assert.match(changelog, /Stack change 203/u);
  assert.match(changelog, /Use the new export flag/u);

  const wrongOwner = structuredClone(captured.input);
  const [root, middle] = wrongOwner.pullRequests;
  assert.ok(root && middle);
  const reassigned = {
    ...wrongOwner,
    pullRequests: [
      { ...root, landedCommits: middle.landedCommits },
      { ...middle, landedCommits: root.landedCommits },
      ...wrongOwner.pullRequests.slice(2),
    ],
  };
  const serialized = JSON.stringify({ ...captured, input: reassigned });
  await assert.rejects(
    replayReleaseSnapshot(serialized, s.inputs.configuration),
    /incorrect landed commit ownership/u,
  );
});

void test("stack collection rejects missing, unrelated, overlapping, and partial evidence", async (context) => {
  const s = await lifecycle(context);
  const stack = await s.landStack([
    "refactor(stack): organize modules",
    "refactor(stack): organize selections",
    "refactor(stack): organize exports",
  ]);
  const request = { ...s.request(), event: stack.event };
  const before = s.f.calls.length;
  const diagnostic = (message: RegExp) => (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`PR #201 shared landing ${stack.landing}`));
    assert.match(error.message, message);
    return true;
  };
  s.stackedBases.delete("stack/middle");
  await assert.rejects(
    rollRelease(request, s.transport),
    diagnostic(/PR #202 has no corroborating continuation/u),
  );
  s.stackedBases.set("stack/middle", [203]);

  const inner = s.stackedPulls.get(202);
  assert.ok(inner);
  s.stackedPulls.set(204, { ...inner, number: 204, base: { ...inner.base, ref: "unrelated" } });
  s.stackedLinks.set(stack.middle, [201, 204]);
  await assert.rejects(
    rollRelease(request, s.transport),
    diagnostic(/PR #204 has an unrelated association/u),
  );
  s.stackedLinks.set(stack.middle, [201, 202]);

  inner.commits = 2;
  s.stackedOriginals.set(202, [stack.root, stack.middle]);
  await assert.rejects(
    rollRelease(request, s.transport),
    diagnostic(/PR #202 makes a competing claim/u),
  );
  inner.commits = 1;
  s.stackedOriginals.set(202, [stack.middle]);
  assert.equal((await rollRelease(request, s.transport)).route, "proposal");

  s.f.git(["tag", "v0.1.1", stack.root]);
  const range = await inspectPendingRelease(
    s.f.directory,
    { kind: "tag", name: "v0.1.1" },
    stack.landing,
  );
  await assert.rejects(
    collectMergedPullRequests(
      {
        repository: s.inputs.configuration.repository,
        releaseBranch: s.inputs.configuration.releaseBranch,
        localRepository: s.f.directory,
        token: request.token,
        range,
      },
      s.transport,
    ),
    diagnostic(/Git footprint crosses the tagged baseline/u),
  );
  assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
  assert.equal(s.f.pulls.length, 1);
});

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
    "permission-actions":
      "${{ steps.configuration.outputs.self-upgrade == 'true' && 'read' || '' }}",
    "permission-workflows":
      "${{ steps.configuration.outputs.self-upgrade == 'true' && 'write' || '' }}",
    "permission-contents": "write",
    "permission-pull-requests": "write",
  });
  const install = steps.find(
    (step) => step.name === "Install explicitly trusted producer runtimes before credentials",
  );
  assert.ok(install);
  assert.ok(steps.indexOf(install) < steps.indexOf(mint));
  assert.equal(object(install.env).VERIFICATION_RUNTIMES, "${{ inputs.verification-runtimes }}");
  assert.ok(!JSON.stringify(install).includes("steps.app.outputs.token"));
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

void test("initialization proposes the exact legacy setup cutoff and agrees with read-only roll", async (context) => {
  const { f, request, transport } = await lifecycle(context, true);
  f.git(["tag", "-d", "v1.2.3"]);
  const sourceSha = f.ref("heads/main");
  assert.ok(sourceSha);
  const setupSha = f.git(["rev-parse", "HEAD^"]).trim();
  const { repository, repositoryId, releaseBranch, releasePolicy } = request().configuration;
  const config = {
    schemaVersion: 1,
    repository,
    repositoryId,
    releaseBranch,
    releasePolicy,
  } as const;
  const inputs = {
    repository: f.directory,
    configuration: config,
    sourceSha,
    producerSha: "1".repeat(40),
    initialVersion: "0.1.0",
    token: request().token,
  };
  const app = {
    appId: "4321",
    botUserId: String(request().automation.botUserId),
    hasPrivateKey: true,
    installation: "success",
    permissions: "success",
    slug: "release-fixture",
    installationToken: "synthetic-probe-token",
    token: request().token,
  };
  const read: GitHubRead = (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    const path = new URL(url).pathname;
    if (path === "/repos/example/project/tags") return Promise.resolve(json([]));
    if (path === "/users/release-fixture%5Bbot%5D") {
      assert.equal(
        new Headers(options.headers).get("authorization"),
        "Bearer synthetic-probe-token",
      );
      return Promise.resolve(
        json({ login: "release-fixture[bot]", type: "Bot", id: Number(app.botUserId) }),
      );
    }
    return transport(url, options);
  };
  const before = f.git(["show-ref"]);
  const early = await preflightRelease({ ...inputs, onboardingSha: f.baseline }, read);
  assert.equal(early.status, "blocked");
  assert.match(early.findings.history?.message ?? "", new RegExp(setupSha, "u"));
  assert.equal(early.rangeReview?.bootstrap.onboardingSha, setupSha);
  assert.equal(early.caller, null);

  const preview = await preflightRelease(inputs, read);
  assert.equal(preview.status, "unverified");
  assert.equal(preview.findings.appConfiguration?.status, "unverified");
  assert.equal(preview.baseline.sha, f.baseline);
  assert.deepEqual(preview.rangeReview?.commitOnlyEvidence, [setupSha]);
  assert.deepEqual(preview.rangeReview?.landings, [
    { number: 101, sha: sourceSha, verification: "strict" },
  ]);
  assert.ok(preview.rangeReview);
  assert.ok(preview.caller);
  const caller = object(parse(preview.caller) as unknown);
  const job = object(object(caller.jobs).release);
  const parameters = object(job.with);
  assert.ok("workflow_dispatch" in object(caller.on));
  assert.equal(
    job.uses,
    `lhajoosten/release-log/.github/workflows/rolling-release.yml@${inputs.producerSha}`,
  );
  assert.equal(parameters["tool-sha"], inputs.producerSha);
  assert.equal(parameters.write, false);
  assert.doesNotMatch(
    JSON.stringify(preview),
    /synthetic-installation-token|Preserve rows|originalCommits/u,
  );

  const fixed = { ...config, schemaVersion: 2 as const, bootstrap: preview.rangeReview.bootstrap };
  const reviewed = { ...inputs, configuration: fixed, app };
  const verified = await preflightRelease(reviewed, read);
  assert.equal(verified.status, "ready");
  assert.equal(verified.findings.appDryRun?.status, "passed");
  const roll = await rollRelease({ ...request(), configuration: fixed, write: false }, read);
  assert.equal(roll.route, "proposal");
  assert.equal(roll.result.outcome, "would-create");
  assert.equal(f.git(["show-ref"]), before);
  assert.equal(f.git(["status", "--porcelain"]), "");

  const otherProducer = await preflightRelease({ ...reviewed, producerSha: "2".repeat(40) }, read);
  assert.notEqual(verified.inputId, otherProducer.inputId);
  for (const [overrides, stage] of [
    [
      { appId: "", botUserId: "", hasPrivateKey: false, installation: "skipped" },
      "appConfiguration",
    ],
    [{ installation: "failure" }, "appInstallation"],
    [{ permissions: "failure" }, "appPermissions"],
    [{ botUserId: "43" }, "appIdentity"],
  ] as const) {
    const blocked = await preflightRelease({ ...reviewed, app: { ...app, ...overrides } }, read);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.findings[stage]?.status, "blocked");
    assert.equal(blocked.findings.appDryRun?.status, "unverified");
    assert.equal(blocked.findings.history?.status, "passed");
    assert.equal(blocked.caller, null);
  }

  f.git(["commit", "--allow-empty", "-m", "chore: later direct change"]);
  const later = f.git(["rev-parse", "HEAD"]).trim();
  const stale = await preflightRelease(reviewed, read);
  assert.match(stale.findings.history?.message ?? "", /branch moved/u);
  const rejected = await preflightRelease({ ...reviewed, sourceSha: later }, read);
  assert.equal(rejected.status, "blocked");
  assert.match(rejected.findings.history?.message ?? "", new RegExp(later, "u"));
  assert.equal(rejected.rangeReview, null);
  assert.equal(f.ref("heads/release-log/main"), null);
});

void test("initialization reports missing and candidate version files, ancestry errors, lockfile blockers and adoption independently", async (context) => {
  const { f, request, transport } = await lifecycle(context, true);
  f.git(["tag", "-d", "v1.2.3"]);
  const config = request().configuration;
  assert.equal(config.schemaVersion, 2);
  const setupSha = f.git(["rev-parse", "HEAD^"]).trim();
  const fixed = { ...config, bootstrap: { baselineSha: f.baseline, onboardingSha: setupSha } };
  const sourceSha = f.git(["rev-parse", "HEAD"]).trim();
  const options = {
    repository: f.directory,
    configuration: fixed,
    sourceSha,
    producerSha: "1".repeat(40),
    initialVersion: "0.1.0",
    token: request().token,
  };
  let tags: unknown[] = [];
  const read: GitHubRead = (url, init) => {
    assert.equal(init.method, "GET");
    return new URL(url).pathname === "/repos/example/project/tags"
      ? Promise.resolve(json(tags))
      : transport(url, init);
  };

  f.git(["rm", "package.json"]);
  f.git(["commit", "-m", "chore: plan Python project"]);
  const planning = f.git(["rev-parse", "HEAD"]).trim();
  await writeFile(
    join(f.directory, "pyproject.toml"),
    '[project]\nname = "fixture-project"\nversion = "0.0.0"\n',
  );
  const uvLock =
    'version = 1\nrevision = 5\n\n[[package]]\nname = "fixture-project"\nversion = "0.0.0"\nsource = { virtual = "." }\n';
  await writeFile(join(f.directory, "uv.lock"), uvLock.replace("revision = 5", "revision = 99"));
  f.git(["add", "pyproject.toml", "uv.lock"]);
  f.git(["commit", "-m", "chore: prepare candidate files"]);
  const unsupported = f.git(["rev-parse", "HEAD"]).trim();
  await writeFile(join(f.directory, "uv.lock"), uvLock);
  f.git(["add", "uv.lock"]);
  f.git(["commit", "-m", "chore: use a supported lockfile revision"]);
  const compatible = f.git(["rev-parse", "HEAD"]).trim();
  f.git(["reset", "--hard", planning]);

  const missing = await preflightRelease(
    { ...options, sourceSha: planning, candidateSha: unsupported },
    read,
  );
  assert.match(
    missing.findings.sourceFiles?.message ?? "",
    /root package.json, pyproject.toml, or Cargo.toml/u,
  );
  assert.match(missing.findings.candidateFiles?.message ?? "", /Unsupported uv\.lock format/u);
  assert.equal(missing.findings.history?.status, "blocked");
  assert.equal(missing.caller, null);
  const candidate = await preflightRelease(
    { ...options, sourceSha: planning, candidateSha: compatible },
    read,
  );
  assert.equal(candidate.findings.candidateFiles?.status, "passed");
  assert.match(candidate.findings.candidateFiles?.message ?? "", /pyproject\.toml, uv\.lock/u);
  assert.equal(candidate.findings.sourceFiles?.status, "blocked");

  f.git(["reset", "--hard", unsupported]);
  const simultaneous = await preflightRelease({ ...options, sourceSha: unsupported }, read);
  assert.match(
    simultaneous.findings.history?.message ?? "",
    /Commit [a-f0-9]{40} has no verified merged-PR landing footprint/u,
  );
  assert.match(simultaneous.findings.sourceFiles?.message ?? "", /uv\.lock/u);
  const invalid = await preflightRelease(
    {
      ...options,
      sourceSha: unsupported,
      configuration: { ...fixed, bootstrap: { baselineSha: compatible, onboardingSha: setupSha } },
    },
    read,
  );
  assert.match(invalid.findings.history?.message ?? "", /baseline must be an ancestor/u);

  tags = [{ name: "v1.2.3" }];
  const tagged = await preflightRelease({ ...options, sourceSha: unsupported }, read);
  assert.match(
    tagged.findings.history?.message ?? "",
    /Stable tag v1\.2\.3.*established-release adoption/u,
  );
  assert.equal(tagged.findings.sourceFiles?.status, "blocked");
  assert.equal(f.ref("heads/release-log/main"), null);
  assert.equal(f.git(["status", "--porcelain"]), "");
});
