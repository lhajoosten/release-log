import { readCargoContents } from "./cargo-version.ts";
import type { CargoContents } from "./cargo-version.ts";
import { proposalPaths, workflowPath } from "./proposal-paths.ts";

export const releaseInputPaths = proposalPaths;
export type ReleaseFileContents = Readonly<
  Record<Exclude<(typeof releaseInputPaths)[number], typeof workflowPath>, string | null> &
    Partial<Record<typeof workflowPath, string | null>> &
    CargoContents
>;

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
