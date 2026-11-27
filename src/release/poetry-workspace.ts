import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getStaticTOMLValue, parseTOML, traverseNodes } from "toml-eslint-parser";
import { updateProjectRequirements } from "./python-requirements.ts";
import { keyPath, record, updatePyprojectVersion } from "./version-adapters.ts";

const normalized = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");
function containsPathDependency(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPathDependency);
  return (
    record(value) &&
    (typeof value.path === "string" || Object.values(value).some(containsPathDependency))
  );
}
function pythonJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index++)
      if (value.charCodeAt(index) > 127)
        throw new Error("Non-ASCII Poetry lock metadata is unsupported.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (!record(value)) throw new Error("Unsupported Poetry metadata in lock hash.");
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${pythonJson(key)}: ${pythonJson(value[key])}`)
    .join(", ")}}`;
}
function hash(data: Record<string, unknown>): string {
  const project = record(data.project) ? data.project : {};
  const poetry = record(data.tool) && record(data.tool.poetry) ? data.tool.poetry : {};
  const projectPart: Record<string, unknown> = {};
  for (const key of ["requires-python", "dependencies", "optional-dependencies"])
    if (project[key] !== undefined) projectPart[key] = project[key];
  const poetryPart: Record<string, unknown> = {};
  for (const key of ["dependencies", "source", "extras", "dev-dependencies", "group"]) {
    if (poetry[key] !== undefined) poetryPart[key] = poetry[key];
    else if (key !== "group" && !Object.keys(projectPart).length) poetryPart[key] = null;
  }
  const value = Object.keys(projectPart).length
    ? { project: projectPart, tool: { poetry: poetryPart } }
    : poetryPart;
  return createHash("sha256").update(pythonJson(value)).digest("hex");
}

