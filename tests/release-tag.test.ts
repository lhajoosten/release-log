import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import type { GitHubRead } from "../src/github.ts";
import { reconcileReleaseTag } from "../src/release-tag.ts";
import type { ReleaseTagRequest } from "../src/release-tag.ts";
import { fixture, json, object, text } from "./proposal-fixture.ts";

async function mergedProposal(
  context: TestContext,
  mergeKind: "merge" | "squash" = "merge",
  bootstrap = false,
) {
  const setup = bootstrap ? { bootstrap: true, bootstrapCommit: true, adoption: true } : {};
  const f = await fixture(context, "node", "feat(api): export rows", setup);
  const proposalRequest = await f.request(true);
  const proposal = await reconcileReleaseProposal(proposalRequest, f.transport);
  assert.equal(proposal.outcome, "created");
  assert.ok(proposal.headSha);
  const pullNumber = proposal.pullNumber;
  assert.ok(pullNumber);
  const sourceSha = proposal.sourceSha;
  const headSha = proposal.headSha;
  const treeSha = f.git(["rev-parse", `${headSha}^{tree}`]).trim();
  const parents = mergeKind === "merge" ? ["-p", sourceSha, "-p", headSha] : ["-p", sourceSha];
  const landingSha = f
    .git(["commit-tree", treeSha, ...parents], "chore: merge release proposal\n")
    .trim();
  f.git(["update-ref", "refs/heads/main", landingSha, sourceSha]);
  const pull = f.pulls[0];
  assert.ok(pull);
  Object.assign(pull, {
    state: "closed",
    merged_at: "2026-11-14T12:00:00Z",
    merge_commit_sha: landingSha,
    merged_by: { id: 7, type: "User" },
  });
  const request: ReleaseTagRequest = {
    configuration: proposalRequest.configuration,
    automation: proposalRequest.automation,
    pullNumber,
    landingSha,
    token: proposalRequest.token,
  };
  return { f, request, sourceSha, headSha, landingSha, pull };
}

function tagTransport(f: Awaited<ReturnType<typeof fixture>>) {
  return async (url: string, options: RequestInit = {}) => {
    const target = new URL(url);
    const path = decodeURIComponent(target.pathname.slice("/repos/example/project".length));
    const method = options.method ?? "GET";

    if (method === "GET" && path.startsWith("/git/tags/")) {
      const sha = path.slice("/git/tags/".length);
      f.calls.push({ method, path, body: null });
      const headers = f.git(["cat-file", "-p", sha]).split("\n");
      const objectHeader = headers.find((line) => line.startsWith("object "));
      const typeHeader = headers.find((line) => line.startsWith("type "));
      assert.ok(objectHeader && typeHeader);
      return json({
        sha,
        object: { sha: objectHeader.slice(7), type: typeHeader.slice(5) },
      });
    }

    const response = await f.transport(url, options);
    if (!response.ok) return response;

    if (method === "GET" && path.startsWith("/git/ref/tags/")) {
      const data = object(await response.json());
      const targetObject = object(data.object);
      const type = f.git(["cat-file", "-t", text(targetObject.sha)]).trim();
      return json({ ...data, object: { ...targetObject, type } });
    }

    if (method === "POST" && path === "/git/refs") {
      const data = object(await response.json());
      const targetObject = object(data.object);
      return json({ ...data, object: { ...targetObject, type: "commit" } }, response.status);
    }

    return response;
  };
}

void test("bootstrap release tags are read-only by default", async (context) => {
  const state = await mergedProposal(context, "merge", true);
  const before = state.f.calls.length;
  const result = await reconcileReleaseTag(state.request, tagTransport(state.f));

  assert.deepEqual(result, {
    outcome: "would-create",
    tag: "v0.1.0",
    landingSha: state.landingSha,
    pullNumber: state.request.pullNumber,
  });
  assert.equal(state.f.ref("tags/v0.1.0"), null);
  const calls = state.f.calls.slice(before);
  assert.ok(calls.every(({ method }) => method === "GET"));
  assert.ok(
    calls.every(({ path }) => !path.startsWith("/releases") && !path.startsWith("/checks")),
  );
});

for (const mergeKind of ["merge", "squash"] as const) {
  void test(`${mergeKind} landing is tagged at its exact commit and retries are no-ops`, async (context) => {
    const state = await mergedProposal(context, mergeKind);
    const transport = tagTransport(state.f);
    const before = state.f.calls.length;
    const result = await reconcileReleaseTag({ ...state.request, write: true }, transport);

    assert.deepEqual(result, {
      outcome: "created",
      tag: "v1.3.0",
      landingSha: state.landingSha,
      pullNumber: state.request.pullNumber,
    });
    assert.equal(state.f.ref("tags/v1.3.0"), state.landingSha);
    const writes = state.f.calls.slice(before).filter(({ method }) => method !== "GET");
    assert.deepEqual(
      writes.map(({ method, path }) => ({ method, path })),
      [{ method: "POST", path: "/git/refs" }],
    );

    const writeCount = state.f.calls.filter(({ method }) => method !== "GET").length;
    const retry = await reconcileReleaseTag({ ...state.request, write: true }, transport);
    assert.equal(retry.outcome, "unchanged");
    assert.equal(state.f.calls.filter(({ method }) => method !== "GET").length, writeCount);
  });
}

