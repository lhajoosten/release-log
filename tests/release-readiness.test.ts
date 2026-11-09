import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReleaseApprovalPolicy, ReleaseApprovalError } from "../src/release-approval.ts";
import { requireSameReadiness, verifyReleaseReadiness } from "../src/release-readiness.ts";
import { fixtureConfiguration } from "./release-fixture.ts";
import { json } from "./proposal-fixture.ts";
import { readinessFixture } from "./readiness-fixture.ts";

void test("strict policy verifies the actual human review and trusted workflow/attempt/job/App chain using GET only", async () => {
  const f = readinessFixture();
  const evidence = await verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target);

  assert.ok(evidence);
  assert.equal(evidence.reviewId, 100);
  assert.deepEqual(evidence.checks, [
    { workflowId: 201, event: "pull_request", runId: 300, attempt: 2, jobId: 500, checkRunId: 600 },
    { workflowId: 201, event: "pull_request", runId: 300, attempt: 2, jobId: 501, checkRunId: 601 },
  ]);
  assert.equal(f.calls.filter((url) => url.includes("/workflows/")).length, 1);
  assert.equal(f.calls.filter((url) => url.includes("/attempts/2/jobs")).length, 1);
  assert.ok(!JSON.stringify(evidence).includes("synthetic-review-body"));
  assert.ok(!JSON.stringify(evidence).includes("synthetic-read-token"));
  requireSameReadiness(
    evidence,
    await verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
  );
});

void test("policy 1 remains byte-compatible and makes no readiness requests", async () => {
  const f = readinessFixture();
  const policy = { schemaVersion: 1 as const, botUserId: 42, approverUserIds: [7] };

  assert.equal(await verifyReleaseReadiness(f.api, fixtureConfiguration, policy, f.target), null);
  assert.deepEqual(f.calls, []);
  assert.equal(JSON.stringify(parseReleaseApprovalPolicy(policy)), JSON.stringify(policy));
});

void test("policy 2 canonically sorts checks and rejects missing, duplicate, malformed and unsupported trust selectors", () => {
  const f = readinessFixture();
  const parsed = parseReleaseApprovalPolicy(f.policy);

  assert.equal(parsed.schemaVersion, 2);
  assert.ok(parsed.schemaVersion === 2);
  assert.deepEqual(
    parsed.requiredChecks.map((check) => check.name),
    ["container", "verify"],
  );

  for (const policy of [
    { ...f.policy, schemaVersion: 3 },
    { ...f.policy, requiredChecks: [] },
    { ...f.policy, requiredChecks: Array.from({ length: 21 }, () => f.policy.requiredChecks[0]) },
    { ...f.policy, requiredChecks: [{ ...f.policy.requiredChecks[0], appId: 0 }] },
    { ...f.policy, requiredChecks: [{ ...f.policy.requiredChecks[0], workflowId: "201" }] },
    { ...f.policy, requiredChecks: [{ ...f.policy.requiredChecks[0], event: "push" }] },
    { ...f.policy, requiredChecks: [{ ...f.policy.requiredChecks[0], name: "verify\nother" }] },
    { ...f.policy, requiredChecks: [{ ...f.policy.requiredChecks[0], name: " " }] },
    { ...f.policy, requiredChecks: [{ ...f.policy.requiredChecks[0], trusted: true }] },
    { ...f.policy, requiredChecks: [f.policy.requiredChecks[0], f.policy.requiredChecks[0]] },
    { ...f.policy, schemaVersion: 1 },
  ])
    assert.throws(() => parseReleaseApprovalPolicy(policy), ReleaseApprovalError);
});

for (const state of ["DISMISSED", "CHANGES_REQUESTED", "COMMENTED", "PENDING"]) {
  void test(`a latest ${state} review cannot authorize the intended head`, async () => {
    const f = readinessFixture();
    const review = f.reviews[0];

    assert.ok(review);
    review.state = state;
    if (state === "PENDING") review.submitted_at = null;

    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      /latest submitted APPROVED/u,
    );
  });
}

void test("stale heads, wrong humans, bot reviews and ambiguous submission times fail closed", async () => {
  for (const mutation of ["head", "human", "bot", "tie", "date"] as const) {
    const f = readinessFixture();
    const review = f.reviews[0];

    assert.ok(review);
    if (mutation === "head") review.commit_id = "b".repeat(40);
    if (mutation === "human") review.user = { id: 8, type: "User" };
    if (mutation === "bot") review.user = { id: 7, type: "Bot" };
    if (mutation === "tie") f.reviews.push({ ...review, id: 101 });
    if (mutation === "date") review.submitted_at = "not a date";

    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      ReleaseApprovalError,
    );
  }
});

void test("latest submitted review is selected by submission time, not ID or API order", async () => {
  const f = readinessFixture();

  f.reviews.push({
    ...f.reviews[0],
    id: 90,
    submitted_at: "2026-11-09T16:00:00Z",
    state: "CHANGES_REQUESTED",
  });
  f.reviews.reverse();

  await assert.rejects(
    verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
    /latest submitted APPROVED/u,
  );
});

void test("an older failed invocation does not shadow the latest successful workflow run", async () => {
  const f = readinessFixture();

  f.runs.unshift({ ...f.runs[0], id: 299, run_number: 9, conclusion: "failure" });

  const evidence = await verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target);

  assert.ok(evidence);
  assert.ok(evidence.checks.every((check) => check.runId === 300 && check.attempt === 2));
});

