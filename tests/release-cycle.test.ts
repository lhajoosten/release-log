import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import {
  captureReleaseReview,
  finalizeReleaseApproval,
  verifyReleaseApproval,
} from "../src/release-approval.ts";
import { ReleaseCycleError, selectReleaseCycle } from "../src/release-cycle.ts";
import type { ReleaseCycleRequest } from "../src/release-cycle.ts";
import type { GitHubRead } from "../src/github.ts";
import { fixture, json, object, text } from "./proposal-fixture.ts";

async function mergedProposal(
  context: TestContext,
  kind: "merge" | "squash" = "merge",
  mode: "node" | "python" | "both" = "node",
) {
  const f = await fixture(context, mode);
  const proposalRequest = await f.request(true);
  const proposal = await reconcileReleaseProposal(proposalRequest, f.transport);
  assert.equal(proposal.outcome, "created");
  assert.ok(proposal.pullNumber);
  assert.ok(proposal.headSha);

  const sourceSha = proposal.sourceSha;
  const treeSha = f.git(["rev-parse", `${proposal.headSha}^{tree}`]).trim();
  const landingSha = f
    .git(
      [
        "commit-tree",
        treeSha,
        "-p",
        sourceSha,
        ...(kind === "merge" ? ["-p", proposal.headSha] : []),
      ],
      "chore: merge release proposal\n",
    )
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

  const request: ReleaseCycleRequest = {
    configuration: proposalRequest.configuration,
    automation: proposalRequest.automation,
    token: proposalRequest.token,
    sourceSha: landingSha,
  };
  return { f, request, sourceSha, landingSha, pull };
}

async function openProposal(context: TestContext) {
  const f = await fixture(context);
  const proposalRequest = await f.request(true);
  const proposal = await reconcileReleaseProposal(proposalRequest, f.transport);
  assert.equal(proposal.outcome, "created");
  return {
    f,
    request: {
      configuration: proposalRequest.configuration,
      automation: proposalRequest.automation,
      token: proposalRequest.token,
      sourceSha: proposal.sourceSha,
    } satisfies ReleaseCycleRequest,
  };
}

function cycleTransport(f: Awaited<ReturnType<typeof fixture>>): GitHubRead {
  return async (url, options) => {
    const target = new URL(url);
    const path = decodeURIComponent(target.pathname.slice("/repos/example/project".length));
    const method = options.method ?? "GET";

    if (method === "GET" && path.startsWith("/git/tags/")) {
      const sha = path.slice("/git/tags/".length);
      f.calls.push({ method, path, body: null });
      const lines = f.git(["cat-file", "-p", sha]).split("\n");
      const objectHeader = lines.find((line) => line.startsWith("object "));
      const typeHeader = lines.find((line) => line.startsWith("type "));
      assert.ok(objectHeader && typeHeader);
      return json({
        sha,
        object: { sha: objectHeader.slice(7), type: typeHeader.slice(5) },
      });
    }

    const response = await f.transport(url, options);
    if (!response.ok) return response;

    if (method === "GET" && path === "/pulls") {
      const pulls: unknown = await response.json();
      assert.ok(Array.isArray(pulls));
      return json(
        pulls.map((value: unknown) => {
          const pull = object(value);
          delete pull.merged_by;
          const original = f.pulls.find((item) => item.number === pull.number);
          if (pull.state === "closed" && original) pull.head = original.head;
          return pull;
        }),
      );
    }

    if (method === "GET" && /^\/pulls\/[0-9]+$/u.test(path)) {
      const data = object(await response.json());
      const original = f.pulls.find((item) => item.number === data.number);
      if (data.state === "closed" && original) data.head = original.head;
      return json(data);
    }

    if (method === "GET" && path.startsWith("/git/ref/tags/")) {
      const data = object(await response.json());
      const targetObject = object(data.object);
      const type = f.git(["cat-file", "-t", text(targetObject.sha)]).trim();
      return json({ ...data, object: { ...targetObject, type } });
    }

    if (method === "GET" && path.startsWith("/compare/")) {
      const data = object(await response.json());
      const [baseSha, targetSha] = path.slice("/compare/".length).split("...");
      assert.ok(baseSha && targetSha);
      const mergeBaseSha = f.git(["merge-base", baseSha, targetSha]).trim();
      const aheadBy = Number(f.git(["rev-list", "--count", targetSha, "--not", baseSha]).trim());
      const behindBy = Number(f.git(["rev-list", "--count", baseSha, "--not", targetSha]).trim());
      const status =
        aheadBy === 0 && behindBy === 0
          ? "identical"
          : aheadBy > 0 && behindBy === 0
            ? "ahead"
            : aheadBy === 0 && behindBy > 0
              ? "behind"
              : "diverged";
      return json({
        ...data,
        status,
        ahead_by: aheadBy,
        behind_by: behindBy,
        base_commit: { ...object(data.base_commit), sha: baseSha },
        merge_base_commit: { ...object(data.merge_base_commit), sha: mergeBaseSha },
      });
    }

    return response;
  };
}

