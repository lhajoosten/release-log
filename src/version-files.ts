import { getStaticTOMLValue, parseTOML, traverseNodes } from "toml-eslint-parser";
import type { AST } from "toml-eslint-parser";
import type { ReleasePlan } from "./release-plan.ts";

export class VersionFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionFilesError";
  }
}

export interface VersionFileUpdate {
  readonly version: string;
  readonly content: string;
}

function expectedVersion(
  value: unknown,
  plan: ReleasePlan,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (plan.currentVersion !== null
      ? value !== plan.currentVersion
      : !["0.0.0", "0.1.0"].includes(value))
  )
    throw new VersionFilesError(
      `${label} must match the captured current version (or 0.0.0/0.1.0 during explicit bootstrap).`,
    );
}

export function updatePackageVersion(source: string, plan: ReleasePlan): VersionFileUpdate {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new VersionFilesError("The root package.json must be valid JSON.");
  }
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest))
    throw new VersionFilesError("The root package.json requires a string version.");
  expectedVersion(manifest.version, plan, "package.json version");
  const tokens = [
    ...source.matchAll(
      /"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu,
    ),
  ];
  let depth = 0;
  const versions: { start: number; end: number }[] = [];
  for (const [index, token] of tokens.entries()) {
    const value = token[0];
    if (value === "{" || value === "[") depth++;
    else if (value === "}" || value === "]") depth--;
    else if (
      depth === 1 &&
      value.startsWith('"') &&
      JSON.parse(value) === "version" &&
      tokens[index + 1]?.[0] === ":"
    ) {
      const version = tokens[index + 2];
      if (!version) throw new VersionFilesError("Missing package version token.");
      versions.push({ start: version.index, end: version.index + version[0].length });
    }
  }
  const target = versions[0];
  if (versions.length !== 1 || !target)
    throw new VersionFilesError("The root package.json must have exactly one version property.");
  return {
    version: manifest.version,
    content:
      plan.nextVersion === null
        ? source
        : source.slice(0, target.start) +
          JSON.stringify(plan.nextVersion) +
          source.slice(target.end),
  };
}

function keyPath(node: AST.TOMLKeyValue): readonly (string | number)[] {
  const keys = getStaticTOMLValue(node.key);
  if (node.parent.type === "TOMLTable") return [...node.parent.resolvedKey, ...keys];
  if (node.parent.type === "TOMLTopLevelTable") return keys;
  if (node.parent.parent.type === "TOMLKeyValue") return [...keyPath(node.parent.parent), ...keys];
  return [];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function updatePyprojectVersion(source: string, plan: ReleasePlan): VersionFileUpdate {
  let ast: ReturnType<typeof parseTOML>;
  try {
    ast = parseTOML(source);
  } catch {
    throw new VersionFilesError("The root pyproject.toml must be valid TOML.");
  }
  const data = getStaticTOMLValue(ast);
  if (
    record(data.project) &&
    Array.isArray(data.project.dynamic) &&
    data.project.dynamic.includes("version")
  )
    throw new VersionFilesError(
      "Dynamic Python versions are unsupported; configure a static project.version or tool.poetry.version without executing a backend.",
    );
  const changes: { start: number; end: number; replacement: string }[] = [];
  let capturedVersion: string | undefined;
  traverseNodes(ast, {
    enterNode(node) {
      if (node.type !== "TOMLKeyValue") return;
      const path = keyPath(node);
      if (
        JSON.stringify(path) !== '["project","version"]' &&
        JSON.stringify(path) !== '["tool","poetry","version"]'
      )
        return;
      const value = getStaticTOMLValue(node.value);
      expectedVersion(value, plan, `pyproject.toml ${path.join(".")}`);
      if (capturedVersion !== undefined && capturedVersion !== value)
        throw new VersionFilesError("Python version fields disagree; align them before planning.");
      capturedVersion = value;
      if (node.value.type !== "TOMLValue" || node.value.kind !== "string")
        throw new VersionFilesError("Python versions must be static string literals.");
      const [start, end] = node.value.range;
      const raw = source.slice(start, end);
      const quote = raw.startsWith('"""') ? '"""' : raw.startsWith("'''") ? "'''" : raw[0];
      if (!quote) throw new VersionFilesError("Missing TOML version string delimiter.");
      changes.push({ start, end, replacement: `${quote}${plan.nextVersion}${quote}` });
    },
    leaveNode() {},
  });
  if (!changes.length || capturedVersion === undefined)
    throw new VersionFilesError(
      "pyproject.toml requires static project.version or tool.poetry.version; dynamic/backend-derived versions are not inferred.",
    );
  if (plan.nextVersion === null) return { version: capturedVersion, content: source };
  let result = source;
  for (const change of changes.toSorted((a, b) => b.start - a.start))
    result = result.slice(0, change.start) + change.replacement + result.slice(change.end);
  return { version: capturedVersion, content: result };
}
