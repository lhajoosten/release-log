import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  GitInspectionError,
  inspectCommit,
  inspectGitTree,
  inspectPendingRelease,
  readGitBlob,
} from "../src/git.ts";
import { GitHubProposalRepository } from "../src/github-proposals.ts";
import { capturedIdentity, describe } from "../src/proposal-identity.ts";
import { prepareReleaseFileContents } from "../src/proposal-files.ts";
import { replayReleaseSnapshot } from "../src/release-snapshot.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import {
  parseReleaseApproval,
  parseReleaseApprovalJSON,
  parseReleaseApprovalPolicy,
  verifyReleaseApproval,
  auditReleaseExclusion,
  ReleaseApprovalError,
} from "../src/release-approval.ts";
import type { ReleaseApproval } from "../src/release-approval.ts";
import { fixture, botId, json, object, text } from "./proposal-fixture.ts";

const policy = { schemaVersion: 1 as const, botUserId: botId, approverUserIds: [7] };
async function approved(
  context: TestContext,
  mergeKind: "merge" | "squash" = "merge",
  mode: "node" | "python" | "both" = "node",
  refresh = false,
  options: {
    bootstrap?: boolean;
    adoption?: boolean;
    bootstrapCommit?: boolean;
    objectFormat?: "sha1" | "sha256";
  } = {},
) {
  const f = await fixture(
    context,
    mode,
    options.adoption ? "Initialize the application" : "feat(api): export rows",
    options,
  );
  const request = await f.request(true);
  let result = await reconcileReleaseProposal(request, f.transport);
  if (refresh) {
    await f.advance("fix(api): retain later rows");
    result = await reconcileReleaseProposal(await f.request(true), f.transport);
  }
  assert.ok(result.headSha && result.proposalId && result.pullNumber);
  const head = result.headSha;
  const source = result.sourceSha;
  const tree = f.git(["rev-parse", `${head}^{tree}`]).trim();
  const message =
    mergeKind === "merge"
      ? "Merge pull request #1 from release-log/main\n"
      : `chore: prepare v${options.bootstrap ? "0.1.0" : "1.3.0"}\n`;
  const landing = f
    .git(
      ["commit-tree", tree, "-p", source, ...(mergeKind === "merge" ? ["-p", head] : [])],
      message,
    )
    .trim();
  f.git(["update-ref", "refs/heads/main", landing, source]);
  const pull = f.pulls[0];
  assert.ok(pull);
  Object.assign(pull, {
    state: "closed",
    merged_at: "2026-11-08T14:00:00Z",
    merge_commit_sha: landing,
    merged_by: { id: 7, type: "User" },
  });
  const approval: ReleaseApproval = {
    schemaVersion: 1,
    repositoryId: 17,
    pullNumber: result.pullNumber,
    approverUserId: 7,
    sourceSha: source,
    headSha: head,
    landingSha: landing,
    mergeKind,
    baseline: options.bootstrap
      ? { kind: "bootstrap", commitSha: f.baseline }
      : { kind: "tag", name: "v1.2.3", objectSha: f.baseline, commitSha: f.baseline },
    snapshotId: result.snapshotId,
    proposalId: result.proposalId,
  };
  return {
    f,
    pull,
    head,
    source,
    tree,
    landing,
    approval,
    request: {
      repository: f.directory,
      configuration: request.configuration,
      policy,
      approval,
      token: "synthetic-read-only-secret",
    },
  };
}

