import { glob, lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { readCargoContents, updateCargoVersions } from "./cargo-version.ts";
import { updateNpmLockVersion } from "./npm-version.ts";
import { planNodeWorkspace } from "./node-workspace.ts";
import { planPythonWorkspace } from "./python-workspace.ts";
import { planPoetryWorkspace } from "./poetry-workspace.ts";
import { updateUvLockVersion } from "./uv-version.ts";
import { record, updatePackageVersion, updatePyprojectVersion } from "./version-adapters.ts";
import { isCargoManifest, maxCargoMembers } from "./version-paths.ts";
import type { CargoPath } from "./version-paths.ts";

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** Plan edits without changing the worktree. Reject missing or unsafe input rather than guessing. */
export async function planVersionFiles(
  root: string,
  previousVersion: string | null,
  nextVersion: string,
): Promise<ReadonlyMap<string, string | Uint8Array>> {
  if (
    (previousVersion !== null && !stableVersion.test(previousVersion)) ||
    !stableVersion.test(nextVersion)
  )
    throw new Error("Expected stable versions.");
  const directory = resolve(root);
  async function get(path: string): Promise<string | null> {
    let current = directory;
    for (const segment of path.split("/")) {
      if (!segment || segment === "." || segment === "..")
        throw new Error("Unsafe version file path.");
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error(`Version input is a symlink: ${path}`);
    }
    return readFile(current, "utf8");
  }
  const plan = { currentVersion: previousVersion, nextVersion };
  const [node, npm, shrinkwrap, python, uv, cargoRoot] = await Promise.all([
    get("package.json"),
    get("package-lock.json"),
    get("npm-shrinkwrap.json"),
    get("pyproject.toml"),
    get("uv.lock"),
    get("Cargo.toml"),
  ]);
  if (npm && shrinkwrap) throw new Error("Only one npm lockfile is supported.");
  if ((npm || shrinkwrap) && !node) throw new Error("npm lockfile requires package.json.");
  if (uv && !python) throw new Error("uv.lock requires pyproject.toml.");
  const result = new Map<string, string | Uint8Array>();
  const workspace = node ? await planNodeWorkspace(directory, previousVersion, nextVersion) : null;
  if (node && !workspace) {
    for (const path of ["bun.lock", "bun.lockb"]) {
      if ((await get(path)) !== null) throw new Error(`${path} updates are not yet supported.`);
    }
  }
  if (workspace) for (const [path, content] of workspace) result.set(path, content);
  if (node && !workspace) {
    const update = updatePackageVersion(node, plan);
    if (update.content !== node) result.set("package.json", update.content);
    const lock = npm ?? shrinkwrap;
    const path = npm ? "package-lock.json" : "npm-shrinkwrap.json";
    if (lock) {
      const updated = updateNpmLockVersion(lock, path, update.version, plan);
      if (updated !== lock) result.set(path, updated);
    }
  }
  const pythonWorkspace = python
    ? await planPythonWorkspace(directory, previousVersion, nextVersion)
    : null;
  const poetryWorkspace = python
    ? await planPoetryWorkspace(directory, previousVersion, nextVersion)
    : null;
  if (pythonWorkspace && poetryWorkspace)
    throw new Error("Combining uv and Poetry workspaces is unsupported.");
  if (pythonWorkspace) for (const [path, content] of pythonWorkspace) result.set(path, content);
  if (poetryWorkspace) for (const [path, content] of poetryWorkspace) result.set(path, content);
  if (python && !pythonWorkspace && !poetryWorkspace) {
    const update = updatePyprojectVersion(python, plan);
    if (update.content !== python) result.set("pyproject.toml", update.content);
    if (uv) {
      const updated = updateUvLockVersion(python, uv, update, plan);
      if (updated !== uv) result.set("uv.lock", updated);
    }
  }
  let cargoMembers: CargoPath[] | undefined;
  if (cargoRoot !== null) {
    const data: unknown = getStaticTOMLValue(parseTOML(cargoRoot));
    if (record(data) && record(data.workspace) && Array.isArray(data.workspace.members)) {
      cargoMembers = [];
      const excludes = data.workspace.exclude;
      if (excludes !== undefined && (!Array.isArray(excludes) || excludes.length))
        throw new Error("Cargo workspace exclusions are unsupported.");
      for (const pattern of data.workspace.members) {
        if (
          typeof pattern !== "string" ||
          pattern.startsWith("/") ||
          pattern.split("/").includes("..")
        )
          throw new Error("Unsafe Cargo workspace pattern.");
        let found = false;
        for await (const path of glob(`${pattern}/Cargo.toml`, { cwd: directory })) {
          if (!isCargoManifest(path)) throw new Error(`Unsafe Cargo workspace path: ${path}`);
          if (!cargoMembers.includes(path)) cargoMembers.push(path);
          found = true;
        }
        if (!found) throw new Error(`Cargo workspace member matches no manifest: ${pattern}`);
        if (cargoMembers.length > maxCargoMembers)
          throw new Error("Too many Cargo workspace members.");
      }
      cargoMembers.sort();
    }
  }
  const cargoContents = await readCargoContents(get, cargoMembers);
  const cargo = updateCargoVersions(cargoContents, plan, cargoMembers);
  for (const file of cargo?.files ?? [])
    if (file.before !== file.after) result.set(file.path, file.after);
  return result;
}
