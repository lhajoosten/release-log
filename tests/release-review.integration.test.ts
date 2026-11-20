import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { inspectCommit } from "../src/git.ts";
import {
  captureReleaseReview,
  finalizeReleaseApproval,
  parseReleaseMergeAttestation,
  parseReleaseReview,
  parseReleaseReviewTarget,
  verifyReleaseApproval,
} from "../src/release-approval.ts";
import type { ReleaseMergeAttestation } from "../src/release-approval.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { botId, fixture, json, object, text } from "./proposal-fixture.ts";
import { readinessFixture } from "./readiness-fixture.ts";

const policy = { schemaVersion: 1 as const, botUserId: botId, approverUserIds: [7] };

async function proposal(
  context: TestContext,
  adoption = false,
  objectFormat: "sha1" | "sha256" = "sha1",
) {
  const f = await fixture(
    context,
    "both",
    adoption ? "Initialize the old application" : "feat(api): export rows",
    {
      ...(adoption ? { bootstrap: true, adoption: true, bootstrapCommit: true } : {}),
      objectFormat,
    },
  );
  const request = await f.request(true);
  const result = await reconcileReleaseProposal(request, f.transport);

  assert.ok(result.headSha && result.pullNumber && result.proposalId);

  const target = {
    schemaVersion: 1 as const,
    pullNumber: result.pullNumber,
    headSha: result.headSha,
    approverUserId: 7,
  };
  const capture = {
    repository: f.directory,
    configuration: request.configuration,
    policy,
    target,
    token: "synthetic-read-token",
  };

  async function land(mergeKind: "merge" | "squash"): Promise<ReleaseMergeAttestation> {
    const head = f.ref("heads/release-log/main");
    const source = f.ref("heads/main");

    assert.ok(head && source);

    const tree = f.git(["rev-parse", `${head}^{tree}`]).trim();
    const landingSha = f
      .git(
        ["commit-tree", tree, "-p", source, ...(mergeKind === "merge" ? ["-p", head] : [])],
        mergeKind === "merge"
          ? "Merge the reviewed release\n"
          : `chore: prepare v${adoption ? "0.1.0" : "1.3.0"}\n`,
      )
      .trim();

    f.git(["update-ref", "refs/heads/main", landingSha, source]);

    const pull = f.pulls[0];

    assert.ok(pull);

    Object.assign(pull, {
      state: "closed",
      merged_at: "2026-11-08T20:00:00Z",
      merge_commit_sha: landingSha,
      merged_by: { id: 7, type: "User" },
    });

    return { ...target, headSha: head, repositoryId: 17, landingSha, mergeKind };
  }

  return { f, result, capture, land };
}

for (const mergeKind of ["merge", "squash"] as const) {
  void test(`${mergeKind}: strict review/check policy gates capture, finalization and later approval verification`, async (context) => {
    const state = await proposal(context);
    const gate = readinessFixture(
      state.capture.target.headSha,
      state.capture.target.pullNumber,
      state.f.transport,
    );
    const capture = { ...state.capture, policy: gate.policy };
    const legacy = await captureReleaseReview(state.capture, state.f.transport);
    const review = await captureReleaseReview(capture, gate.transport);

    assert.notEqual(review.policyId, legacy.policyId);
    assert.deepEqual(await captureReleaseReview(capture, gate.transport), review);

    const attestation = await state.land(mergeKind);
    const check = gate.checkRuns[0];

    assert.ok(check);
    check.conclusion = "failure";

    await assert.rejects(
      finalizeReleaseApproval({ ...capture, review, attestation }, gate.transport),
      /trusted App/u,
    );

    check.conclusion = "success";

    const approval = await finalizeReleaseApproval(
      { ...capture, review, attestation },
      gate.transport,
    );
    const verified = await verifyReleaseApproval({ ...capture, approval }, gate.transport);

    assert.equal(verified.policyId, review.policyId);
    await assert.rejects(
      finalizeReleaseApproval({ ...capture, review: legacy, attestation }, gate.transport),
      /policy changed/u,
    );

    const humanReview = gate.reviews[0];

    assert.ok(humanReview);
    humanReview.state = "DISMISSED";

    await assert.rejects(
      verifyReleaseApproval({ ...capture, approval }, gate.transport),
      /latest submitted APPROVED/u,
    );
  });
}