for (const mergeKind of ["merge", "squash"] as const)
  for (const mode of ["node", "python", "both"] as const) {
    void test(`${mergeKind}/${mode}: verify the exact approved landing without reading or writing working-tree content`, async (context) => {
      const state = await approved(context, mergeKind, mode);
      const before = state.f.git(["status", "--porcelain"]);
      const calls = state.f.calls.length;
      const verified = await verifyReleaseApproval(state.request, state.f.transport);
      assert.equal(verified.landingSha, state.landing);
      assert.equal(verified.headSha, state.head);
      assert.equal(verified.sourceSha, state.source);
      assert.equal(verified.version, "1.3.0");
      assert.equal(verified.snapshotId, state.approval.snapshotId);
      assert.equal(verified.proposalId, state.approval.proposalId);
      assert.equal(verified.approverUserId, 7);
      assert.match(verified.verificationId, /^[a-f0-9]{64}$/u);
      assert.ok(verified.files.some((file) => file.path === "CHANGELOG.md"));
      assert.equal(state.f.git(["status", "--porcelain"]), before);
      assert.ok(state.f.calls.slice(calls).every(({ method }) => method === "GET"));
      assert.deepEqual(await verifyReleaseApproval(state.request, state.f.transport), verified);
    });
  }

for (const mergeKind of ["merge", "squash"] as const) {
  void test(`${mergeKind}: bootstrap approval verifies the explicit baseline and initial 0.1.0`, async (context) => {
    const state = await approved(context, mergeKind, "both", false, { bootstrap: true });
    const verified = await verifyReleaseApproval(state.request, state.f.transport);
    assert.equal(verified.version, "0.1.0");
    assert.deepEqual(verified.baseline, { kind: "bootstrap", commitSha: state.f.baseline });
    assert.equal(verified.landingSha, state.landing);
  });

  void test(`${mergeKind}: refreshed bootstrap proposals and approval retain commit-only history`, async (context) => {
    const state = await approved(context, mergeKind, "both", true, {
      bootstrap: true,
      bootstrapCommit: true,
    });

    const verified = await verifyReleaseApproval(state.request, state.f.transport);

    assert.equal(verified.version, "0.1.0");
    assert.equal(verified.landingSha, state.landing);

    const snapshot: unknown = JSON.parse(
      state.f.git(["show", `${state.head}:.release-log/inputs.json`]),
    );
    const normalized = object(object(snapshot).normalized);

    assert.ok(Array.isArray(normalized.bootstrapCommits));
    assert.equal(normalized.bootstrapCommits.length, 1);
    assert.ok(
      state.f
        .git(["show", `${state.head}:CHANGELOG.md`])
        .includes("[bootstrap commit]: retain historical commit evidence"),
    );
  });

  void test(`${mergeKind}: initial adoption preserves its pinned legacy cutoff through refresh and exact-landing approval`, async (context) => {
    const state = await approved(context, mergeKind, "both", true, {
      bootstrap: true,
      adoption: true,
      bootstrapCommit: true,
    });
    const verified = await verifyReleaseApproval(state.request, state.f.transport);

    assert.equal(verified.version, "0.1.0");
    assert.equal(verified.landingSha, state.landing);
    assert.ok(state.f.git(["show", `${state.head}:CHANGELOG.md`]).includes("Historical changes"));
    assert.ok(
      state.f
        .git(["show", `${state.head}:CHANGELOG.md`])
        .includes("Create the initial application"),
    );

    const configuration = state.request.configuration;

    assert.equal(configuration.schemaVersion, 2);

    if (configuration.schemaVersion !== 2)
      throw new Error("Expected pinned initial-adoption configuration");

    await assert.rejects(
      verifyReleaseApproval(
        {
          ...state.request,
          configuration: {
            ...configuration,
            bootstrap: { ...configuration.bootstrap, onboardingSha: state.source },
          },
        },
        state.f.transport,
      ),
      /configuration differs/u,
    );
  });

  void test(`${mergeKind}: SHA-256 object repositories preserve full immutable IDs`, async (context) => {
    const state = await approved(context, mergeKind, "both", true, { objectFormat: "sha256" });
    const verified = await verifyReleaseApproval(state.request, state.f.transport);
    assert.equal(verified.headSha.length, 64);
    assert.equal(verified.landingSha.length, 64);
    assert.equal(verified.version, "1.3.0");
    assert.equal(verified.landingSha, state.landing);
  });
  void test(`${mergeKind}: a refreshed proposal retains its prior head without releasing stale outputs`, async (context) => {
    const state = await approved(context, mergeKind, "both", true);
    const head = await inspectCommit(state.f.directory, state.head);
    assert.equal(head.parentShas.length, 2);
    assert.equal(head.parentShas[0], state.source);
    assert.ok(head.parentShas[1] && head.parentShas[1] !== state.source);
    const verified = await verifyReleaseApproval(state.request, state.f.transport);
    assert.equal(verified.sourceSha, state.source);
    assert.equal(verified.version, "1.3.0");
    assert.equal(verified.landingSha, state.landing);
  });
}