function assertReadOnly(calls: readonly { readonly method: string }[], start: number): void {
  assert.ok(calls.slice(start).every(({ method }) => method === "GET"));
}

void test("an explicit bootstrap baseline is selected only when its ancestry reaches the source", async (context) => {
  const f = await fixture(context, "node", "feat(api): export rows", {
    bootstrap: true,
    bootstrapCommit: true,
    adoption: true,
  });
  const inputs = await f.request();
  const sourceSha = f.ref("heads/main");
  assert.ok(sourceSha);
  assert.equal(inputs.configuration.schemaVersion, 2);
  const before = f.calls.length;

  const result = await selectReleaseCycle(
    {
      configuration: inputs.configuration,
      automation: inputs.automation,
      token: inputs.token,
      sourceSha,
    },
    cycleTransport(f),
  );

  assert.deepEqual(result, {
    outcome: "selected",
    sourceSha,
    baseline: { kind: "bootstrap", commitSha: f.baseline },
    version: { kind: "bootstrap", initialVersion: "0.1.0" },
  });
  assertReadOnly(f.calls, before);
});

void test("a stale captured source cannot select the bootstrap baseline", async (context) => {
  const f = await fixture(context, "node", "feat(api): export rows", {
    bootstrap: true,
    bootstrapCommit: true,
    adoption: true,
  });
  const inputs = await f.request();
  const before = f.calls.length;

  await assert.rejects(
    selectReleaseCycle(
      {
        configuration: inputs.configuration,
        automation: inputs.automation,
        token: inputs.token,
        sourceSha: f.baseline,
      },
      cycleTransport(f),
    ),
    (error: unknown) => error instanceof ReleaseCycleError && error.code === "source-not-current",
  );
  assertReadOnly(f.calls, before);
});

void test("a merged list-pulls item without merged_by reaches detail verification and reports tag pending", async (context) => {
  const state = await mergedProposal(context);
  const before = state.f.calls.length;

  const result = await selectReleaseCycle(state.request, cycleTransport(state.f));

  assert.deepEqual(result, {
    outcome: "release-tag-pending",
    sourceSha: state.landingSha,
    tag: "v1.3.0",
    landingSha: state.landingSha,
    pullNumber: 1,
  });
  assert.equal(state.f.ref("tags/v1.3.0"), null);
  assertReadOnly(state.f.calls, before);
});

void test("a verified annotated tag selects its exact landing as the current baseline", async (context) => {
  const state = await mergedProposal(context);
  state.f.git(["tag", "-a", "v1.3.0", state.landingSha, "-m", "release v1.3.0"]);
  await state.f.advance("fix(api): preserve later changes");
  const sourceSha = state.f.ref("heads/main");
  assert.ok(sourceSha);
  const before = state.f.calls.length;

  const result = await selectReleaseCycle({ ...state.request, sourceSha }, cycleTransport(state.f));

  assert.deepEqual(result, {
    outcome: "selected",
    sourceSha,
    baseline: {
      kind: "tag",
      name: "v1.3.0",
      objectSha: state.f.ref("tags/v1.3.0"),
      commitSha: state.landingSha,
      pullNumber: 1,
    },
    version: { kind: "released", currentVersion: "1.3.0" },
  });
  assertReadOnly(state.f.calls, before);
});

