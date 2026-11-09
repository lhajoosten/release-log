import { proposalObject } from "./github-proposals.ts";
import type { GitHubProposalRepository } from "./github-proposals.ts";
import { ReleaseApprovalError } from "./release-approval-record.ts";
import type { ReleaseApprovalPolicy, ReleaseReviewTarget } from "./release-approval-record.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

function fail(message: string): never {
  throw new ReleaseApprovalError("readiness-failed", message);
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return fail("GitHub readiness evidence requires positive numeric identities.");

  return value;
}

async function list(
  api: GitHubProposalRepository,
  path: string,
  key: "workflow_runs" | "jobs" | null,
): Promise<readonly Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  let total: number | null = null;

  for (let page = 1; page <= 10; page++) {
    const response = await api.request(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const envelope = key === null ? null : proposalObject(response.data);
    const entries: unknown = envelope === null || key === null ? response.data : envelope[key];

    if (envelope !== null) {
      const count = envelope.total_count;

      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 1000 ||
        (total !== null && total !== count)
      )
        return fail("Readiness pagination has missing, changed or excessive total counts.");

      total = count;
    }

    if (
      !Array.isArray(entries) ||
      entries.length > 100 ||
      (response.next && entries.length !== 100)
    )
      return fail("Readiness pagination is incomplete; no partial review/check result is usable.");

    result.push(...entries.map((entry: unknown) => proposalObject(entry)));

    if (!response.next) {
      if (
        (total !== null && result.length !== total) ||
        new Set(result.map((entry) => positive(entry.id))).size !== result.length
      )
        return fail("Readiness pagination contains missing or duplicate identities.");

      return result;
    }
  }

  return fail("Readiness listing exceeds ten pages; explicit recovery is required.");
}

interface ReadinessEvidence {
  readonly reviewId: number;
  readonly checks: readonly {
    readonly workflowId: number;
    readonly event: string;
    readonly runId: number;
    readonly attempt: number;
    readonly jobId: number;
    readonly checkRunId: number;
  }[];
}

export async function verifyReleaseReadiness(
  api: GitHubProposalRepository,
  config: ReleaseInputConfiguration,
  policy: ReleaseApprovalPolicy,
  target: ReleaseReviewTarget,
): Promise<ReadinessEvidence | null> {
  if (policy.schemaVersion === 1) return null;

  const reviews = await list(api, `/pulls/${target.pullNumber}/reviews`, null);
  const submitted: { id: number; time: number; state: unknown; commitSha: unknown }[] = [];

  for (const review of reviews) {
    const user = proposalObject(review.user);

    if (user.id !== target.approverUserId) continue;
    if (user.type !== "User")
      return fail("The intended review must be submitted by the allowed human, not a bot.");
    if (review.state === "PENDING" && review.submitted_at === null) continue;

    const time =
      typeof review.submitted_at === "string" ? Date.parse(review.submitted_at) : Number.NaN;

    if (
      !Number.isFinite(time) ||
      typeof review.state !== "string" ||
      !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(review.state)
    )
      return fail("The intended human review has incomplete submission/state evidence.");

    submitted.push({
      id: positive(review.id),
      time,
      state: review.state,
      commitSha: review.commit_id,
    });
  }

  const latestTime = Math.max(...submitted.map((review) => review.time));
  const latest = submitted.filter((review) => review.time === latestTime);
  const review = latest[0];

  if (
    latest.length !== 1 ||
    !review ||
    review.state !== "APPROVED" ||
    review.commitSha !== target.headSha
  )
    return fail(
      "The intended human needs one unambiguous latest submitted APPROVED review at the exact proposal head; renew dismissed, stale or superseded review.",
    );

  const groups = new Map<string, { workflowId: number; event: string }>();

  for (const check of policy.requiredChecks)
    groups.set(JSON.stringify([check.workflowId, check.event]), check);

  const checks: ReadinessEvidence["checks"][number][] = [];

  for (const group of groups.values()) {
    const runs = await list(
      api,
      `/actions/workflows/${group.workflowId}/runs?head_sha=${target.headSha}&event=${group.event}`,
      "workflow_runs",
    );
    let selected: Record<string, unknown> | null = null;
    const numbers = new Set<number>();

    // Attempts rerun one invocation; an older invocation cannot replace a newer failed one.
    for (const run of runs) {
      const number = positive(run.run_number);

      if (
        run.workflow_id !== group.workflowId ||
        run.event !== group.event ||
        run.head_sha !== target.headSha ||
        run.head_branch !== api.headRef ||
        proposalObject(run.repository).id !== config.repositoryId ||
        proposalObject(run.head_repository).id !== config.repositoryId ||
        numbers.has(number)
      )
        return fail(
          "Required workflow evidence has a different workflow/event/head/branch/repository or ambiguous run sequence.",
        );

      numbers.add(number);
      if (selected === null || positive(selected.run_number) < number) selected = run;
    }

    if (selected === null || selected.status !== "completed" || selected.conclusion !== "success")
      return fail(
        "The latest required workflow invocation is missing or not successful; an older green run cannot authorize release.",
      );

    const runId = positive(selected.id);
    const attempt = positive(selected.run_attempt);
    const suiteId = positive(selected.check_suite_id);
    const jobs = await list(api, `/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");

    for (const expected of policy.requiredChecks.filter(
      (check) => check.workflowId === group.workflowId && check.event === group.event,
    )) {
      const candidates = jobs.filter((job) => job.name === expected.name);
      const job = candidates[0];

      if (
        candidates.length !== 1 ||
        !job ||
        job.run_id !== runId ||
        job.run_attempt !== attempt ||
        job.head_sha !== target.headSha ||
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        typeof job.check_run_url !== "string"
      )
        return fail(
          "A required job is missing, ambiguous, unsuccessful or belongs to another run/head.",
        );

      const prefix = `https://api.github.com/repos/${config.repository}/check-runs/`;
      const suffix = job.check_run_url.startsWith(prefix)
        ? job.check_run_url.slice(prefix.length)
        : "";

      if (!/^[1-9]\d*$/u.test(suffix))
        return fail(
          "A required job has no same-repository check-run identity; supplied URLs are not followed.",
        );

      const checkRunId = positive(Number(suffix));
      const check = proposalObject((await api.request(`/check-runs/${checkRunId}`)).data);

      if (
        check.id !== checkRunId ||
        check.name !== expected.name ||
        check.head_sha !== target.headSha ||
        check.status !== "completed" ||
        check.conclusion !== "success" ||
        proposalObject(check.app).id !== expected.appId ||
        proposalObject(check.check_suite).id !== suiteId
      )
        return fail(
          "The required check is not successful at the exact head from its trusted App and selected workflow suite.",
        );

      checks.push({
        workflowId: group.workflowId,
        event: group.event,
        runId,
        attempt,
        jobId: positive(job.id),
        checkRunId,
      });
    }
  }

  return { reviewId: review.id, checks };
}

export function requireSameReadiness(
  before: ReadinessEvidence | null,
  after: ReadinessEvidence | null,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    return fail(
      "Human review or required workflow/run/attempt/check identity changed during verification; obtain fresh evidence.",
    );
}