void test("later ordinary main commits do not change the approved version, files or publication target", async (context) => {
  const state = await approved(context);
  const initial = await verifyReleaseApproval(state.request, state.f.transport);
  const futureTree = state.f.createTree(state.tree, [
    { path: "future.txt", mode: "100644", content: "not part of this release\n" },
  ]);
  const later = state.f
    .git(["commit-tree", futureTree, "-p", state.landing], "feat: add a later ordinary change\n")
    .trim();
  state.f.git(["update-ref", "refs/heads/main", later, state.landing]);
  assert.deepEqual(await verifyReleaseApproval(state.request, state.f.transport), initial);
  assert.equal(initial.landingSha, state.landing);
  assert.notEqual(initial.landingSha, later);
});

void test("ordinary changes merged before the release make the approved source stale", async (context) => {
  const state = await approved(context);
  const laterTree = state.f.createTree(
    state.f.git(["rev-parse", `${state.source}^{tree}`]).trim(),
    [{ path: "concurrent.txt", mode: "100644", content: "new main change\n" }],
  );
  const concurrent = state.f
    .git(["commit-tree", laterTree, "-p", state.source], "fix: merge another ordinary PR\n")
    .trim();
  const stale = state.f
    .git(
      ["commit-tree", state.tree, "-p", concurrent, "-p", state.head],
      "Merge stale release proposal\n",
    )
    .trim();
  state.f.git(["update-ref", "refs/heads/main", stale, state.landing]);
  state.pull.merge_commit_sha = stale;
  await assert.rejects(
    verifyReleaseApproval(
      { ...state.request, approval: { ...state.approval, landingSha: stale } },
      state.f.transport,
    ),
    (error: unknown) => error instanceof ReleaseApprovalError && error.code === "stale-source",
  );
});

void test("human conflict resolution changing the landing tree cannot publish the reviewed snapshot", async (context) => {
  const state = await approved(context);
  const changedTree = state.f.createTree(state.tree, [
    { path: "CHANGELOG.md", mode: "100644", content: "unreviewed resolved output\n" },
  ]);
  const changed = state.f
    .git(
      ["commit-tree", changedTree, "-p", state.source, "-p", state.head],
      "Merge release with unreviewed resolution\n",
    )
    .trim();
  state.f.git(["update-ref", "refs/heads/main", changed, state.landing]);
  state.pull.merge_commit_sha = changed;
  await assert.rejects(
    verifyReleaseApproval(
      { ...state.request, approval: { ...state.approval, landingSha: changed } },
      state.f.transport,
    ),
    (error: unknown) => error instanceof ReleaseApprovalError && error.code === "content-mismatch",
  );
});

for (const field of ["headSha", "sourceSha", "snapshotId", "proposalId"] as const) {
  void test(`a forged ${field} in approval data fails instead of trusting a stored success flag`, async (context) => {
    const state = await approved(context);
    const value = field.endsWith("Id") ? "0".repeat(64) : "a".repeat(40);
    await assert.rejects(
      verifyReleaseApproval(
        { ...state.request, approval: { ...state.approval, [field]: value } },
        state.f.transport,
      ),
    );
  });
}