void test("a stale source before the latest release landing cannot fall back to an older baseline", async (context) => {
  const state = await mergedProposal(context);
  const before = state.f.calls.length;

  await assert.rejects(
    selectReleaseCycle({ ...state.request, sourceSha: state.sourceSha }, cycleTransport(state.f)),
    (error: unknown) =>
      error instanceof ReleaseCycleError && error.code === "source-not-descendant",
  );
  assertReadOnly(state.f.calls, before);
});

void test("closed unmerged proposals are reported separately from merged-but-untagged releases", async (context) => {
  const state = await openProposal(context);
  const pull = state.f.pulls[0];
  assert.ok(pull);
  Object.assign(pull, { state: "closed" });
  const before = state.f.calls.length;

  const result = await selectReleaseCycle(state.request, cycleTransport(state.f));

  assert.deepEqual(result, {
    outcome: "closed-unmerged",
    sourceSha: state.request.sourceSha,
    pullNumbers: [1],
  });
  assertReadOnly(state.f.calls, before);
});

void test("divergent merged landings are ambiguous rather than ordered by PR metadata", async (context) => {
  const state = await mergedProposal(context);
  const siblingTree = state.f.git(["rev-parse", `${state.f.baseline}^{tree}`]).trim();
  const siblingLanding = state.f
    .git(["commit-tree", siblingTree, "-p", state.f.baseline], "chore: unrelated release landing\n")
    .trim();
  const competingPull = structuredClone(state.pull);
  Object.assign(competingPull, { number: 2, merge_commit_sha: siblingLanding });
  state.f.pulls.push(competingPull);
  const before = state.f.calls.length;

  await assert.rejects(
    selectReleaseCycle(state.request, cycleTransport(state.f)),
    (error: unknown) =>
      error instanceof ReleaseCycleError && error.code === "ambiguous-release-history",
  );
  assertReadOnly(state.f.calls, before);
});

void test("ancestry selects the latest release even when an older PR has a larger number", async (context) => {
  const state = await mergedProposal(context);
  Object.assign(state.pull, { number: 2 });
  const olderPull = structuredClone(state.pull);
  Object.assign(olderPull, { number: 99, merge_commit_sha: state.sourceSha });
  state.f.pulls.push(olderPull);
  const before = state.f.calls.length;

  const result = await selectReleaseCycle(state.request, cycleTransport(state.f));

  assert.deepEqual(result, {
    outcome: "release-tag-pending",
    sourceSha: state.landingSha,
    tag: "v1.3.0",
    landingSha: state.landingSha,
    pullNumber: 2,
  });
  assertReadOnly(state.f.calls, before);
});

void test("without merged proposal history, schema-1 configuration does not infer a tag", async (context) => {
  const f = await fixture(context);
  const inputs = await f.request();
  const sourceSha = f.ref("heads/main");
  assert.ok(sourceSha);
  const before = f.calls.length;

  await assert.rejects(
    selectReleaseCycle(
      {
        configuration: inputs.configuration,
        automation: inputs.automation,
        token: inputs.token,
        sourceSha,
      },
      cycleTransport(f),
    ),
    (error: unknown) => error instanceof ReleaseCycleError && error.code === "baseline-unavailable",
  );
  assertReadOnly(f.calls, before);
});

void test("multiple open reserved proposals fail closed", async (context) => {
  const state = await openProposal(context);
  const first = state.f.pulls[0];
  assert.ok(first);
  const competing = structuredClone(first);
  Object.assign(competing, { number: 2 });
  state.f.pulls.push(competing);
  const before = state.f.calls.length;

  await assert.rejects(
    selectReleaseCycle(state.request, cycleTransport(state.f)),
    (error: unknown) =>
      error instanceof ReleaseCycleError && error.code === "ambiguous-open-proposals",
  );
  assertReadOnly(state.f.calls, before);
});

