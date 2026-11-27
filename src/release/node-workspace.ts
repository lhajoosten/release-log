import { glob, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { jsonPropertyRange, record, updatePackageVersion } from "./version-adapters.ts";

async function readRootFile(root: string, path: string): Promise<string> {
  const target = join(root, path);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe workspace input: ${path}`);
  return readFile(target, "utf8");
}

function object(source: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!record(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

// Bun's text lockfile is JSON with comments and optional trailing commas.
function bunJson(source: string): Record<string, unknown> {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    const next = source[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      result += "\n";
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated Bun lockfile comment.");
      index = end + 1;
      result += " ";
    } else if (char === ",") {
      let look = index + 1;
      while (/\s/u.test(source[look] ?? " ") && look < source.length) look++;
      if (source[look] !== "]" && source[look] !== "}") result += char;
    } else result += char;
  }
  return object(result, "bun.lock");
}

function replaceProperty(source: string, key: string, value: string, label: string): string {
  const range = jsonPropertyRange(source, key, label);
  if (!range) throw new Error(`${label} is missing ${key}.`);
  return source.slice(0, range.start) + value + source.slice(range.end);
}

function rangeVersion(value: string, previous: string, next: string): string {
  if (
    ["workspace:*", "workspace:^", "workspace:~", "*"].includes(value) ||
    value.startsWith("file:") ||
    value.startsWith("link:")
  )
    return value;
  const match = /^(workspace:)?([~^]?)(.+)$/u.exec(value);
  if (!match || match[3] !== previous)
    throw new Error(`Unsupported local dependency version: ${value}`);
  return `${match[1] ?? ""}${match[2] ?? ""}${next}`;
}

/** Update a shared Node workspace. Return null when the root is not a workspace. */
export async function planNodeWorkspace(
  root: string,
  previous: string | null,
  next: string,
): Promise<ReadonlyMap<string, string> | null> {
  let source: string;
  try {
    source = await readRootFile(root, "package.json");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const manifest = object(source, "package.json");
  let patterns: unknown = manifest.workspaces;
  if (record(patterns)) patterns = patterns.packages;
  let pnpm: string | null = null;
  try {
    pnpm = await readRootFile(root, "pnpm-workspace.yaml");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (pnpm !== null) {
    const yaml: unknown = parseYaml(pnpm);
    if (!record(yaml)) throw new Error("Invalid pnpm workspace configuration.");
    if (
      patterns !== undefined &&
      yaml.packages !== undefined &&
      JSON.stringify(patterns) !== JSON.stringify(yaml.packages)
    )
      throw new Error("Conflicting workspace definitions.");
    patterns ??= yaml.packages;
  }
  if (patterns === undefined) {
    try {
      await lstat(join(root, "bun.lock"));
      patterns = [];
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (patterns === undefined) return null;
  if (
    !Array.isArray(patterns) ||
    patterns.some(
      (value: unknown) =>
        typeof value !== "string" ||
        value.startsWith("!") ||
        value.startsWith("/") ||
        value.split("/").includes(".."),
    )
  )
    throw new Error("Unsupported workspace member patterns.");
  if (previous === null) {
    if (manifest.version !== "0.0.0" && manifest.version !== "0.1.0")
      throw new Error("Workspace bootstrap requires a 0.0.0 or 0.1.0 manifest version.");
    previous = manifest.version;
  }
  const paths = new Set<string>(["package.json"]);
  for (const pattern of patterns) {
    if (typeof pattern !== "string") throw new Error("Invalid workspace pattern.");
    if (pattern === ".") continue;
    let matched = false;
    for await (const path of glob(`${pattern}/package.json`, { cwd: root })) {
      if (path.split("/").includes("node_modules")) continue;
      let current = root;
      for (const segment of path.split("/")) {
        current = join(current, segment);
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`Workspace path is a symlink: ${path}`);
      }
      paths.add(path);
      matched = true;
      if (paths.size > 1000) throw new Error("Too many workspace packages.");
    }
    if (!matched) throw new Error(`Workspace pattern matches no package: ${pattern}`);
  }
  const files = new Map<string, string>();
  const members = new Map<string, { source: string; data: Record<string, unknown> }>();
  for (const path of [...paths].toSorted()) {
    const content = path === "package.json" ? source : await readFile(join(root, path), "utf8");
    const data = object(content, path);
    if (typeof data.name !== "string" || !data.name || members.has(data.name))
      throw new Error(`Missing or duplicate package name in ${path}.`);
    members.set(data.name, { source: content, data });
  }
  for (const path of [...paths].toSorted()) {
    const content = path === "package.json" ? source : await readFile(join(root, path), "utf8");
    const data = object(content, path);
    let updated = updatePackageVersion(content, {
      currentVersion: previous,
      nextVersion: next,
    }).content;
    for (const key of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = data[key];
      if (dependencies === undefined) continue;
      if (!record(dependencies)) throw new Error(`Invalid ${key} in ${path}.`);
      const field = jsonPropertyRange(updated, key, path);
      if (!field) throw new Error(`Missing ${key} in ${path}.`);
      let section = updated.slice(field.start, field.end);
      for (const [name, value] of Object.entries(dependencies)) {
        if (!members.has(name)) continue;
        if (typeof value !== "string") throw new Error(`Invalid local dependency ${name}.`);
        section = replaceProperty(
          section,
          name,
          JSON.stringify(rangeVersion(value, previous, next)),
          path,
        );
      }
      updated = updated.slice(0, field.start) + section + updated.slice(field.end);
    }
    if (updated !== content) files.set(path, updated);
  }
  let npmLock: string | null = null;
  let bunLock = false;
  for (const lockPath of ["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb"]) {
    let info;
    try {
      info = await lstat(join(root, lockPath));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe lockfile: ${lockPath}`);
    if (lockPath === "bun.lockb")
      throw new Error("Binary bun.lockb is unsupported; migrate to bun.lock first.");
    if (lockPath === "bun.lock") {
      bunLock = true;
      continue;
    }
    if (npmLock !== null) throw new Error("Only one npm lockfile is supported.");
    npmLock = lockPath;
  }
  if (bunLock) {
    const lock = bunJson(await readFile(join(root, "bun.lock"), "utf8"));
    if (![1, 2].includes(Number(lock.lockfileVersion)) || !record(lock.workspaces))
      throw new Error("Unsupported Bun lockfile.");
    for (const path of paths) {
      const key = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
      const entry = lock.workspaces[key];
      if (!record(entry)) throw new Error(`Missing Bun workspace entry ${key}.`);
      if (entry.version !== undefined) {
        if (entry.version !== previous) throw new Error(`Stale Bun workspace entry ${key}.`);
        entry.version = next;
      }
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const deps = entry[field];
        if (deps === undefined) continue;
        if (!record(deps)) throw new Error("Invalid Bun dependencies.");
        for (const [name, value] of Object.entries(deps)) {
          if (!members.has(name)) continue;
          if (typeof value !== "string") throw new Error(`Invalid Bun local dependency ${name}.`);
          deps[name] = rangeVersion(value, previous, next);
        }
      }
    }
    files.set("bun.lock", `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (npmLock !== null) {
    const lock = object(await readFile(join(root, npmLock), "utf8"), npmLock);
    if (
      ![2, 3].includes(Number(lock.lockfileVersion)) ||
      lock.version !== previous ||
      !record(lock.packages)
    )
      throw new Error(`Invalid or stale ${npmLock}.`);
    lock.version = next;
    for (const path of paths) {
      const key = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
      const entry = lock.packages[key];
      if (!record(entry) || entry.version !== previous)
        throw new Error(`Missing or stale ${npmLock} workspace entry ${key}.`);
      entry.version = next;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const deps = entry[field];
        if (deps === undefined) continue;
        if (!record(deps)) throw new Error(`Invalid ${npmLock} dependencies.`);
        for (const [name, value] of Object.entries(deps)) {
          if (!members.has(name)) continue;
          if (typeof value !== "string")
            throw new Error(`Invalid ${npmLock} local dependency ${name}.`);
          deps[name] = rangeVersion(value, previous, next);
        }
      }
    }
    if (lock.lockfileVersion === 2 && record(lock.dependencies)) {
      for (const [name, legacy] of Object.entries(lock.dependencies)) {
        if (!members.has(name) || !record(legacy) || !record(legacy.requires)) continue;
        const link = lock.packages["node_modules/" + name];
        if (
          !record(link) ||
          link.link !== true ||
          typeof link.resolved !== "string" ||
          legacy.version !== "file:" + link.resolved
        )
          continue;
        for (const [dependency, range] of Object.entries(legacy.requires)) {
          if (!members.has(dependency)) continue;
          if (typeof range !== "string")
            throw new Error("Invalid workspace dependency mirror in " + npmLock);
          legacy.requires[dependency] = rangeVersion(range, previous, next);
        }
      }
    }
    files.set(npmLock, `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (pnpm !== null) {
    try {
      const lockSource = await readRootFile(root, "pnpm-lock.yaml");
      const lock: unknown = parseYaml(lockSource);
      if (!record(lock) || !record(lock.importers)) throw new Error("Invalid pnpm lockfile.");
      let lockChanged = false;
      for (const [key, importer] of Object.entries(lock.importers)) {
        if (!record(importer)) throw new Error("Invalid pnpm importer.");
        for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
          const deps = importer[field];
          if (deps === undefined) continue;
          if (!record(deps)) throw new Error("Invalid pnpm dependencies.");
          for (const [name, entry] of Object.entries(deps)) {
            if (!members.has(name)) continue;
            if (
              !record(entry) ||
              typeof entry.specifier !== "string" ||
              typeof entry.version !== "string" ||
              !entry.version.startsWith("link:")
            )
              throw new Error(`Invalid pnpm local lock entry ${name} in ${key}.`);
            const updatedSpecifier = rangeVersion(entry.specifier, previous, next);
            lockChanged ||= updatedSpecifier !== entry.specifier;
            entry.specifier = updatedSpecifier;
          }
        }
      }
      if (lockChanged) files.set("pnpm-lock.yaml", stringifyYaml(lock));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return files;
}