void test("strict capture rejects review/check changes during its observation window", async (context) => {
  const state = await proposal(context);
  const gate = readinessFixture(
    state.capture.target.headSha,
    state.capture.target.pullNumber,
    state.f.transport,
  );
  let reads = 0;

  gate.intercept((url) => {
    if (url.pathname.endsWith("/reviews") && ++reads === 2) {
      const review = gate.reviews[0];

      assert.ok(review);
      review.id = 101;
    }

    return null;
  });

  await assert.rejects(
    captureReleaseReview({ ...state.capture, policy: gate.policy }, gate.transport),
    /changed during verification/u,
  );
  assert.equal(reads, 2);
});

void test("strict capture rejects a newly successful workflow attempt during verification", async (context) => {
  const state = await proposal(context);
  const gate = readinessFixture(
    state.capture.target.headSha,
    state.capture.target.pullNumber,
    state.f.transport,
  );
  let runReads = 0;

  gate.intercept((url) => {
    if (url.pathname.endsWith("/runs") && ++runReads === 2) {
      const run = gate.runs[0];

      assert.ok(run);
      run.run_attempt = 3;
    }
    if (url.pathname.endsWith("/attempts/3/jobs"))
      return json({
        total_count: gate.jobs.length,
        jobs: gate.jobs.map((job) => ({ ...job, run_attempt: 3 })),
      });

    return null;
  });

  await assert.rejects(
    captureReleaseReview({ ...state.capture, policy: gate.policy }, gate.transport),
    /changed during verification/u,
  );
  assert.equal(runReads, 2);
});

for (const mergeKind of ["merge", "squash"] as const)
  for (const adoption of [false, true])
    for (const format of ["sha1", "sha256"] as const) {
      void test(`${mergeKind}/${adoption ? "adoption" : "released"}/${format}: capture before merge and finalize the exact reviewed landing with reads only`, async (context) => {
        const state = await proposal(context, adoption, format);
        const before = state.f.git(["status", "--porcelain"]);
        const calls = state.f.calls.length;

        const review = await captureReleaseReview(state.capture, state.f.transport);

        assert.equal(review.headSha, state.result.headSha);
        assert.equal(review.sourceSha, state.result.sourceSha);
        assert.equal(review.snapshotId, state.result.snapshotId);
        assert.equal(review.proposalId, state.result.proposalId);
        assert.equal(review.approverUserId, 7);
        assert.deepEqual(
          review.baseline,
          adoption
            ? { kind: "bootstrap", commitSha: state.f.baseline }
            : {
                kind: "tag",
                name: "v1.2.3",
                objectSha: state.f.baseline,
                commitSha: state.f.baseline,
              },
        );
        assert.equal(review.headSha.length, format === "sha1" ? 40 : 64);
        assert.match(review.configurationId, /^[a-f0-9]{64}$/u);
        assert.match(review.policyId, /^[a-f0-9]{64}$/u);
        assert.deepEqual(await captureReleaseReview(state.capture, state.f.transport), review);
        assert.equal(state.f.git(["status", "--porcelain"]), before);
        assert.ok(state.f.calls.slice(calls).every(({ method }) => method === "GET"));

        const attestation = await state.land(mergeKind);
        const finalize = { ...state.capture, review, attestation };
        const approval = await finalizeReleaseApproval(finalize, state.f.transport);
        const verified = await verifyReleaseApproval(
          { ...state.capture, approval },
          state.f.transport,
        );

        assert.equal(approval.headSha, review.headSha);
        assert.equal(approval.sourceSha, review.sourceSha);
        assert.equal(approval.landingSha, attestation.landingSha);
        assert.equal(approval.mergeKind, mergeKind);
        assert.equal(verified.version, adoption ? "0.1.0" : "1.3.0");
        assert.equal(verified.configurationId, review.configurationId);
        assert.equal(verified.policyId, review.policyId);
        assert.deepEqual(await finalizeReleaseApproval(finalize, state.f.transport), approval);
        assert.ok(state.f.calls.slice(calls).every(({ method }) => method === "GET"));
        assert.ok(!JSON.stringify({ review, approval }).includes("synthetic-read-token"));

        await assert.rejects(
          captureReleaseReview(state.capture, state.f.transport),
          /before merge/u,
        );
      });
    }

