import { readCargoContents } from "./cargo-version.ts";
import type { CargoContents } from "./cargo-version.ts";
import { proposalPaths, workflowPath } from "./proposal-paths.ts";

export const releaseInputPaths = proposalPaths;
export type ReleaseFileContents = Readonly<
  Record<Exclude<(typeof releaseInputPaths)[number], typeof workflowPath>, string | null> &
    Partial<Record<typeof workflowPath, string | null>> &
    CargoContents
>;

export interface ReleaseTreeEntry {
  readonly sha: string;
  readonly type: string;
  readonly mode: string;
}

export function trackedReleaseInput(
  entries: ReadonlyMap<string, ReleaseTreeEntry>,
  path: string,
  reject: (message: string) => Error,
): ReleaseTreeEntry | undefined {
  const parts = path.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const parent = entries.get(parts.slice(0, depth).join("/"));
    if (parent && (parent.type !== "tree" || parent.mode !== "040000"))
      throw reject("Proposal input directories must be ordinary Git trees.");
  }

  const entry = entries.get(path);
  if (entry && (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)))
    throw reject("Proposal inputs must be ordinary tracked files, not symlinks or submodules.");
  return entry;
}

export async function readReleaseContents(
  get: (path: string) => Promise<string | null>,
  selfUpgrade?: boolean,
): Promise<ReleaseFileContents> {
  return {
    [workflowPath]: selfUpgrade ? await get(workflowPath) : null,
    ...(await readCargoContents(get)),
    "package.json": await get("package.json"),
    "pyproject.toml": await get("pyproject.toml"),
    "CHANGELOG.md": await get("CHANGELOG.md"),
    ".release-log/inputs.json": await get(".release-log/inputs.json"),
    "package-lock.json": await get("package-lock.json"),
    "npm-shrinkwrap.json": await get("npm-shrinkwrap.json"),
    "uv.lock": await get("uv.lock"),
  };
}