void test("unexpected repository, bot or human approval identities fail closed", async (context) => {
  const state = await approved(context);
  await assert.rejects(
    verifyReleaseApproval(
      { ...state.request, approval: { ...state.approval, repositoryId: 99 } },
      state.f.transport,
    ),
    /repository or human approver/u,
  );
  await assert.rejects(
    verifyReleaseApproval(
      { ...state.request, policy: { ...policy, approverUserIds: [9] } },
      state.f.transport,
    ),
    /repository or human approver/u,
  );
  state.pull.user = { id: 99, type: "Bot" };
  await assert.rejects(verifyReleaseApproval(state.request, state.f.transport), /identity/u);
  state.pull.user = { id: botId, type: "Bot" };
  state.pull.merged_by = { id: botId, type: "Bot" };
  await assert.rejects(verifyReleaseApproval(state.request, state.f.transport), /human merger/u);
  state.pull.merged_by = { id: 9, type: "User" };
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    /allowed human merger/u,
  );
});

void test("an unmerged PR or a mismatch between GitHub and the recorded landing is not approval", async (context) => {
  const state = await approved(context);
  state.pull.state = "open";
  state.pull.merged_at = null;
  await assert.rejects(verifyReleaseApproval(state.request, state.f.transport), /exact merged PR/u);
  state.pull.state = "closed";
  state.pull.merged_at = "2026-11-08T14:00:00Z";
  state.pull.merge_commit_sha = state.source;
  await assert.rejects(verifyReleaseApproval(state.request, state.f.transport), /exact merged PR/u);
});

void test("moved baseline tags invalidate approval despite older successful checks", async (context) => {
  const state = await approved(context);
  state.f.git(["tag", "-f", "v1.2.3", state.source]);
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    (error: unknown) => error instanceof ReleaseApprovalError && error.code === "baseline-mismatch",
  );
});

void test("a baseline change during the final recheck invalidates approval", async (context) => {
  const state = await approved(context);
  let reads = 0;
  state.f.intercept((method, path) => {
    if (method === "GET" && path === "/git/ref/tags/v1.2.3" && ++reads === 2)
      state.f.git(["tag", "-f", "v1.2.3", state.source]);
    return null;
  });
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    (error: unknown) => error instanceof ReleaseApprovalError && error.code === "baseline-mismatch",
  );
});

void test("a release branch rewind during verification cannot reuse the initially valid ancestry", async (context) => {
  const state = await approved(context);
  let reads = 0;
  state.f.intercept((method, path) => {
    if (method === "GET" && path === "/git/ref/heads/main" && ++reads === 2)
      state.f.git(["update-ref", "refs/heads/main", state.source, state.landing]);
    return null;
  });
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    /rewound or diverged/u,
  );
});

void test("local blob inspection rejects binary and oversized approval inputs", async (context) => {
  const state = await approved(context);
  await writeFile(join(state.f.directory, "invalid-utf8.bin"), Buffer.from([0xff, 0xfe]));
  const binary = state.f.git(["hash-object", "-w", "invalid-utf8.bin"]).trim();
  await assert.rejects(readGitBlob(state.f.directory, binary), /hash-matching UTF-8/u);
  const oversized = state.f
    .git(["hash-object", "-w", "--stdin"], "a".repeat(2 * 1024 * 1024 + 1))
    .trim();
  await assert.rejects(readGitBlob(state.f.directory, oversized), /2 MiB/u);
});

void test("wrong local baseline resolution and incomplete history cannot yield partial verification", async (context) => {
  const state = await approved(context);
  state.f.intercept((method, path) =>
    method === "GET" && path === "/git/ref/tags/v1.2.3"
      ? json({ ref: "refs/tags/v1.2.3", object: { sha: state.f.baseline } })
      : null,
  );
  state.f.git(["tag", "-f", "v1.2.3", state.source]);
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    /resolved baseline/u,
  );
  state.f.git(["tag", "-f", "v1.2.3", state.f.baseline]);
  await writeFile(join(state.f.directory, ".git", "shallow"), state.f.baseline + "\n");
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    (error: unknown) => error instanceof GitInspectionError && error.code === "shallow-history",
  );
});

void test("post-merge PR body changes are rejected even if the reviewed Git head is unchanged", async (context) => {
  const state = await approved(context);
  state.pull.body = text(state.pull.body) + "Unreviewed body edit.\n";
  await assert.rejects(verifyReleaseApproval(state.request, state.f.transport), /PR metadata/u);
});