void test("a later main commit does not retarget the release tag", async (context) => {
  const state = await mergedProposal(context);
  await state.f.advance("fix(api): a later change");

  const result = await reconcileReleaseTag(
    { ...state.request, write: true },
    tagTransport(state.f),
  );

  assert.equal(result.outcome, "created");
  assert.equal(result.landingSha, state.landingSha);
  assert.equal(state.f.ref("tags/v1.3.0"), state.landingSha);
});

void test("wrong landing, bot, generated metadata, tree or main ancestry fail before tag writes", async (context) => {
  const cases = ["landing", "bot", "metadata", "tree", "rebase", "stale-main"] as const;
  const expectedErrors: Record<(typeof cases)[number], RegExp> = {
    landing: /supplied landing SHA differs/u,
    bot: /Reserved proposal PR identity/u,
    metadata: /Proposal metadata, ancestry or generated identity/u,
    tree: /release landing tree differs/u,
    rebase: /verified merge or squash/u,
    "stale-main": /rewound or diverged/u,
  };
  for (const failure of cases) {
    const state = await mergedProposal(context);
    const wrongLanding = state.sourceSha;
    let selectedLanding = state.landingSha;

    if (failure === "bot") state.pull.user = { id: 99, type: "Bot" };
    if (failure === "metadata") state.pull.title = "chore(release): forged proposal";
    if (failure === "tree") {
      const treeSha = state.f.git(["rev-parse", `${state.headSha}^{tree}`]).trim();
      const changedTree = state.f.createTree(treeSha, [
        { path: "unrelated.txt", mode: "100644", content: "tampered\n" },
      ]);
      selectedLanding = state.f
        .git(
          ["commit-tree", changedTree, "-p", state.sourceSha, "-p", state.headSha],
          "chore: merge release proposal\n",
        )
        .trim();
      state.f.git(["update-ref", "refs/heads/main", selectedLanding, state.landingSha]);
      state.pull.merge_commit_sha = selectedLanding;
    }
    if (failure === "rebase") {
      const sourceTree = state.f.git(["rev-parse", `${state.sourceSha}^{tree}`]).trim();
      const rebasedParent = state.f
        .git(["commit-tree", sourceTree, "-p", state.sourceSha], "chore: prepare release\n")
        .trim();
      const proposalTree = state.f.git(["rev-parse", `${state.headSha}^{tree}`]).trim();
      selectedLanding = state.f
        .git(["commit-tree", proposalTree, "-p", rebasedParent], "chore: rebased release\n")
        .trim();
      state.f.git(["update-ref", "refs/heads/main", selectedLanding, state.landingSha]);
      state.pull.merge_commit_sha = selectedLanding;
    }
    if (failure === "stale-main")
      state.f.git(["update-ref", "refs/heads/main", state.sourceSha, state.landingSha]);

    const request =
      failure === "landing"
        ? { ...state.request, landingSha: wrongLanding }
        : { ...state.request, landingSha: selectedLanding };
    const before = state.f.calls.length;
    await assert.rejects(
      reconcileReleaseTag({ ...request, write: true }, tagTransport(state.f)),
      expectedErrors[failure],
      failure,
    );
    assert.ok(
      state.f.calls.slice(before).every(({ method }) => method === "GET"),
      failure,
    );
  }
});

void test("open and unmerged proposal PRs cannot be tagged", async (context) => {
  const f = await fixture(context);
  const proposalRequest = await f.request(true);
  const proposal = await reconcileReleaseProposal(proposalRequest, f.transport);
  const pullNumber = proposal.pullNumber;
  assert.ok(pullNumber);
  const request: ReleaseTagRequest = {
    configuration: proposalRequest.configuration,
    automation: proposalRequest.automation,
    pullNumber,
    landingSha: proposal.sourceSha,
    token: proposalRequest.token,
  };
  const before = f.calls.length;

  await assert.rejects(
    reconcileReleaseTag(request, tagTransport(f)),
    /closed, merged pull request/u,
  );
  assert.ok(f.calls.slice(before).every(({ method }) => method === "GET"));
});

