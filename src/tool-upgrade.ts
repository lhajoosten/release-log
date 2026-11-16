import { isMap, isScalar, parseDocument } from "yaml";
import { ProposalConflictError, proposalObject } from "./github-proposals.ts";
import type { GitHubProposalRepository } from "./github-proposals.ts";

export { workflowPath } from "./proposal-paths.ts";
const workflow = "lhajoosten/release-log/.github/workflows/rolling-release.yml@";

export function updateToolPins(content: string | null, sourceSha: string): string {
  if (content === null || !/^[a-f0-9]{40}$/u.test(sourceSha))
    throw new ProposalConflictError(
      "Self-upgrades require the existing caller and a full GitHub source SHA.",
    );
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length)
    throw new ProposalConflictError("The self-upgrade caller must be valid unambiguous YAML.");
  const jobs = document.getIn(["jobs"], true);
  const job = document.getIn(["jobs", "release"], true);
  const inputs = document.getIn(["jobs", "release", "with"], true);
  if (
    !isMap(jobs) ||
    !isMap(job) ||
    !isMap(inputs) ||
    jobs.anchor ||
    job.anchor ||
    inputs.anchor ||
    (isMap(document.contents) && document.contents.anchor)
  )
    throw new ProposalConflictError("Caller pin ancestors must be ordinary unanchored mappings.");
  const uses = document.getIn(["jobs", "release", "uses"], true);
  const tool = document.getIn(["jobs", "release", "with", "tool-sha"], true);
  if (
    !isScalar(uses) ||
    !isScalar(tool) ||
    uses.anchor !== undefined ||
    tool.anchor !== undefined ||
    typeof uses.value !== "string" ||
    typeof tool.value !== "string" ||
    !uses.range ||
    !tool.range ||
    !/^[a-f0-9]{40}$/u.test(tool.value) ||
    uses.value !== workflow + tool.value
  )
    throw new ProposalConflictError(
      "Self-upgrades require matching immutable pins in jobs.release.",
    );
  let result = content;
  for (const node of [uses, tool].toSorted((a, b) => (b.range?.[0] ?? 0) - (a.range?.[0] ?? 0))) {
    if (!node.range) throw new ProposalConflictError("Missing caller scalar range.");
    const [start, end] = node.range;
    const scalar = content.slice(start, end);
    const value = node === uses ? workflow + tool.value : tool.value;
    if (![value, `'${value}'`, `"${value}"`].includes(scalar))
      throw new ProposalConflictError("Self-upgrade pins must be simple single-line scalars.");
    result = result.slice(0, start) + scalar.replace(tool.value, sourceSha) + result.slice(end);
  }
  return result;
}

// Used only on reviewed tool checkouts when preserving the preceding producer.
export function readToolPin(content: string): string {
  updateToolPins(content, "0".repeat(40));
  const document = parseDocument(content);
  const value: unknown = document.getIn(["jobs", "release", "with", "tool-sha"]);
  if (typeof value !== "string") throw new ProposalConflictError("Missing trusted caller pin.");
  return value;
}

// A human-merged PR at the captured main tip plus a completed successful push
// run of our trusted Quality workflow is the candidate admission policy.
export async function verifyToolUpgradeCandidate(
  api: GitHubProposalRepository,
  sha: string,
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
  const response = await api.request(
    `/actions/workflows/quality.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const evidence = proposalObject(response.data);
  const runs = evidence.workflow_runs;
  if (
    response.next ||
    !Array.isArray(runs) ||
    runs.length === 0 ||
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
  if (
    !latest ||
    latest.head_sha !== sha ||
    latest.head_branch !== "main" ||
    latest.event !== "push" ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    latest.path !== ".github/workflows/quality.yml" ||
    proposalObject(latest.repository).id !== 1449550207
  )
    throw new ProposalConflictError(
      "The proposed tool revision must pass the latest main-push Quality run before retrying.",
    );
}