void test("changed PR metadata during verification invalidates the result", async (context) => {
  const state = await approved(context);
  let reads = 0;
  state.f.intercept((method, path) => {
    if (method === "GET" && path === "/pulls/1" && ++reads === 2)
      state.pull.body = text(state.pull.body) + "Concurrent edit.\n";
    return null;
  });
  await assert.rejects(
    verifyReleaseApproval(state.request, state.f.transport),
    /changed during verification/u,
  );
});

for (const subject of [
  "chore(release): prepare v1.3.0",
  "feat: prepare v1.3.0",
  "chore!: prepare v1.3.0",
]) {
  void test(`squash subject ${subject} cannot substitute for the approved unscoped release subject`, async (context) => {
    const state = await approved(context, "squash");
    const changed = state.f
      .git(["commit-tree", state.tree, "-p", state.source], subject + "\n")
      .trim();
    state.f.git(["update-ref", "refs/heads/main", changed, state.landing]);
    state.pull.merge_commit_sha = changed;
    await assert.rejects(
      verifyReleaseApproval(
        { ...state.request, approval: { ...state.approval, landingSha: changed } },
        state.f.transport,
      ),
      /unscoped conventional subject/u,
    );
  });
}

void test("checked-out manifest/prose edits and dirty worktrees are not executed or used as approved input", async (context) => {
  const state = await approved(context, "merge", "both");
  const poisoned = '{"version":"9.9.9","scripts":{"prepare":"do not execute"}}\n';
  await writeFile(join(state.f.directory, "package.json"), poisoned);
  await writeFile(join(state.f.directory, "CHANGELOG.md"), "not the approved changelog\n");
  const before = state.f.git(["status", "--porcelain"]);
  const verified = await verifyReleaseApproval(state.request, state.f.transport);
  assert.equal(verified.version, "1.3.0");
  assert.equal(await readFile(join(state.f.directory, "package.json"), "utf8"), poisoned);
  assert.equal(state.f.git(["status", "--porcelain"]), before);
});

void test("local immutable tree/blob helpers read captured bytes and reject other object types", async (context) => {
  const state = await approved(context);
  const tree = await inspectGitTree(state.f.directory, state.head);
  assert.equal(tree.treeSha, state.tree);
  const entry = tree.entries.get("package.json");
  assert.ok(entry);
  assert.equal(
    await readGitBlob(state.f.directory, entry.sha),
    state.f.git(["show", `${state.head}:package.json`]),
  );
  await assert.rejects(readGitBlob(state.f.directory, state.head), /Expected a Git blob/u);
  const commit = await inspectCommit(state.f.directory, state.head);
  assert.equal(commit.parentShas[0], state.source);
});