void test("a missing release tag stops proposal writes with release-tag-pending", async (context) => {
  const state = await mergedProposal(context);
  state.f.git(["tag", "v1.3.0", state.landingSha]);
  state.f.git(["read-tree", "--reset", "-u", "HEAD"]);
  await state.f.advance("fix(api): preserve later changes");
  const snapshot = await state.f.snapshot("v1.3.0");
  state.f.git(["tag", "-d", "v1.3.0"]);
  const before = state.f.calls.length;
  await assert.rejects(
    reconcileReleaseProposal(
      {
        configuration: state.request.configuration,
        automation: state.request.automation,
        token: state.request.token,
        write: true,
        snapshot,
        version: { kind: "released", currentVersion: "1.3.0" },
      },
      cycleTransport(state.f),
    ),
    /release-tag-pending/u,
  );
  assertReadOnly(state.f.calls, before);
});

for (const [kind, retained] of [
  ["merge", true],
  ["merge", false],
  ["squash", true],
  ["squash", false],
] as const) {
  void test(`a ${kind}-landed tagged release starts a new cycle with the prior branch ${retained ? "retained" : "deleted"}`, async (context) => {
    const state = await mergedProposal(context, kind);
    const priorHead = text(object(state.pull.head).sha);
    state.f.git(["tag", "v1.3.0", state.landingSha]);
    if (!retained) state.f.git(["update-ref", "-d", "refs/heads/release-log/main"]);
    state.f.git(["read-tree", "--reset", "-u", "HEAD"]);
    await state.f.advance("fix(api): preserve later changes");
    const snapshot = await state.f.snapshot("v1.3.0");
    const before = state.f.calls.length;
    await assert.rejects(
      reconcileReleaseProposal(
        {
          configuration: state.request.configuration,
          automation: state.request.automation,
          token: state.request.token,
          write: true,
          snapshot,
          version: { currentVersion: "1.2.3", kind: "released" },
        },
        cycleTransport(state.f),
      ),
      /baseline or version is not the latest verified release/u,
    );
    assertReadOnly(state.f.calls, before);
    const next = await reconcileReleaseProposal(
      {
        configuration: state.request.configuration,
        automation: state.request.automation,
        token: state.request.token,
        write: true,
        snapshot,
        version: { currentVersion: "1.3.0", kind: "released" },
      },
      cycleTransport(state.f),
    );
    assert.equal(next.outcome, "created");
    assert.equal(next.pullNumber, 2);
    assert.ok(next.headSha);
    const parents = state.f.git(["show", "-s", "--format=%P", next.headSha]).trim().split(" ");
    assert.equal(parents[1], priorHead);
    assert.equal(state.f.ref("heads/release-log/main"), next.headSha);
    const changelog = state.f.git(["show", `${next.headSha}:CHANGELOG.md`]);
    assert.match(changelog, /1\.3\.0/u);
    assert.match(changelog, /1\.3\.1/u);
    assert.match(changelog, /### Fixes/u);
    const repeated = await reconcileReleaseProposal(
      {
        configuration: state.request.configuration,
        automation: state.request.automation,
        token: state.request.token,
        write: true,
        snapshot: await state.f.snapshot("v1.3.0"),
        version: { kind: "released", currentVersion: "1.3.0" },
      },
      cycleTransport(state.f),
    );
    assert.equal(repeated.outcome, "unchanged");
    assert.equal(repeated.headSha, next.headSha);
    const capture = {
      repository: state.f.directory,
      configuration: state.request.configuration,
      policy: { schemaVersion: 1 as const, botUserId: 42, approverUserIds: [7] },
      target: {
        schemaVersion: 1 as const,
        pullNumber: next.pullNumber,
        headSha: next.headSha,
        approverUserId: 7,
      },
      token: state.request.token,
    };
    const review = await captureReleaseReview(capture, cycleTransport(state.f));
    const tree = state.f.git(["rev-parse", `${next.headSha}^{tree}`]).trim();
    const landing = state.f
      .git(["commit-tree", tree, "-p", next.sourceSha, "-p", next.headSha], "Merge release\n")
      .trim();
    state.f.git(["update-ref", "refs/heads/main", landing, next.sourceSha]);
    const nextPull = state.f.pulls[1];
    assert.ok(nextPull);
    Object.assign(nextPull, {
      state: "closed",
      merged_at: "2026-11-14T12:00:00Z",
      merge_commit_sha: landing,
      merged_by: { id: 7, type: "User" },
    });
    const attestation = {
      ...capture.target,
      repositoryId: 17,
      landingSha: landing,
      mergeKind: "merge" as const,
    };
    const approval = await finalizeReleaseApproval(
      { ...capture, review, attestation },
      cycleTransport(state.f),
    );
    await verifyReleaseApproval({ ...capture, approval }, cycleTransport(state.f));
  });
}

void test("a conflicting latest version tag is never replaced by an older baseline", async (context) => {
  const state = await mergedProposal(context);
  state.f.git(["tag", "v1.3.0", state.sourceSha]);
  const before = state.f.calls.length;

  await assert.rejects(
    selectReleaseCycle(state.request, cycleTransport(state.f)),
    /version tag already points to another commit/u,
  );
  assertReadOnly(state.f.calls, before);
});

for (const mode of ["node", "python", "both"] as const) {
  void test(`trusted adoption validates ${mode} manifests and rejects a moved tag`, async (context) => {
    const state = await mergedProposal(context, "merge", mode);
    const { f, request, landingSha, pull } = state;
    f.git(["read-tree", "--reset", "-u", "HEAD"]);
    const blob = f
      .git(["hash-object", "-w", "--stdin"], "# Changelog\n\n## v1.3.0 (2026-11-18)\n")
      .trim();
    f.git(["update-index", "--cacheinfo", "100644", blob, "CHANGELOG.md"]);
    f.git(["commit", "-m", "chore: finalize replacement release"]);
    const commitSha = f.git(["rev-parse", "HEAD"]).trim();
    f.git(["tag", "v1.3.0", commitSha]);
    const configuration = {
      ...request.configuration,
      adoptedRelease: {
        pullNumber: 1,
        headSha: text(object(pull.head).sha),
        landingSha,
        commitSha,
        tag: "v1.3.0",
      },
    };
    const selected = await selectReleaseCycle(
      { ...request, configuration, sourceSha: commitSha },
      cycleTransport(f),
    );
    assert.equal(selected.outcome, "selected");
    assert.ok(selected.baseline.kind === "tag" && selected.baseline.adopted);
    assert.equal(selected.baseline.commitSha, commitSha);
    await assert.rejects(
      selectReleaseCycle(
        {
          ...request,
          configuration: {
            ...configuration,
            adoptedRelease: { ...configuration.adoptedRelease, headSha: landingSha },
          },
          sourceSha: commitSha,
        },
        cycleTransport(f),
      ),
      /does not match merged history/u,
    );
    f.git(["read-tree", "--reset", "-u", "HEAD"]);
    await f.advance("fix(api): preserve later changes");
    const sourceSha = f.ref("heads/main");
    assert.ok(sourceSha);
    const proposal = await reconcileReleaseProposal(
      {
        ...request,
        configuration,
        snapshot: await f.snapshot("v1.3.0", configuration),
        version: { kind: "released", currentVersion: "1.3.0" },
        write: true,
      },
      cycleTransport(f),
    );
    assert.equal(proposal.outcome, "created");
    assert.equal(proposal.baselineSha, commitSha);
    f.git(["tag", "-f", "v1.3.0", landingSha]);
    await assert.rejects(
      selectReleaseCycle({ ...request, configuration, sourceSha }, cycleTransport(f)),
      /points to a different commit/u,
    );
  });
}
