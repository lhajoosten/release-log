import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { renderChangelog } from "../src/changelog.ts";
import { inspectCommit, inspectPendingRelease } from "../src/git.ts";
import { collectMergedPullRequests } from "../src/github-association.ts";
import type { GitHubRead } from "../src/github.ts";
import {
  parseReleaseExclusionAuthorities,
  parseVerifiedReleaseApproval,
  verifyReleaseApproval,
} from "../src/release-approval.ts";
import type { ReleaseApproval } from "../src/release-approval.ts";
import { createReleasePlan } from "../src/release-plan.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { botId, fixture, json } from "./proposal-fixture.ts";

const policy = { schemaVersion: 1 as const, botUserId: botId, approverUserIds: [7] };

async function released(
  context: TestContext,
  mergeKind: "merge" | "squash" = "merge",
  objectFormat: "sha1" | "sha256" = "sha1",
  refresh = false,
) {
  const f = await fixture(context, "both", "feat(api): export rows", { objectFormat });
  const initial = await f.request(true);
  async function captureSource(serialized: string) {
    const sourceSnapshot = await replayReleaseSnapshot(serialized, initial.configuration);

    return captureReleaseSnapshot(
      {
        ...sourceSnapshot.input,
        pullRequests: sourceSnapshot.input.pullRequests.map((pull) => ({
          ...pull,
          number: pull.number + 100,
          url: `https://github.com/example/project/pull/${pull.number + 100}`,
        })),
      },
      initial.configuration,
    );
  }

  let result = await reconcileReleaseProposal(
    { ...initial, snapshot: await serializeReleaseSnapshot(await captureSource(initial.snapshot)) },
    f.transport,
  );

  if (refresh) {
    await f.advance("fix(api): retain pre-release changes");

    const request = await f.request(true);

    result = await reconcileReleaseProposal(
      {
        ...request,
        snapshot: await serializeReleaseSnapshot(await captureSource(request.snapshot)),
      },
      f.transport,
    );
  }

  assert.ok(result.headSha && result.pullNumber && result.proposalId);

  const head = result.headSha;
  const source = result.sourceSha;
  const generated = await inspectPendingRelease(
    f.directory,
    { kind: "bootstrap", commitSha: source },
    head,
  );
  const tree = f.git(["rev-parse", `${head}^{tree}`]).trim();
  const landing = f
    .git(
      ["commit-tree", tree, "-p", source, ...(mergeKind === "merge" ? ["-p", head] : [])],
      mergeKind === "merge" ? "Merge the reviewed release\n" : "chore: prepare v1.3.0\n",
    )
    .trim();
  const pull = f.pulls[0];

  assert.ok(pull);

  f.git(["update-ref", "refs/heads/main", landing, source]);
  Object.assign(pull, {
    id: 9001,
    state: "closed",
    merged: true,
    merged_at: "2026-11-09T10:00:00Z",
    updated_at: "2026-11-09T10:00:00Z",
    merge_commit_sha: landing,
    merged_by: { id: 7, type: "User" },
    commits: generated.commitShas.length,
    base: { ref: "main", repo: { id: 17, full_name: "example/project" } },
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
    baseline: { kind: "tag", name: "v1.2.3", objectSha: f.baseline, commitSha: f.baseline },
    snapshotId: result.snapshotId,
    proposalId: result.proposalId,
  };
  const originalOrder = f
    .git(["rev-list", "--reverse", `${source}..${head}`])
    .trim()
    .split("\n");
  const originals = new Map<number, readonly string[]>([[result.pullNumber, originalOrder]]);
  const ordinary = new Map<number, Record<string, unknown>>();
  const owners = new Map<string, number>();

  async function ordinaryPull(index: number) {
    const change = f.changes[index];

    assert.ok(change);

    const number = index + 101;
    const metadata = {
      number,
      id: number + 1000,
      title: change.title,
      body: "```release-log\nversion: 1\naudience: internal\nsummary: Retain ordinary source changes.\nimpact: Keep ordinary changes in release membership.\nrequired_action: null\n```",
      state: "closed",
      merged: true,
      merged_at: "2026-11-09T10:00:00Z",
      updated_at: "2026-11-09T10:00:00Z",
      merge_commit_sha: change.sha,
      commits: 1,
      user: { id: 7, type: "User" },
      base: { ref: "main", repo: { id: 17, full_name: "example/project" } },
      head: { sha: change.sha, ref: `ordinary-${number}`, repo: { id: 23 } },
    };

    ordinary.set(number, metadata);
    originals.set(number, [change.sha]);
    owners.set(change.sha, number);
  }

  for (let index = 0; index < f.changes.length; index++) await ordinaryPull(index);

  for (const commit of mergeKind === "merge" ? [...generated.commitShas, landing] : [landing])
    owners.set(commit, result.pullNumber);

  const calls: { method: string; path: string }[] = [];
  const transport: GitHubRead = async (url, options) => {
    const path = new URL(url).pathname.slice("/repos/example/project".length);

    calls.push({ method: options.method ?? "GET", path });

    const commit = /^\/commits\/([a-f0-9]+)\/pulls$/u.exec(path)?.[1];

    if (commit) {
      const owner = owners.get(commit);

      return json(
        owner === undefined ? [] : [owner === result.pullNumber ? pull : ordinary.get(owner)],
      );
    }

    const original = /^\/pulls\/(\d+)\/commits$/u.exec(path)?.[1];

    if (original) {
      const commits = originals.get(Number(original));

      assert.ok(commits);

      return json(
        await Promise.all(
          commits.map(async (sha) => {
            const evidence = await inspectCommit(f.directory, sha);

            return {
              sha,
              commit: { message: evidence.message },
              parents: evidence.parentShas.map((parentSha) => ({ sha: parentSha })),
            };
          }),
        ),
      );
    }

    const number = /^\/pulls\/(\d+)$/u.exec(path)?.[1];

    if (number && ordinary.has(Number(number))) return json(ordinary.get(Number(number)));

    return f.transport(url, options);
  };
  const authority = { configuration: initial.configuration, policy, approval };
  const proof = await verifyReleaseApproval(
    { repository: f.directory, ...authority, token: "synthetic-read-token" },
    transport,
  );

  await f.advance("fix(api): retain a later ordinary change");
  await ordinaryPull(f.changes.length - 1);

  const latest = f.ref("heads/main");

  assert.ok(latest);

  const range = await inspectPendingRelease(f.directory, { kind: "tag", name: "v1.2.3" }, latest);
  const config = {
    ...initial.configuration,
    automationExclusions: [{ pullNumber: proof.pullNumber, verificationId: proof.verificationId }],
  };
  const request = {
    repository: "example/project",
    releaseBranch: "main",
    localRepository: f.directory,
    range,
    token: "synthetic-read-token",
    automation: [authority],
  };

  return {
    f,
    pull,
    head,
    landing,
    source,
    authority,
    proof,
    config,
    request,
    transport,
    calls,
    ordinary,
  };
}

for (const mergeKind of ["merge", "squash"] as const)
  for (const format of ["sha1", "sha256"] as const) {
    void test(`${mergeKind}/${format}: collection keeps the full graph while planning/replay exclude only freshly approved automation`, async (context) => {
      const state = await released(context, mergeKind, format);
      const before = state.f.git(["status", "--porcelain"]);
      const associated = await collectMergedPullRequests(state.request, state.transport);
      const snapshot = await captureReleaseSnapshot(associated, state.config);
      const serialized = await serializeReleaseSnapshot(snapshot);
      const plan = await createReleasePlan(serialized, state.config, {
        kind: "released",
        currentVersion: "1.2.3",
      });
      const changelog = await renderChangelog(serialized, state.config, {
        kind: "released",
        currentVersion: "1.2.3",
      });

      assert.equal(snapshot.schemaVersion, 4);
      assert.equal(plan.schemaVersion, 4);
      assert.equal(plan.nextVersion, "1.3.0");
      assert.deepEqual(snapshot.input.range.commitShas, state.request.range.commitShas);
      assert.deepEqual(
        snapshot.input.pullRequests.map((pull) => pull.number),
        [1, 101, 102],
      );
      assert.deepEqual(
        plan.contributions.map((pull) => pull.number),
        [101, 102],
      );
      assert.deepEqual(
        plan.excludedContributions?.map((pull) => pull.number),
        [1],
      );
      assert.deepEqual(
        snapshot.normalized.excludedPullRequests?.[0]?.commitShas,
        state.proof.automationCommitShas,
      );
      assert.equal((changelog?.match(/\(\[#/gu) ?? []).length, 2);
      assert.ok(!changelog?.includes("pull/1)"));
      assert.ok(changelog?.includes("pull/101"));
      assert.ok(changelog?.includes("pull/102"));
      assert.equal(state.f.git(["status", "--porcelain"]), before);
      assert.ok(state.calls.every(({ method }) => method === "GET"));

      const savedFetch = globalThis.fetch;

      try {
        globalThis.fetch = () => {
          throw new Error("Offline replay must never use the network");
        };

        assert.deepEqual(await replayReleaseSnapshot(serialized, state.config), snapshot);
        assert.deepEqual(
          await createReleasePlan(serialized, state.config, {
            kind: "released",
            currentVersion: "1.2.3",
          }),
          plan,
        );
      } finally {
        globalThis.fetch = savedFetch;
      }

      assert.deepEqual(
        parseVerifiedReleaseApproval(JSON.parse(JSON.stringify(state.proof))),
        state.proof,
      );
    });
  }

void test("pins alone never bypass fresh collection verification", async (context) => {
  const state = await released(context);

  const { automation, ...withoutAuthority } = state.request;

  assert.equal(automation.length, 1);

  await assert.rejects(
    collectMergedPullRequests(withoutAuthority, state.transport),
    /without independently trusted/u,
  );

  state.pull.body = String(state.pull.body) + "Unreviewed metadata edit\n";

  await assert.rejects(collectMergedPullRequests(state.request, state.transport), /PR metadata/u);
});

void test("a forged proof or changed trusted pin cannot authorize normalization", async (context) => {
  const state = await released(context);
  const associated = await collectMergedPullRequests(state.request, state.transport);
  const proof = associated.verifiedAutomation?.[0];

  assert.ok(proof);

  await assert.rejects(
    captureReleaseSnapshot(associated, {
      ...state.config,
      automationExclusions: [{ pullNumber: 1, verificationId: "0".repeat(64) }],
    }),
    /trusted configuration pins/u,
  );

  const changed = {
    ...proof,
    automationCommitShas: [...proof.automationCommitShas, state.source].toSorted(),
  };
  const { verificationId: ignored, ...payload } = changed;

  assert.ok(ignored);

  const forged = {
    ...payload,
    verificationId: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };

  await assert.rejects(
    captureReleaseSnapshot({ ...associated, verifiedAutomation: [forged] }, state.config),
    /trusted configuration pins/u,
  );
  await assert.rejects(
    captureReleaseSnapshot(
      { ...associated, verifiedAutomation: [{ ...proof, verificationId: "0".repeat(64) }] },
      state.config,
    ),
    /pinned digest/u,
  );
  await assert.rejects(
    captureReleaseSnapshot({ ...associated, verifiedAutomation: [] }, state.config),
    /trusted configuration pins/u,
  );
  await assert.rejects(
    captureReleaseSnapshot(associated, state.authority.configuration),
    /Unexpected or missing fields/u,
  );
});

void test("raw PR identity, body or footprint edits are rejected even with unchanged verification evidence", async (context) => {
  const state = await released(context);
  const associated = await collectMergedPullRequests(state.request, state.transport);

  for (const edit of [
    { authorId: 99 },
    { headRepositoryId: 23 },
    { body: "changed" },
    { headSha: state.source },
    { landedCommits: [] },
  ]) {
    await assert.rejects(
      captureReleaseSnapshot(
        {
          ...associated,
          pullRequests: associated.pullRequests.map((pull) =>
            pull.number === 1 ? { ...pull, ...edit } : pull,
          ),
        },
        state.config,
      ),
    );
  }
});

void test("a refreshed release excludes every generated prior head, not any ordinary source commits", async (context) => {
  const state = await released(context, "merge", "sha1", true);
  const associated = await collectMergedPullRequests(state.request, state.transport);
  const snapshot = await captureReleaseSnapshot(associated, state.config);
  const plan = await createReleasePlan(await serializeReleaseSnapshot(snapshot), state.config, {
    kind: "released",
    currentVersion: "1.2.3",
  });

  assert.equal(state.proof.automationCommitShas.length, 3);
  assert.deepEqual(
    plan.contributions.map((pull) => pull.number),
    [101, 102, 103],
  );
  assert.deepEqual(plan.excludedContributions?.[0]?.commitShas, state.proof.automationCommitShas);
});

void test("completed-release baseline ranges never reintroduce the automation PR or create a release-only loop", async (context) => {
  const state = await released(context);

  state.f.git(["tag", "v1.3.0", state.landing]);

  for (const source of [state.landing, state.request.range.sourceCommitSha]) {
    const range = await inspectPendingRelease(
      state.f.directory,
      { kind: "tag", name: "v1.3.0" },
      source,
    );
    const associated = await collectMergedPullRequests(
      { ...state.request, range },
      state.transport,
    );
    const snapshot = await captureReleaseSnapshot(associated, state.config);
    const serialized = await serializeReleaseSnapshot(snapshot);
    const plan = await createReleasePlan(serialized, state.config, {
      kind: "released",
      currentVersion: "1.3.0",
    });

    assert.deepEqual(plan.excludedContributions, []);
    assert.deepEqual(
      plan.contributions.map((pull) => pull.number),
      source === state.landing ? [] : [102],
    );
    assert.equal(plan.nextVersion, source === state.landing ? null : "1.3.1");
  }
});

void test("partial automation footprints fail before any raw graph is returned", async (context) => {
  const state = await released(context);
  const range = await inspectPendingRelease(
    state.f.directory,
    { kind: "bootstrap", commitSha: state.head },
    state.landing,
  );

  await assert.rejects(
    collectMergedPullRequests({ ...state.request, range }, state.transport),
    /crosses the captured range boundary/u,
  );
});

void test("automation metadata changing during the final fresh verification cannot yield mixed evidence", async (context) => {
  const state = await released(context);
  let reads = 0;

  state.f.intercept((method, path) => {
    if (method === "GET" && path === "/pulls/1" && ++reads === 5)
      state.pull.body = String(state.pull.body) + "Concurrent metadata edit\n";

    return null;
  });

  await assert.rejects(collectMergedPullRequests(state.request, state.transport), /PR metadata/u);
  assert.ok(reads >= 5);
});

void test("schema-4 CLI replay is offline and refuses a changed exclusion authority", async (context) => {
  const state = await released(context);
  const snapshot = await captureReleaseSnapshot(
    await collectMergedPullRequests(state.request, state.transport),
    state.config,
  );
  const directory = await mkdtemp(join(tmpdir(), "exclusion-cli-"));

  context.after(() => rm(directory, { recursive: true, force: true }));

  const configPath = join(directory, "config.json");
  const snapshotPath = join(directory, "snapshot.json");

  await writeFile(configPath, JSON.stringify(state.config));
  await writeFile(snapshotPath, await serializeReleaseSnapshot(snapshot));

  const args = [
    "--import",
    "data:text/javascript," +
      encodeURIComponent(
        'globalThis.fetch = () => { throw new Error("Unexpected network during replay"); };',
      ),
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "plan",
    "--config",
    configPath,
    "--snapshot",
    snapshotPath,
    "--current-version",
    "1.2.3",
  ];
  const execute = promisify(execFile);
  const result = await execute(process.execPath, args, {
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
  const plan: unknown = JSON.parse(result.stdout);

  assert.ok(typeof plan === "object" && plan !== null && "schemaVersion" in plan);
  assert.equal(plan.schemaVersion, 4);

  await writeFile(
    configPath,
    JSON.stringify({
      ...state.config,
      automationExclusions: [{ pullNumber: 1, verificationId: "0".repeat(64) }],
    }),
  );

  await assert.rejects(
    execute(process.execPath, args, { env: { PATH: process.env.PATH }, timeout: 10_000 }),
    (error: unknown) =>
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("configuration differs"),
  );
});

void test("malformed pins and authority envelopes are rejected rather than accepted as allowlists", () => {
  const base = {
    schemaVersion: 1,
    repository: "example/project",
    repositoryId: 17,
    releaseBranch: "main",
    releasePolicy: "release-policy-v1",
  };

  for (const pins of [
    [],
    null,
    [{ pullNumber: 1, verificationId: "main" }],
    [{ pullNumber: 1, verificationId: "a".repeat(64), verified: true }],
    [
      { pullNumber: 1, verificationId: "a".repeat(64) },
      { pullNumber: 1, verificationId: "b".repeat(64) },
    ],
  ])
    assert.throws(() => parseReleaseInputConfiguration({ ...base, automationExclusions: pins }));

  for (const input of [
    { schemaVersion: 1, approvals: [] },
    { schemaVersion: 1, approvals: [{ verified: true }] },
    { schemaVersion: 2, approvals: [] },
  ])
    assert.throws(() => parseReleaseExclusionAuthorities(input));
});
