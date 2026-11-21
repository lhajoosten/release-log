import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { record, VersionFilesError } from "./version-files.ts";
import type { VersionFileUpdate, VersionPlan } from "./version-files.ts";

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

function localReference(value: unknown): boolean {
  if (typeof value === "string") return /@\s*(?:file:|\.{1,2}[/\\]|[/\\])/iu.test(value);
  if (Array.isArray(value)) return value.some(localReference);
  return record(value) && Object.values(value).some(localReference);
}

function localUvSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(localUvSource);
  return record(value) && ("path" in value || "workspace" in value);
}

function malformedLock(): VersionFilesError {
  return new VersionFilesError(
    "uv.lock has malformed package entries. Regenerate and commit uv.lock before retrying.",
  );
}

export function updateUvLockVersion(
  manifest: string,
  source: string,
  python: VersionFileUpdate,
  plan: VersionPlan,
): string {
  // The caller has already validated the manifest's TOML and version.
  const projectData = getStaticTOMLValue(parseTOML(manifest));
  const project = projectData.project;
  if (
    !record(project) ||
    typeof project.name !== "string" ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(project.name) ||
    project.version !== python.version
  )
    throw new VersionFilesError(
      "uv.lock requires a root pyproject.toml with a static [project] name and version.",
    );

  const uv: unknown = record(projectData.tool) ? projectData.tool.uv : undefined;
  const sources: unknown = record(uv) ? uv.sources : undefined;
  if (
    (record(uv) && "workspace" in uv) ||
    (record(sources) && Object.values(sources).some(localUvSource)) ||
    [
      project.dependencies,
      project["optional-dependencies"],
      projectData["dependency-groups"],
      record(uv) ? uv["dev-dependencies"] : undefined,
    ].some(localReference)
  )
    throw new VersionFilesError(
      "uv.lock release updates require a single root project without uv workspaces or local path dependencies. Review the project configuration before retrying.",
    );

  let ast: ReturnType<typeof parseTOML>;
  try {
    ast = parseTOML(source);
  } catch {
    throw new VersionFilesError(
      "uv.lock must be valid TOML. Regenerate and commit uv.lock before retrying.",
    );
  }

  const lock = getStaticTOMLValue(ast);
  if (
    lock.version !== 1 ||
    (lock.revision !== undefined &&
      (typeof lock.revision !== "number" || ![0, 1, 2, 3, 4, 5].includes(lock.revision)))
  )
    throw new VersionFilesError(
      "Unsupported uv.lock format. Use a lockfile with format version 1 and a supported revision (0–5 or absent).",
    );
  if ("members" in lock || (record(lock.manifest) && "members" in lock.manifest))
    throw new VersionFilesError(
      "uv.lock workspace members are unsupported. Release updates require a single root project.",
    );

  const packages: unknown = lock.package;
  if (!Array.isArray(packages)) throw malformedLock();

  const name = normalizeName(project.name);
  const roots: number[] = [];
  for (const [index, entry] of packages.entries()) {
    if (!record(entry) || typeof entry.name !== "string" || !record(entry.source))
      throw malformedLock();
    const [kind, ...extra] = Object.keys(entry.source);
    const location = kind === undefined ? undefined : entry.source[kind];
    if (extra.length || typeof location !== "string") throw malformedLock();

    if (
      (kind === "editable" || kind === "virtual") &&
      location === "." &&
      normalizeName(entry.name) === name
    ) {
      roots.push(index);
    } else if (
      (kind !== "registry" && kind !== "git" && kind !== "url") ||
      !/^(?!file:)[a-z][a-z0-9+.-]*:\/\//iu.test(location)
    ) {
      throw new VersionFilesError(
        "uv.lock contains a local or unsupported package source outside the matching root entry. Review workspace and path dependencies before retrying.",
      );
    }
  }

  const [index] = roots;
  if (roots.length !== 1 || index === undefined)
    throw new VersionFilesError(
      "uv.lock must contain exactly one matching root project entry with source virtual or editable at '.'. Regenerate and commit uv.lock before retrying.",
    );

  const table = ast.body[0].body.find(
    (node) =>
      node.type === "TOMLTable" &&
      node.kind === "array" &&
      node.resolvedKey.length === 2 &&
      node.resolvedKey[0] === "package" &&
      node.resolvedKey[1] === index,
  );
  if (table?.type !== "TOMLTable") throw malformedLock();
  const version = table.body.find((node) => {
    const key = getStaticTOMLValue(node.key);
    return key.length === 1 && key[0] === "version";
  })?.value;
  if (version?.type !== "TOMLValue" || version.kind !== "string") throw malformedLock();
  if (version.value !== python.version)
    throw new VersionFilesError(
      "uv.lock root version disagrees with pyproject.toml. Regenerate and commit uv.lock before retrying.",
    );

  if (plan.nextVersion === null || plan.nextVersion === version.value) return source;

  const [start, end] = version.range;
  const raw = source.slice(start, end);
  const quote = raw.startsWith('"""') ? '"""' : raw.startsWith("'''") ? "'''" : raw[0];
  return source.slice(0, start) + quote + plan.nextVersion + quote + source.slice(end);
}