for (const mergeKind of ["merge", "squash"] as const)
  for (const adoption of [false, true]) {
    void test(`${mergeKind}/${adoption ? "adoption" : "released"}: audit excludes only verified generated history and retains ordinary changes even on owned paths`, async (context) => {
      const state = await approved(
        context,
        mergeKind,
        "both",
        true,
        adoption ? { bootstrap: true, adoption: true, bootstrapCommit: true } : {},
      );
      const head = await inspectCommit(state.f.directory, state.head);
      const previous = capturedIdentity(head.message).previousHeadSha;

      assert.ok(previous);

      const laterTree = state.f.createTree(state.tree, [
        { path: "CHANGELOG.md", mode: "100644", content: "An ordinary human changelog edit\n" },
      ]);
      const later = state.f
        .git(["commit-tree", laterTree, "-p", state.landing], "docs: explain a later change\n")
        .trim();

      state.f.git(["update-ref", "refs/heads/main", later, state.landing]);

      const range = await inspectPendingRelease(state.f.directory, state.approval.baseline, later);
      const calls = state.f.calls.length;
      const before = state.f.git(["status", "--porcelain"]);
      const audit = await auditReleaseExclusion({ ...state.request, range }, state.f.transport);
      const original = await inspectPendingRelease(
        state.f.directory,
        state.approval.baseline,
        state.source,
      );

      assert.deepEqual(
        audit.excludedCommitShas,
        (mergeKind === "merge"
          ? [previous, state.head, state.landing]
          : [state.landing]
        ).toSorted(),
      );
      assert.deepEqual(audit.retainedCommitShas, [...original.commitShas, later].toSorted());
      assert.deepEqual(
        [...audit.excludedCommitShas, ...audit.retainedCommitShas].toSorted(),
        range.commitShas,
      );
      assert.equal(audit.landingSha, state.landing);
      assert.match(audit.auditId, /^[a-f0-9]{64}$/u);
      assert.deepEqual(
        await auditReleaseExclusion({ ...state.request, range }, state.f.transport),
        audit,
      );
      assert.equal(state.f.git(["status", "--porcelain"]), before);
      assert.ok(state.f.calls.slice(calls).every(({ method }) => method === "GET"));

      const tag = adoption ? "v0.1.0" : "v1.3.0";

      state.f.git(["tag", tag, state.landing]);

      const nextRange = await inspectPendingRelease(
        state.f.directory,
        { kind: "tag", name: tag },
        later,
      );
      const next = await auditReleaseExclusion(
        { ...state.request, range: nextRange },
        state.f.transport,
      );

      assert.deepEqual(next.excludedCommitShas, []);
      assert.deepEqual(next.retainedCommitShas, [later]);
    });
  }

void test("an exclusion audit rejects forged membership, a partial release footprint and a source before the landing", async (context) => {
  const state = await approved(context);
  const range = await inspectPendingRelease(
    state.f.directory,
    state.approval.baseline,
    state.landing,
  );
  const calls = state.f.calls.length;

  await assert.rejects(
    auditReleaseExclusion(
      { ...state.request, range: { ...range, commitShas: range.commitShas.slice(1) } },
      state.f.transport,
    ),
    /actual immutable Git membership/u,
  );

  assert.equal(state.f.calls.length, calls);

  const earlier = await inspectPendingRelease(
    state.f.directory,
    state.approval.baseline,
    state.source,
  );

  await assert.rejects(
    auditReleaseExclusion({ ...state.request, range: earlier }, state.f.transport),
    /ancestor/u,
  );

  const partial = await inspectPendingRelease(
    state.f.directory,
    { kind: "bootstrap", commitSha: state.head },
    state.landing,
  );

  await assert.rejects(
    auditReleaseExclusion({ ...state.request, range: partial }, state.f.transport),
    /crosses a verified release footprint/u,
  );
});

async function graftProposalParent(
  state: Awaited<ReturnType<typeof approved>>,
  previousHeadSha: string,
) {
  const snapshotJSON = state.f.git(["show", `${state.head}:.release-log/inputs.json`]);
  const snapshot = await replayReleaseSnapshot(snapshotJSON, state.request.configuration);
  const api = new GitHubProposalRepository(
    state.request.configuration,
    botId,
    "synthetic-read-token",
    state.f.transport,
  );
  const source = await api.tree(state.source);
  const prepared = await prepareReleaseFileContents(
    snapshotJSON,
    state.request.configuration,
    capturedIdentity((await inspectCommit(state.f.directory, state.head)).message).version,
    await api.contents(source),
  );
  const description = describe(snapshot, prepared, botId, previousHeadSha);
  const head = state.f
    .git(
      ["commit-tree", state.tree, "-p", state.source, "-p", previousHeadSha],
      description.message,
    )
    .trim();
  const landing = state.f
    .git(
      ["commit-tree", state.tree, "-p", state.source, "-p", head],
      "Merge the reviewed release\n",
    )
    .trim();

  state.f.git(["update-ref", "refs/heads/release-log/main", head, state.head]);
  state.f.git(["update-ref", "refs/heads/main", landing, state.landing]);
  state.pull.body = description.body;
  state.pull.title = description.title;
  state.pull.merge_commit_sha = landing;

  return {
    ...state.request,
    approval: { ...state.approval, headSha: head, landingSha: landing, proposalId: description.id },
  };
}