/** Supports static Poetry 2.1 lockfiles with direct, in-repository path projects. */
export async function planPoetryWorkspace(
  root: string,
  previousVersion: string | null,
  nextVersion: string,
): Promise<ReadonlyMap<string, string> | null> {
  const manifest = await readFile(join(root, "pyproject.toml"), "utf8");
  const data: unknown = getStaticTOMLValue(parseTOML(manifest));
  if (!record(data)) throw new Error("Invalid Python manifest.");
  const lockPath = join(root, "poetry.lock");
  try {
    if ((await lstat(lockPath)).isSymbolicLink())
      throw new Error("poetry.lock must not be a symlink.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const poetry = record(data.tool) && record(data.tool.poetry) ? data.tool.poetry : {};
  const dependencies = record(poetry.dependencies) ? poetry.dependencies : {};
  if (containsPathDependency(poetry.group) || containsPathDependency(poetry["dev-dependencies"]))
    throw new Error("Poetry path dependencies in dependency groups are unsupported.");
  if (
    Object.values(dependencies).some(
      (value) => Array.isArray(value) && containsPathDependency(value),
    )
  )
    throw new Error("Conditional Poetry path dependencies are unsupported.");
  const local = Object.entries(dependencies).filter(
    ([, value]) => record(value) && typeof value.path === "string",
  );
  const rootUpdate = updatePyprojectVersion(manifest, {
    currentVersion: previousVersion,
    nextVersion,
  });
  const files = new Map<string, string>();
  const updatedManifest = updateProjectRequirements(
    rootUpdate.content,
    new Set(local.map(([name]) => normalized(name))),
    rootUpdate.version,
    nextVersion,
  );
  if (updatedManifest !== manifest) files.set("pyproject.toml", updatedManifest);
  const members = new Map<string, { path: string; version: string }>();
  for (const [name, dependency] of local) {
    if (!record(dependency) || typeof dependency.path !== "string")
      throw new Error("Invalid Poetry path dependency.");
    const path = dependency.path.replace(/^\.\//u, "");
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe Poetry path dependency.");
    let location = root;
    for (const part of [...path.split("/"), "pyproject.toml"]) {
      location = join(location, part);
      if ((await lstat(location)).isSymbolicLink())
        throw new Error("Poetry path dependency traverses a symlink.");
    }
    const text = await readFile(location, "utf8");
    const memberData: unknown = getStaticTOMLValue(parseTOML(text));
    if (!record(memberData)) throw new Error("Invalid Poetry path package.");
    const memberPoetry =
      record(memberData.tool) && record(memberData.tool.poetry) ? memberData.tool.poetry : {};
    const memberName =
      record(memberData.project) && typeof memberData.project.name === "string"
        ? memberData.project.name
        : memberPoetry.name;
    if (
      typeof memberName !== "string" ||
      normalized(memberName) !== normalized(name) ||
      members.has(normalized(name))
    )
      throw new Error("Poetry path package name mismatch or duplicate.");
    if (
      record(memberPoetry.dependencies) &&
      Object.values(memberPoetry.dependencies).some(
        (value) => record(value) && typeof value.path === "string",
      )
    )
      throw new Error("Nested Poetry path dependencies are unsupported.");
    const update = updatePyprojectVersion(text, { currentVersion: previousVersion, nextVersion });
    members.set(normalized(name), { path, version: update.version });
    if (update.content !== text) files.set(`${path}/pyproject.toml`, update.content);
  }
  const lockText = await readFile(lockPath, "utf8"),
    ast = parseTOML(lockText);
  const lock: unknown = getStaticTOMLValue(ast);
  if (
    !record(lock) ||
    !record(lock.metadata) ||
    lock.metadata["lock-version"] !== "2.1" ||
    lock.metadata["content-hash"] !== hash(data) ||
    !Array.isArray(lock.package)
  )
    throw new Error("Poetry 2.1 lock is stale or unsupported.");
  const found = new Set<string>();
  const edits: { start: number; end: number; replacement: string }[] = [];
  for (const [index, entry] of lock.package.entries()) {
    if (!record(entry) || typeof entry.name !== "string")
      throw new Error("Malformed Poetry lock package.");
    const name = normalized(entry.name),
      member = members.get(name);
    if (!member || !record(entry.source) || entry.source.type !== "directory") {
      if (!member && record(entry.source) && entry.source.type === "directory")
        throw new Error("Unrecognized Poetry directory package.");
      continue;
    }
    if (found.has(name) || entry.source.url !== member.path || entry.version !== member.version)
      throw new Error(`Poetry lock does not match ${name}.`);
    found.add(name);
    const table = ast.body[0].body.find(
      (node) =>
        node.type === "TOMLTable" &&
        node.kind === "array" &&
        node.resolvedKey[0] === "package" &&
        node.resolvedKey[1] === index,
    );
    if (table?.type !== "TOMLTable") throw new Error("Malformed Poetry lock table.");
    const value = table.body.find(
      (node) => JSON.stringify(getStaticTOMLValue(node.key)) === '["version"]',
    )?.value;
    if (value?.type !== "TOMLValue" || value.kind !== "string")
      throw new Error("Poetry lock package lacks version.");
    const [start, end] = value.range,
      quote = lockText[start];
    if (quote !== "'" && quote !== '"') throw new Error("Unsupported Poetry version quote.");
    edits.push({ start, end, replacement: `${quote}${nextVersion}${quote}` });
  }
  if (found.size !== members.size) throw new Error("Poetry lock omits path projects.");
  let updated = lockText;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  const newData: unknown = getStaticTOMLValue(parseTOML(updatedManifest));
  if (!record(newData)) throw new Error("Invalid updated Poetry manifest.");
  const updatedHash = hash(newData);
  if (updatedHash !== lock.metadata["content-hash"]) {
    const parsed = parseTOML(updated);
    let hashRange: readonly [number, number] | undefined;
    traverseNodes(parsed, {
      enterNode(node) {
        if (
          node.type === "TOMLKeyValue" &&
          JSON.stringify(keyPath(node)) === '["metadata","content-hash"]' &&
          node.value.type === "TOMLValue" &&
          node.value.kind === "string"
        )
          hashRange = node.value.range;
      },
      leaveNode() {},
    });
    if (!hashRange) throw new Error("Missing Poetry content hash token.");
    updated =
      updated.slice(0, hashRange[0]) + JSON.stringify(updatedHash) + updated.slice(hashRange[1]);
  }
  if (updated !== lockText) files.set("poetry.lock", updated);
  return files;
}