void test("invalid requests are rejected before HTTP", async (context) => {
  const state = await mergedProposal(context);
  let requests = 0;
  const noHTTP: GitHubRead = async () => {
    requests += 1;
    throw new Error("Unexpected HTTP request");
  };
  const invalidWrite = { ...state.request };
  Object.defineProperty(invalidWrite, "write", { value: "yes" });
  const invalid = [
    { request: { ...state.request, pullNumber: 0 }, error: /positive release pull request/u },
    { request: { ...state.request, landingSha: "not-a-sha" }, error: /complete lowercase/u },
    { request: { ...state.request, token: " " }, error: /repository-limited GitHub token/u },
    { request: invalidWrite, error: /boolean write option/u },
  ];

  for (const input of invalid)
    await assert.rejects(reconcileReleaseTag(input.request, noHTTP), input.error);
  assert.equal(requests, 0);
});

void test("a moved captured baseline tag blocks tag creation", async (context) => {
  const state = await mergedProposal(context);
  state.f.git(["tag", "-f", "v1.2.3", state.landingSha]);
  const before = state.f.calls.length;

  await assert.rejects(
    reconcileReleaseTag({ ...state.request, write: true }, tagTransport(state.f)),
    /baseline tag moved/u,
  );
  assert.ok(state.f.calls.slice(before).every(({ method }) => method === "GET"));
  assert.equal(state.f.ref("tags/v1.3.0"), null);
});

void test("matching annotated tags are reused and conflicting tags are never moved", async (context) => {
  const matching = await mergedProposal(context);
  matching.f.git(["tag", "-a", "v1.3.0", matching.landingSha, "-m", "matching release"]);
  const beforeMatching = matching.f.calls.length;
  const matchingResult = await reconcileReleaseTag(matching.request, tagTransport(matching.f));
  assert.equal(matchingResult.outcome, "unchanged");
  assert.ok(matching.f.calls.slice(beforeMatching).every(({ method }) => method === "GET"));

  const conflicting = await mergedProposal(context);
  conflicting.f.git(["tag", "v1.3.0", conflicting.sourceSha]);
  const beforeConflict = conflicting.f.calls.length;
  await assert.rejects(
    reconcileReleaseTag({ ...conflicting.request, write: true }, tagTransport(conflicting.f)),
    /never move or overwrite/u,
  );
  assert.ok(conflicting.f.calls.slice(beforeConflict).every(({ method }) => method === "GET"));
  assert.equal(conflicting.f.ref("tags/v1.3.0"), conflicting.sourceSha);
});

void test("write rechecks PR, baseline, main and tag state before creating the ref", async (context) => {
  const expectedErrors = {
    pull: /pull request changed during tag reconciliation/u,
    baseline: /baseline tag moved/u,
    main: /rewound or diverged/u,
    tag: /tag changed during reconciliation and points elsewhere/u,
  };
  for (const boundary of ["pull", "baseline", "main", "tag"] as const) {
    const state = await mergedProposal(context);
    let reads = 0;
    state.f.intercept((method, path) => {
      const expectedPath =
        boundary === "pull"
          ? `/pulls/${state.request.pullNumber}`
          : boundary === "baseline"
            ? "/git/ref/tags/v1.2.3"
            : boundary === "main"
              ? "/git/ref/heads/main"
              : "/git/ref/tags/v1.3.0";
      if (method !== "GET" || path !== expectedPath || ++reads !== 2) return null;
      if (boundary === "pull") state.pull.title = "chore(release): changed during tag";
      if (boundary === "baseline") state.f.git(["tag", "-f", "v1.2.3", state.landingSha]);
      if (boundary === "main")
        state.f.git(["update-ref", "refs/heads/main", state.sourceSha, state.landingSha]);
      if (boundary === "tag") state.f.git(["tag", "v1.3.0", state.sourceSha]);
      return null;
    });
    const before = state.f.calls.length;

    await assert.rejects(
      reconcileReleaseTag({ ...state.request, write: true }, tagTransport(state.f)),
      expectedErrors[boundary],
      boundary,
    );
    assert.ok(
      state.f.calls.slice(before).every(({ method }) => method === "GET"),
      boundary,
    );
    if (boundary === "tag") assert.equal(state.f.ref("tags/v1.3.0"), state.sourceSha);
  }
});

void test("an unexpected tag creation response is not retried", async (context) => {
  const state = await mergedProposal(context);
  state.f.intercept((method, path) =>
    method === "POST" && path === "/git/refs"
      ? json({ ref: "refs/tags/v1.3.0", object: { type: "commit", sha: state.sourceSha } }, 201)
      : null,
  );
  const before = state.f.calls.length;

  await assert.rejects(
    reconcileReleaseTag({ ...state.request, write: true }, tagTransport(state.f)),
    /unexpected tag creation response/u,
  );
  assert.equal(state.f.calls.slice(before).filter(({ method }) => method !== "GET").length, 1);
  assert.equal(state.f.ref("tags/v1.3.0"), null);
});