for (const tampering of ["ordinary-parent", "generated-output", "unrelated-file"] as const) {
  void test(`a valid final proposal cannot hide ${tampering} in its prior-head ancestry`, async (context) => {
    const state = await approved(context, "merge", "both", true);
    const previousSha = capturedIdentity(
      (await inspectCommit(state.f.directory, state.head)).message,
    ).previousHeadSha;

    assert.ok(previousSha);

    const previous = await inspectCommit(state.f.directory, previousSha);
    const tree = state.f.createTree(state.f.git(["rev-parse", `${previousSha}^{tree}`]).trim(), [
      {
        path: tampering === "generated-output" ? "CHANGELOG.md" : "ordinary-source.txt",
        mode: "100644",
        content: "A real source edit that must not disappear\n",
      },
    ]);
    const grafted = state.f
      .git(
        ["commit-tree", tree, ...previous.parentShas.flatMap((parent) => ["-p", parent])],
        tampering === "ordinary-parent"
          ? "feat: add an ordinary source change\n"
          : previous.message,
      )
      .trim();
    const request = await graftProposalParent(state, grafted);

    // The newest head, generated outputs, marker and trusted record are all consistent.
    // Rejection must come from inspecting the prior commit rather than its final tree.
    await assert.rejects(
      verifyReleaseApproval(request, state.f.transport),
      tampering === "ordinary-parent"
        ? /supported generated proposal commit/u
        : /edited generated outputs|unrelated file/u,
    );

    const range = await inspectPendingRelease(
      state.f.directory,
      state.approval.baseline,
      request.approval.landingSha,
    );

    await assert.rejects(auditReleaseExclusion({ ...request, range }, state.f.transport));
  });
}

void test("proposal ancestry beyond the bounded audit limit cannot be silently excluded", async (context) => {
  const state = await approved(context);
  let previous = state.source;

  for (let index = 0; index < 100; index++)
    previous = state.f
      .git(
        ["commit-tree", state.tree, "-p", previous],
        `chore: retain historical evidence ${index}\n`,
      )
      .trim();

  const request = await graftProposalParent(state, previous);

  await assert.rejects(
    verifyReleaseApproval(request, state.f.transport),
    (error: unknown) => error instanceof ReleaseApprovalError && error.code === "resource-limit",
  );
});

void test("approval schemas reject missing/unknown fields, self-approval, malformed IDs and unsupported merge strategies", async (context) => {
  const state = await approved(context);
  for (const policyValue of [
    null,
    {},
    { ...policy, schemaVersion: 2 },
    { ...policy, approverUserIds: [] },
    { ...policy, approverUserIds: [botId] },
    { ...policy, approverUserIds: [7, 7] },
    { ...policy, approverUserIds: [0] },
    { ...policy, token: "synthetic-secret" },
  ])
    assert.throws(() => parseReleaseApprovalPolicy(policyValue), ReleaseApprovalError);
  for (const value of [
    null,
    {},
    { ...state.approval, schemaVersion: 2 },
    { ...state.approval, mergeKind: "rebase" },
    { ...state.approval, mergeKind: "guess" },
    { ...state.approval, sourceSha: "main" },
    { ...state.approval, snapshotId: "invalid" },
    { ...state.approval, valid: true },
  ])
    assert.throws(() => parseReleaseApproval(value), ReleaseApprovalError);
  assert.deepEqual(
    parseReleaseApprovalPolicy({ ...policy, approverUserIds: [9, 7] }).approverUserIds,
    [7, 9],
  );
  assert.deepEqual(
    parseReleaseApproval(parseReleaseApprovalJSON(JSON.stringify(state.approval))),
    state.approval,
  );
  for (const serialized of [
    '{"headSha":"a","headSha":"b"}',
    '{"headSha":"a","\\u0068eadSha":"b"}',
    "{private malformed content",
    "x".repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => parseReleaseApprovalJSON(serialized), ReleaseApprovalError);
  assert.ok(!JSON.stringify(object(state.approval)).includes("synthetic-read-only-secret"));
});
