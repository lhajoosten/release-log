export const workflowPath = ".github/workflows/rolling-release-caller.yml" as const;

export type CargoPath = "Cargo.lock" | "Cargo.toml" | `${string}/Cargo.toml`;
export const maxCargoMembers = 25;

export function isCargoManifest(path: string): path is Exclude<CargoPath, "Cargo.lock"> {
  return /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*Cargo\.toml$/u.test(path) && path.length <= 512;
}

export const proposalPaths = [
  "package.json",
  "pyproject.toml",
  "uv.lock",
  "CHANGELOG.md",
  ".release-log/inputs.json",
  workflowPath,
] as const;
export type ProposalPath = (typeof proposalPaths)[number] | CargoPath;
export const maxProposalFiles = proposalPaths.length + maxCargoMembers + 2;
const fixedOutputs: ReadonlySet<string> = new Set(proposalPaths);

export function isProposalPath(path: string): path is ProposalPath {
  return fixedOutputs.has(path) || path === "Cargo.lock" || isCargoManifest(path);
}
