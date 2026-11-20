import { isMap, isScalar, parseDocument } from "yaml";
import { ProposalConflictError } from "../evidence/proposal.ts";

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