for (const status of ["queued", "in_progress", "failure", "cancelled", "skipped", "neutral"]) {
  void test(`a newer workflow invocation in ${status} cannot fall back to an older success`, async () => {
    const f = readinessFixture();

    f.runs.unshift({
      ...f.runs[0],
      id: 301,
      run_number: 11,
      status: status === "queued" || status === "in_progress" ? status : "completed",
      conclusion: status,
    });
    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      /older green run/u,
    );
    assert.ok(!f.calls.some((url) => url.includes("/jobs")));
  });
}

for (const mismatch of [
  "workflow_id",
  "event",
  "head_sha",
  "head_branch",
  "repository",
  "head_repository",
] as const) {
  void test(`workflow ${mismatch} mismatch cannot supply a check`, async () => {
    const f = readinessFixture();
    const run = f.runs[0];

    assert.ok(run);
    run[mismatch] =
      mismatch === "workflow_id" ? 999 : mismatch.endsWith("repository") ? { id: 999 } : "wrong";
    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      /workflow\/event\/head/u,
    );
  });
}

for (const mismatch of [
  "run_id",
  "run_attempt",
  "head_sha",
  "status",
  "conclusion",
  "name",
  "check_run_url",
] as const) {
  void test(`job ${mismatch} mismatch fails without following supplied URLs`, async () => {
    const f = readinessFixture();
    const job = f.jobs[0];

    assert.ok(job);
    job[mismatch] =
      mismatch === "run_id" || mismatch === "run_attempt"
        ? 1
        : mismatch === "check_run_url"
          ? "https://attacker.invalid/check-runs/600"
          : "wrong";
    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      ReleaseApprovalError,
    );
    assert.ok(
      f.calls.every((url) => url.startsWith("https://api.github.com/repos/example/project/")),
    );
  });
}

for (const mismatch of [
  "app",
  "check_suite",
  "head_sha",
  "conclusion",
  "status",
  "id",
  "name",
] as const) {
  void test(`check-run ${mismatch} mismatch cannot spoof a trusted required check`, async () => {
    const f = readinessFixture();
    const check = f.checkRuns[0];

    assert.ok(check);
    if (mismatch === "id") {
      f.intercept((url) =>
        url.pathname.endsWith("/check-runs/600") ? json({ ...check, id: 999 }) : null,
      );
    } else
      check[mismatch] = mismatch === "app" || mismatch === "check_suite" ? { id: 999 } : "wrong";

    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      /trusted App/u,
    );
  });
}

void test("missing, duplicated and inconsistent paginated evidence is never silently truncated", async () => {
  for (const kind of [
    "missing-review",
    "missing-run",
    "duplicate-job",
    "duplicate-run",
    "truncated",
    "wrong-count",
    "oversized",
  ] as const) {
    const f = readinessFixture();

    if (kind === "missing-review") f.reviews.length = 0;
    if (kind === "missing-run") f.runs.length = 0;
    if (kind === "duplicate-job") f.jobs.push({ ...f.jobs[0], id: 999 });
    if (kind === "duplicate-run") f.runs.push({ ...f.runs[0] });
    if (kind === "truncated")
      f.intercept((url) =>
        url.pathname.endsWith("/reviews")
          ? json(f.reviews, 200, { link: '<https://attacker.invalid/ignored>; rel="next"' })
          : null,
      );
    if (kind === "wrong-count")
      f.intercept((url) =>
        url.pathname.endsWith("/runs") ? json({ total_count: 2, workflow_runs: f.runs }) : null,
      );
    if (kind === "oversized")
      f.intercept((url) =>
        url.pathname.endsWith("/runs") ? json({ total_count: 1001, workflow_runs: f.runs }) : null,
      );

    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      ReleaseApprovalError,
    );
  }
});

void test("review pagination constructs page requests locally and includes later submitted review", async () => {
  const f = readinessFixture();
  const older = Array.from({ length: 100 }, (_, index) => ({
    ...f.reviews[0],
    id: index + 1000,
    submitted_at: "2026-11-09T14:00:00Z",
  }));

  f.intercept((url) => {
    if (!url.pathname.endsWith("/reviews")) return null;
    return url.searchParams.get("page") === "1"
      ? json(older, 200, { link: '<https://attacker.invalid/not-followed>; rel="next"' })
      : json(f.reviews);
  });

  const evidence = await verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target);

  assert.equal(evidence?.reviewId, 100);
  assert.ok(f.calls.some((url) => url.endsWith("reviews?per_page=100&page=2")));
});

void test("a changed successful attempt identity invalidates an in-flight observation", async () => {
  const f = readinessFixture();
  const before = await verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target);

  assert.ok(before);
  assert.throws(
    () =>
      requireSameReadiness(before, {
        ...before,
        checks: before.checks.map((check) => ({ ...check, attempt: 3 })),
      }),
    /changed during verification/u,
  );
});

for (const status of [401, 403, 429, 500]) {
  void test(`readiness HTTP ${status} fails rather than authorizing from absent evidence`, async () => {
    const f = readinessFixture();

    f.intercept(() => json({ message: "synthetic-read-token" }, status));
    await assert.rejects(
      verifyReleaseReadiness(f.api, fixtureConfiguration, f.policy, f.target),
      (error: unknown) => error instanceof Error && !error.message.includes("synthetic-read-token"),
    );
  });
}