void test("a refreshed proposal must be reviewed at its new head, not the previously intended head", async (context) => {
  const state = await proposal(context, true);
  const original = await captureReleaseReview(state.capture, state.f.transport);

  await state.f.advance("fix(api): retain rows");

  const refreshed = await reconcileReleaseProposal(await state.f.request(true), state.f.transport);

  assert.ok(refreshed.headSha);

  await assert.rejects(
    captureReleaseReview(state.capture, state.f.transport),
    /intended open PR head/u,
  );

  const review = await captureReleaseReview(
    { ...state.capture, target: { ...state.capture.target, headSha: refreshed.headSha } },
    state.f.transport,
  );
  const attestation = await state.land("merge");

  assert.notEqual(review.headSha, original.headSha);
  assert.notEqual(review.proposalId, original.proposalId);
  assert.equal(review.sourceSha, refreshed.sourceSha);

  await assert.rejects(
    finalizeReleaseApproval({ ...state.capture, review: original, attestation }, state.f.transport),
    /stored review/u,
  );

  const approval = await finalizeReleaseApproval(
    { ...state.capture, review, attestation },
    state.f.transport,
  );

  assert.equal(approval.headSha, refreshed.headSha);
});

void test("capture rejects disallowed actors and the wrong intended head instead of silently following the branch", async (context) => {
  const state = await proposal(context);
  const before = state.f.calls.length;

  await assert.rejects(
    captureReleaseReview(
      { ...state.capture, target: { ...state.capture.target, approverUserId: 9 } },
      state.f.transport,
    ),
    /allowed human/u,
  );

  assert.equal(state.f.calls.length, before);

  await assert.rejects(
    captureReleaseReview(
      { ...state.capture, target: { ...state.capture.target, headSha: state.result.sourceSha } },
      state.f.transport,
    ),
    /intended open PR head/u,
  );
});

void test("capture rejects main advancement without modifying the proposal", async (context) => {
  const state = await proposal(context);
  const head = state.result.headSha;

  await state.f.advance("fix(api): retain rows");

  await assert.rejects(captureReleaseReview(state.capture, state.f.transport), /Main changed/u);

  assert.equal(state.f.ref("heads/release-log/main"), head);
});

for (const race of ["source", "head", "baseline", "body", "merge"] as const) {
  void test(`a ${race} race during capture does not produce a review record`, async (context) => {
    const state = await proposal(context);
    let reads = 0;
    const path =
      race === "source"
        ? "/git/ref/heads/main"
        : race === "head"
          ? "/git/ref/heads/release-log/main"
          : race === "baseline"
            ? "/git/ref/tags/v1.2.3"
            : "/pulls/1";

    state.f.intercept(async (method, current) => {
      if (method === "GET" && current === path && ++reads === 2) {
        if (race === "source") await state.f.advance("fix(api): retain rows");
        if (race === "head")
          state.f.git(["update-ref", "refs/heads/release-log/main", state.result.sourceSha]);
        if (race === "baseline") state.f.git(["tag", "-f", "v1.2.3", state.result.sourceSha]);
        if (race === "body") {
          const pull = state.f.pulls[0];

          assert.ok(pull);

          pull.body = text(pull.body) + "Concurrent body edit\n";
        }
        if (race === "merge") await state.land("merge");
      }

      return null;
    });

    await assert.rejects(captureReleaseReview(state.capture, state.f.transport), /changed during/u);
  });
}

for (const path of ["CHANGELOG.md", "unrelated.txt"]) {
  void test(`capture rejects edited ${path} rather than certifying the proposal marker`, async (context) => {
    const state = await proposal(context);
    const head = state.result.headSha;

    assert.ok(head);

    const tree = state.f.createTree(state.f.git(["rev-parse", `${head}^{tree}`]).trim(), [
      { path, mode: "100644", content: "unreviewed content\n" },
    ]);
    const original = await inspectCommit(state.f.directory, head);
    const changed = state.f
      .git(["commit-tree", tree, "-p", state.result.sourceSha], original.message)
      .trim();

    state.f.git(["update-ref", "refs/heads/release-log/main", changed, head]);

    await assert.rejects(
      captureReleaseReview(
        { ...state.capture, target: { ...state.capture.target, headSha: changed } },
        state.f.transport,
      ),
      /edited|unrelated/u,
    );
  });
}

