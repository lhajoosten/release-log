import { ProposalConflictError, proposalObject } from "./evidence/proposal.ts";
import type { RepositoryEvidenceReader } from "./github-proposals.ts";

export { readToolPin, updateToolPins } from "./proposal/tool-pins.ts";
export { workflowPath } from "./proposal-paths.ts";

// A human-merged PR at the captured main tip plus a completed successful push
// run of our trusted Quality workflow is the candidate admission policy.
export async function verifyToolUpgradeCandidate(
  api: RepositoryEvidenceReader,
  sha: string,
  checkFreshWhileWaiting?: () => Promise<void>,
): Promise<void> {
  const associated = await api.request(`/commits/${sha}/pulls?per_page=100`);
  if (associated.next || !Array.isArray(associated.data) || associated.data.length > 100)
    throw new ProposalConflictError("Complete candidate review evidence is required.");
  let reviewed = false;
  for (const value of associated.data) {
    const pull = proposalObject(value);
    if (
      pull.merge_commit_sha !== sha ||
      !Number.isSafeInteger(pull.number) ||
      Number(pull.number) <= 0
    )
      continue;
    const full = proposalObject((await api.request(`/pulls/${String(pull.number)}`)).data);
    const base = proposalObject(full.base);
    if (
      full.number === pull.number &&
      full.state === "closed" &&
      full.merged === true &&
      typeof full.merged_at === "string" &&
      full.merge_commit_sha === sha &&
      base.ref === "main" &&
      proposalObject(base.repo).id === 1449550207 &&
      proposalObject(full.merged_by).type === "User"
    )
      reviewed = true;
  }
  if (!reviewed)
    throw new ProposalConflictError(
      "The proposed tool revision requires a human-merged release-log PR.",
    );
  const quality = await waitForMainPushQuality(api, sha, checkFreshWhileWaiting);
  if (quality === "pending")
    throw new ProposalConflictError(
      "The latest main-push Quality run is still pending for the proposed tool revision; retry after it succeeds.",
    );
  if (quality === "failed")
    throw new ProposalConflictError(
      "The proposed tool revision must pass the latest main-push Quality run before retrying.",
    );
}

type MainPushQuality = "passed" | "pending" | "failed";

export async function waitForMainPushQuality(
  api: RepositoryEvidenceReader,
  sha: string,
  checkFreshWhileWaiting?: () => Promise<void>,
): Promise<MainPushQuality> {
  // Leave time for verification and writes within the shared API deadline.
  const retries = checkFreshWhileWaiting ? 24 : 0;
  for (let attempt = 0; ; attempt++) {
    const quality = await readMainPushQuality(api, sha);
    if (quality !== "pending" || attempt === retries) return quality;
    await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
    await checkFreshWhileWaiting?.();
  }
}

async function readMainPushQuality(
  api: RepositoryEvidenceReader,
  sha: string,
): Promise<MainPushQuality> {
  const response = await api.request(
    `/actions/workflows/quality.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const evidence = proposalObject(response.data);
  const runs = evidence.workflow_runs;
  if (
    response.next ||
    !Array.isArray(runs) ||
    runs.length > 100 ||
    evidence.total_count !== runs.length
  )
    throw new ProposalConflictError(
      "Complete Quality CI evidence is required for the proposed tool revision.",
    );
  const listed = runs.map(proposalObject);
  if (
    listed.some(
      (run) =>
        !Number.isSafeInteger(run.run_number) ||
        Number(run.run_number) <= 0 ||
        run.head_sha !== sha ||
        run.head_branch !== "main" ||
        run.event !== "push" ||
        run.path !== ".github/workflows/quality.yml" ||
        proposalObject(run.repository).id !== 1449550207,
    )
  )
    throw new ProposalConflictError("Quality run provenance is incomplete or inconsistent.");
  const latest = listed.toSorted((a, b) => Number(b.run_number) - Number(a.run_number))[0];
  if (!latest) return "pending";
  if (latest.status === "completed" && latest.conclusion === "success") return "passed";
  if ((latest.status === "queued" || latest.status === "in_progress") && latest.conclusion === null)
    return "pending";
  return "failed";
}
