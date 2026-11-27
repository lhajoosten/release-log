import { glob, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { updateUvLockRequirements, updateUvRequirements } from "./python-requirements.ts";
import { record, updatePyprojectVersion } from "./version-adapters.ts";

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");

/** Plan a static, shared-version uv workspace. Unknown layouts fail rather than leave stale locks. */
export async function planPythonWorkspace(
  root: string,
  previousVersion: string | null,
  nextVersion: string,
): Promise<ReadonlyMap<string, string> | null> {
  const rootText = await readFile(join(root, "pyproject.toml"), "utf8");
  const rootData: unknown = getStaticTOMLValue(parseTOML(rootText));
  if (
    !record(rootData) ||
    !record(rootData.tool) ||
    !record(rootData.tool.uv) ||
    !record(rootData.tool.uv.workspace)
  )
    return null;
  const workspace = rootData.tool.uv.workspace;
  if (
    !Array.isArray(workspace.members) ||
    !workspace.members.length ||
    (workspace.exclude !== undefined &&
      (!Array.isArray(workspace.exclude) || workspace.exclude.length))
  )
    throw new Error("Unsupported uv workspace members or exclusions.");
  const paths = new Set<string>();
  for (const pattern of workspace.members) {
    if (
      typeof pattern !== "string" ||
      !pattern ||
      pattern.startsWith("/") ||
      pattern.split("/").some((part) => !part || part === "." || part === "..") ||
      pattern.includes("\\")
    )
      throw new Error("Unsafe uv workspace pattern.");
    let found = false;
    for await (const path of glob(`${pattern}/pyproject.toml`, { cwd: root })) {
      let current = root;
      for (const part of path.split("/")) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`Workspace manifest traverses a symlink: ${path}`);
      }
      paths.add(path);
      found = true;
      if (paths.size > 200) throw new Error("Too many uv workspace members.");
    }
    if (!found) throw new Error(`uv workspace pattern matches no manifest: ${pattern}`);
  }
  if (record(rootData.project) && typeof rootData.project.version === "string")
    paths.add("pyproject.toml");
  const output = new Map<string, string>();
  const members = new Map<string, { path: string; version: string }>();
  for (const path of [...paths].toSorted()) {
    const text = path === "pyproject.toml" ? rootText : await readFile(join(root, path), "utf8");
    const data: unknown = getStaticTOMLValue(parseTOML(text));
    if (!record(data) || !record(data.project) || typeof data.project.name !== "string")
      throw new Error(`Workspace member lacks a static project name: ${path}`);
    const name = normalize(data.project.name);
    if (members.has(name)) throw new Error(`Duplicate uv workspace name: ${name}`);
    const updated = updatePyprojectVersion(text, { currentVersion: previousVersion, nextVersion });
    members.set(name, {
      path: path === "pyproject.toml" ? "." : path.slice(0, -"/pyproject.toml".length),
      version: updated.version,
    });
    if (updated.content !== text) output.set(path, updated.content);
  }
  for (const path of [...new Set([...paths, "pyproject.toml"])].toSorted()) {
    const original =
      path === "pyproject.toml" ? rootText : await readFile(join(root, path), "utf8");
    const versioned = output.get(path) ?? original;
    const oldVersion = previousVersion ?? members.values().next().value?.version;
    if (!oldVersion) throw new Error("Workspace has no captured version.");
    const updated = updateUvRequirements(
      versioned,
      new Set(members.keys()),
      oldVersion,
      nextVersion,
    );
    if (updated !== original) output.set(path, updated);
  }
  if ((await lstat(join(root, "uv.lock"))).isSymbolicLink())
    throw new Error("uv.lock must not be a symlink.");
  const lockText = await readFile(join(root, "uv.lock"), "utf8");
  const ast = parseTOML(lockText);
  const lock: unknown = getStaticTOMLValue(ast);
  if (!record(lock) || lock.version !== 1 || !Array.isArray(lock.package))
    throw new Error("Unsupported uv lockfile.");
  const found = new Set<string>();
  const edits: { start: number; end: number; replacement: string }[] = [];
  for (const [index, entry] of lock.package.entries()) {
    if (!record(entry) || typeof entry.name !== "string" || !record(entry.source))
      throw new Error("Malformed uv lock package.");
    const name = normalize(entry.name),
      member = members.get(name);
    const location = entry.source.editable ?? entry.source.virtual;
    if (!member || location === undefined) {
      if (!member && typeof location === "string")
        throw new Error(`Unrecognized local uv lock package: ${name}`);
      continue;
    }
    if (found.has(name) || location !== member.path || entry.version !== member.version)
      throw new Error(`uv lock does not match workspace member ${name}.`);
    found.add(name);
    const table = ast.body[0].body.find(
      (node) =>
        node.type === "TOMLTable" &&
        node.kind === "array" &&
        node.resolvedKey[0] === "package" &&
        node.resolvedKey[1] === index,
    );
    if (table?.type !== "TOMLTable") throw new Error("Malformed uv lock table.");
    const value = table.body.find(
      (node) => JSON.stringify(getStaticTOMLValue(node.key)) === '["version"]',
    )?.value;
    if (value?.type !== "TOMLValue" || value.kind !== "string")
      throw new Error(`Missing uv lock version: ${name}`);
    const [start, end] = value.range;
    const quote = lockText[start];
    if (quote !== '"' && quote !== "'") throw new Error("Unsupported uv lock version quoting.");
    edits.push({ start, end, replacement: `${quote}${nextVersion}${quote}` });
  }
  if (found.size !== members.size) throw new Error("uv lock omits workspace members.");
  let updatedLock = lockText;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    updatedLock = updatedLock.slice(0, edit.start) + edit.replacement + updatedLock.slice(edit.end);
  const oldVersion = previousVersion ?? members.values().next().value?.version;
  if (!oldVersion) throw new Error("Workspace has no captured version.");
  updatedLock = updateUvLockRequirements(updatedLock, members, oldVersion, nextVersion);
  if (updatedLock !== lockText) output.set("uv.lock", updatedLock);
  return output;
}
