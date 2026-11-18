import { posix } from "node:path";
import { getStaticTOMLValue, parseTOML, traverseNodes } from "toml-eslint-parser";
import { VersionFilesError, expectedVersion, keyPath, record } from "./version-files.ts";
import type { VersionPlan } from "./version-files.ts";

import { isCargoManifest, maxCargoMembers } from "./proposal-paths.ts";
import type { CargoPath } from "./proposal-paths.ts";

export type CargoContents = Readonly<Partial<Record<CargoPath, string | null>>>;

function manifest(source: string, path: CargoPath) {
  try {
    const ast = parseTOML(source);
    return { ast, data: getStaticTOMLValue(ast) };
  } catch {
    throw new VersionFilesError(`${path} must be valid TOML.`);
  }
}

function unsupported(detail: string): never {
  throw new VersionFilesError(`Unsupported Cargo release layout: ${detail}.`);
}

export function cargoMemberPaths(source: string): readonly CargoPath[] {
  const { workspace } = manifest(source, "Cargo.toml").data;
  if (workspace === undefined) return [];
  if (!record(workspace)) unsupported("workspace must be a TOML table");
  const { members = [], exclude = [] } = workspace;
  if (
    !Array.isArray(members) ||
    members.length > maxCargoMembers ||
    !Array.isArray(exclude) ||
    exclude.length !== 0
  )
    unsupported("use a bounded explicit workspace.members list without exclusions");
  const paths = members.map((member: unknown) => {
    if (typeof member !== "string") unsupported("workspace members must be directory names");
    const path = `${member}/Cargo.toml`;
    if (!isCargoManifest(path))
      unsupported("list explicit repository-relative workspace member directories without globs");
    return path;
  });
  if (new Set(paths).size !== paths.length)
    unsupported("workspace member directories must be unique");
  return paths.toSorted();
}

export async function readCargoContents(
  get: (path: CargoPath) => Promise<string | null>,
): Promise<CargoContents> {
  const root = await get("Cargo.toml");
  if (root === null) return {};
  const entries: [CargoPath, string | null][] = [
    ["Cargo.toml", root],
    ["Cargo.lock", await get("Cargo.lock")],
  ];
  for (const path of cargoMemberPaths(root)) entries.push([path, await get(path)]);
  return Object.fromEntries(entries);
}

type AST = ReturnType<typeof parseTOML>;
type Replacement = { start: number; end: number; value: string };

function rewrite(
  source: string,
  ast: AST,
  replacement: (path: readonly (string | number)[], value: string) => string | undefined,
): string {
  const changes: Replacement[] = [];
  traverseNodes(ast, {
    enterNode(node) {
      if (node.type !== "TOMLKeyValue") return;
      const path = keyPath(node);
      const values = node.value.type === "TOMLArray" ? node.value.elements : [node.value];
      for (const [index, token] of values.entries()) {
        if (token.type !== "TOMLValue" || token.kind !== "string") continue;
        const value = replacement(
          node.value.type === "TOMLArray" ? [...path, index] : path,
          token.value,
        );
        if (value === undefined || value === token.value) continue;
        const [start, end] = token.range;
        const raw = source.slice(start, end);
        const quote = raw.startsWith('"""') || raw.startsWith("'''") ? raw.slice(0, 3) : raw[0];
        changes.push({ start, end, value: `${quote}${value}${quote}` });
      }
    },
    leaveNode() {},
  });
  let result = source;
  for (const { start, end, value } of changes.toSorted((a, b) => b.start - a.start))
    result = result.slice(0, start) + value + result.slice(end);
  return result;
}

const dependencyKinds = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "dev_dependencies",
  "build_dependencies",
];

function dependencyTables(data: Record<string, unknown>) {
  const sections = [{ prefix: [] as string[], table: data }];
  if (record(data.workspace)) sections.push({ prefix: ["workspace"], table: data.workspace });
  if (record(data.target))
    for (const [target, table] of Object.entries(data.target))
      if (record(table)) sections.push({ prefix: ["target", target], table });
  return sections;
}