void test("capture reads immutable Git objects, not modified consumer manifests or scripts", async (context) => {
  const state = await proposal(context);
  const expected = await captureReleaseReview(state.capture, state.f.transport);

  await writeFile(
    join(state.f.directory, "package.json"),
    '{"version":"9.9.9","scripts":{"prepare":"must not execute"}}\n',
  );

  const before = state.f.git(["status", "--porcelain"]);
  const actual = await captureReleaseReview(state.capture, state.f.transport);

  assert.deepEqual(actual, expected);
  assert.equal(state.f.git(["status", "--porcelain"]), before);
});

void test("finalization binds attestation to the stored repository, PR, head and actor before HTTP", async (context) => {
  const state = await proposal(context);
  const review = await captureReleaseReview(state.capture, state.f.transport);
  const attestation = await state.land("merge");
  const before = state.f.calls.length;

  for (const changed of [
    { repositoryId: 99 },
    { pullNumber: 2 },
    { headSha: state.result.sourceSha },
    { approverUserId: 9 },
  ]) {
    await assert.rejects(
      finalizeReleaseApproval(
        { ...state.capture, review, attestation: { ...attestation, ...changed } },
        state.f.transport,
      ),
      /stored review/u,
    );
  }

  assert.equal(state.f.calls.length, before);
});

void test("a changed policy or configuration cannot finalize an older stored review", async (context) => {
  const state = await proposal(context);
  const review = await captureReleaseReview(state.capture, state.f.transport);
  const attestation = await state.land("merge");

  await assert.rejects(
    finalizeReleaseApproval(
      { ...state.capture, review, attestation, policy: { ...policy, approverUserIds: [7, 9] } },
      state.f.transport,
    ),
    /policy changed/u,
  );
  await assert.rejects(
    finalizeReleaseApproval(
      { ...state.capture, review: { ...review, configurationId: "0".repeat(64) }, attestation },
      state.f.transport,
    ),
    /Configuration/u,
  );
});

void test("an ordinary merge before landing invalidates a captured review", async (context) => {
  const state = await proposal(context);
  const review = await captureReleaseReview(state.capture, state.f.transport);

  await state.f.advance("fix(api): retain rows");

  const stale = await state.land("merge");

  await assert.rejects(
    finalizeReleaseApproval({ ...state.capture, review, attestation: stale }, state.f.transport),
    /refresh and review/u,
  );
});

void test("later ordinary changes preserve the captured review and exact approved landing", async (context) => {
  const state = await proposal(context);
  const review = await captureReleaseReview(state.capture, state.f.transport);
  const attestation = await state.land("squash");

  await state.f.advance("fix(api): retain later rows");

  const approval = await finalizeReleaseApproval(
    { ...state.capture, review, attestation },
    state.f.transport,
  );

  assert.equal(approval.landingSha, attestation.landingSha);
  assert.notEqual(approval.landingSha, state.f.ref("heads/main"));
});

void test("review and merge-attestation schemas reject unknown fields, malformed identities and inferred merge methods", async (context) => {
  const state = await proposal(context);
  const review = await captureReleaseReview(state.capture, state.f.transport);
  const attestation = await state.land("merge");

  for (const value of [
    null,
    {},
    { ...state.capture.target, schemaVersion: "1" },
    { ...state.capture.target, headSha: "main" },
    { ...state.capture.target, approverUserId: 0 },
    { ...state.capture.target, valid: true },
  ])
    assert.throws(() => parseReleaseReviewTarget(value));

  for (const value of [
    null,
    {},
    { ...review, schemaVersion: 2 },
    { ...review, configurationId: "invalid" },
    { ...review, policyId: "invalid" },
    { ...review, approved: true },
  ])
    assert.throws(() => parseReleaseReview(value));

  const missingMethod = object(attestation);

  delete missingMethod.mergeKind;

  for (const value of [
    null,
    {},
    missingMethod,
    { ...attestation, mergeKind: "rebase" },
    { ...attestation, mergeKind: "guess" },
    { ...attestation, landingSha: "main" },
    { ...attestation, valid: true },
  ])
    assert.throws(() => parseReleaseMergeAttestation(value));

  assert.deepEqual(parseReleaseReview(review), review);
  assert.deepEqual(parseReleaseMergeAttestation(attestation), attestation);
});
