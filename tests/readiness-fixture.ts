import assert from "node:assert/strict";
import { GitHubProposalRepository } from "../src/github-proposals.ts";
import type { GitHubRead } from "../src/github.ts";
import { fixtureConfiguration } from "./release-fixture.ts";
import { botId, json } from "./proposal-fixture.ts";

export function readinessFixture(headSha = "a".repeat(40), pullNumber = 1, fallback?: GitHubRead) {
  const policy = {
    schemaVersion: 2 as const,
    botUserId: botId,
    approverUserIds: [7],
    requiredChecks: [
      { name: "verify", appId: 90, workflowId: 201, event: "pull_request" as const },
      { name: "container", appId: 90, workflowId: 201, event: "pull_request" as const },
    ],
  };
  const target = { schemaVersion: 1 as const, pullNumber, headSha, approverUserId: 7 };
  const reviews: Record<string, unknown>[] = [
    {
      id: 100,
      user: { id: 7, type: "User" },
      state: "APPROVED",
      commit_id: headSha,
      submitted_at: "2026-11-09T15:00:00Z",
      body: "synthetic-review-body-not-returned",
    },
  ];
  const runs: Record<string, unknown>[] = [
    {
      id: 300,
      run_number: 10,
      run_attempt: 2,
      check_suite_id: 400,
      workflow_id: 201,
      event: "pull_request",
      head_sha: headSha,
      head_branch: "release-log/main",
      repository: { id: 17 },
      head_repository: { id: 17 },
      status: "completed",
      conclusion: "success",
    },
  ];
  const jobs: Record<string, unknown>[] = [
    {
      id: 500,
      name: "verify",
      run_id: 300,
      run_attempt: 2,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      check_run_url: "https://api.github.com/repos/example/project/check-runs/600",
    },
    {
      id: 501,
      name: "container",
      run_id: 300,
      run_attempt: 2,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      check_run_url: "https://api.github.com/repos/example/project/check-runs/601",
    },
  ];
  const checkRuns: Record<string, unknown>[] = [
    {
      id: 600,
      name: "verify",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      app: { id: 90 },
      check_suite: { id: 400 },
    },
    {
      id: 601,
      name: "container",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      app: { id: 90 },
      check_suite: { id: 400 },
    },
  ];
  const calls: string[] = [];
  let intercept: ((url: URL) => Response | null) | null = null;
  const transport: GitHubRead = async (url, options) => {
    assert.equal(options.method ?? "GET", "GET");
    assert.equal(options.redirect, "error");
    assert.ok(url.startsWith("https://api.github.com/repos/example/project"));
    const parsed = new URL(url);
    const replacement = intercept?.(parsed);

    calls.push(url);
    if (replacement) return replacement;
    if (parsed.pathname === `/repos/example/project/pulls/${pullNumber}/reviews`)
      return json(reviews);
    if (parsed.pathname === "/repos/example/project/actions/workflows/201/runs") {
      assert.equal(parsed.searchParams.get("head_sha"), headSha);
      assert.equal(parsed.searchParams.get("event"), "pull_request");
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (parsed.pathname === "/repos/example/project/actions/runs/300/attempts/2/jobs")
      return json({ total_count: jobs.length, jobs });
    if (parsed.pathname.startsWith("/repos/example/project/check-runs/")) {
      const id = Number(parsed.pathname.split("/").at(-1));
      const check = checkRuns.find((entry) => entry.id === id);

      assert.ok(check);
      return json(check);
    }
    if (fallback) return fallback(url, options);
    return assert.fail(`Unexpected readiness request: ${url}`);
  };

  return {
    policy,
    target,
    reviews,
    runs,
    jobs,
    checkRuns,
    calls,
    transport,
    api: new GitHubProposalRepository(
      fixtureConfiguration,
      botId,
      "synthetic-read-token",
      transport,
    ),
    intercept(callback: typeof intercept) {
      intercept = callback;
    },
  };
}