export function updateCargoVersions(contents: CargoContents, plan: VersionPlan) {
  const root = contents["Cargo.toml"];
  if (root == null) return null;
  const paths = ["Cargo.toml", ...cargoMemberPaths(root)] as const;
  const manifests = paths.map((path) => {
    const source = contents[path];
    if (source == null) return unsupported(`provide the tracked member manifest ${path}`);
    return { path, source, ...manifest(source, path) };
  });
  const rootData = manifests[0]?.data ?? {};
  const workspace = record(rootData.workspace) ? rootData.workspace : null;
  const versionKey = workspace ? ["workspace", "package", "version"] : ["package", "version"];
  const versionTable = workspace ? workspace.package : rootData.package;
  const version = record(versionTable) ? versionTable.version : undefined;
  expectedVersion(version, plan, `Cargo.toml ${versionKey.join(".")}`);
  const packages = new Map<string, string>();
  for (const { path, data } of manifests) {
    if (path === "Cargo.toml" && workspace && data.package === undefined) continue;
    const pkg = data.package;
    if (!record(pkg) || typeof pkg.name !== "string" || !/^[A-Za-z0-9_-]+$/u.test(pkg.name))
      unsupported(`${path} requires a static package.name`);
    if (
      pkg.workspace !== undefined ||
      (path !== "Cargo.toml" && data.workspace !== undefined) ||
      (workspace && (!record(pkg.version) || pkg.version.workspace !== true))
    )
      unsupported(
        `${path} must inherit the shared workspace version without a separate workspace root`,
      );
    if ([...packages.values()].includes(pkg.name))
      unsupported(`workspace package name ${pkg.name} is ambiguous`);
    packages.set(posix.dirname(path), pkg.name);
  }
  if (packages.size === 0) unsupported("the workspace must contain at least one package");

  const next = plan.nextVersion ?? version;
  const files = manifests.flatMap(({ path, source, ast, data }) => {
    if (data.patch !== undefined || data.replace !== undefined)
      unsupported(`${path} uses Cargo patch or replace overrides`);
    const updates = new Map<string, string>();
    if (path === "Cargo.toml") updates.set(JSON.stringify(versionKey), next);
    for (const { prefix, table } of dependencyTables(data)) {
      for (const kind of dependencyKinds) {
        const dependencies = table[kind];
        if (!record(dependencies)) continue;
        for (const [alias, dep] of Object.entries(dependencies)) {
          if (!record(dep) || dep.path === undefined) continue;
          if (
            typeof dep.path !== "string" ||
            !/^(?:(?:\.\.?\/)*)((?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\/?|\.)$/u.test(
              dep.path,
            )
          )
            unsupported(
              `${path} dependency ${alias} needs a relative path to a managed workspace package`,
            );
          const name = packages.get(
            posix.normalize(posix.join(posix.dirname(path), dep.path)).replace(/\/$/u, ""),
          );
          if (name !== (dep.package ?? alias))
            unsupported(
              `${path} dependency ${alias} must point to an explicitly managed package with a matching name`,
            );
          if (dep.version === undefined) continue;
          const requirement =
            typeof dep.version === "string"
              ? /^([ \t]*[=~^]?[ \t]*)(\d+\.\d+\.\d+)([ \t]*)$/u.exec(dep.version)
              : null;
          if (!requirement || requirement[2] !== version)
            unsupported(
              `${path} dependency ${alias} needs a simple version requirement matching ${version}`,
            );
          updates.set(
            JSON.stringify([...prefix, kind, alias, "version"]),
            `${requirement[1]}${next}${requirement[3]}`,
          );
        }
      }
    }
    const after = rewrite(source, ast, (key) => updates.get(JSON.stringify(key)));
    return path === "Cargo.toml" || after !== source ? [{ path, before: source, after }] : [];
  });

  const lock = contents["Cargo.lock"];
  if (lock != null) {
    const { ast, data } = manifest(lock, "Cargo.lock");
    const names = new Set(packages.values());
    const indices = new Set<number>();
    const found = new Set<string>();
    if ((data.version !== 3 && data.version !== 4) || !Array.isArray(data.package))
      unsupported("Cargo.lock must use lockfile format 3 or 4 with package entries");
    const entries: unknown[] = data.package;
    for (const [index, pkg] of entries.entries()) {
      if (!record(pkg) || typeof pkg.name !== "string" || typeof pkg.version !== "string")
        unsupported("Cargo.lock has an invalid package entry");
      if (!names.has(pkg.name)) continue;
      if (pkg.source !== undefined) {
        if (next !== version && pkg.version === next)
          unsupported(
            `Cargo.lock already resolves an external ${pkg.name} at the proposed version ${next}`,
          );
        continue;
      }
      if (pkg.version !== version || found.has(pkg.name))
        unsupported(`Cargo.lock needs one local ${pkg.name} entry at ${version}`);
      indices.add(index);
      found.add(pkg.name);
    }
    if (found.size !== names.size)
      unsupported("Cargo.lock is missing managed local packages; refresh it before releasing");
    const after = rewrite(lock, ast, ([table, index, key, element], value) => {
      if (table !== "package" || typeof index !== "number") return undefined;
      if (key === "version" && indices.has(index)) return next;
      if (key === "dependencies" && typeof element === "number") {
        const [name, from, source] = value.split(" ");
        if (name && names.has(name) && from === version && source === undefined)
          return `${name} ${next}`;
      }
      return undefined;
    });
    files.push({ path: "Cargo.lock", before: lock, after });
  }
  return { version, files };
}
