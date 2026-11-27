import { getStaticTOMLValue, parseTOML, traverseNodes } from "toml-eslint-parser";
import { keyPath, record } from "./version-adapters.ts";

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");

function updateConstraint(value: string, previous: string, next: string): string {
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marker = value.indexOf(";");
  const requirement = marker < 0 ? value : value.slice(0, marker);
  return (
    requirement.replace(new RegExp(`(?<![0-9A-Za-z.])${escaped}(?![0-9A-Za-z.])`, "gu"), next) +
    (marker < 0 ? "" : value.slice(marker))
  );
}

export function uvSources(source: string): ReadonlyMap<string, unknown> {
  const ast = parseTOML(source);
  const data: unknown = getStaticTOMLValue(ast);
  const uv = record(data) && record(data.tool) && record(data.tool.uv) ? data.tool.uv : {};
  const sources = record(uv.sources) ? uv.sources : {};
  return new Map(Object.entries(sources).map(([name, value]) => [normalize(name), value]));
}

/** Change version specifiers only for uv dependencies explicitly sourced from this workspace. */
export function updateUvRequirements(
  source: string,
  memberNames: ReadonlySet<string>,
  previous: string,
  next: string,
  inheritedSources: ReadonlyMap<string, unknown> = new Map(),
): string {
  const sources = new Map([...inheritedSources, ...uvSources(source)]);
  const local = new Set(
    [...sources]
      .filter(([, value]) => record(value) && value.workspace === true)
      .map(([name]) => name),
  );
  for (const name of local)
    if (!memberNames.has(name)) throw new Error(`Unknown uv workspace dependency: ${name}`);
  return updateProjectRequirements(source, local, previous, next);
}

/** Change only requirements whose names have a verified local source. */
export function updateProjectRequirements(
  source: string,
  local: ReadonlySet<string>,
  previous: string,
  next: string,
): string {
  const ast = parseTOML(source);
  const edits: { start: number; end: number; text: string }[] = [];
  traverseNodes(ast, {
    enterNode(node) {
      if (node.type !== "TOMLKeyValue" || node.value.type !== "TOMLArray") return;
      const path = keyPath(node);
      if (
        !(
          path[0] === "project" &&
          (path[1] === "dependencies" || path[1] === "optional-dependencies")
        ) &&
        path[0] !== "dependency-groups"
      )
        return;
      for (const item of node.value.elements) {
        if (item.type !== "TOMLValue" || item.kind !== "string") continue;
        const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(item.value);
        if (!match?.[1] || !local.has(normalize(match[1]))) continue;
        const raw = source.slice(...item.range);
        const changed = updateConstraint(raw, previous, next);
        if (changed !== raw)
          edits.push({ start: item.range[0], end: item.range[1], text: changed });
      }
    },
    leaveNode() {},
  });
  let result = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Update lock metadata only when an editable/virtual source identifies a workspace member. */
export function updateUvLockRequirements(
  source: string,
  members: ReadonlyMap<string, { path: string }>,
  previous: string,
  next: string,
): string {
  const ast = parseTOML(source);
  const edits: { start: number; end: number; text: string }[] = [];
  traverseNodes(ast, {
    enterNode(node) {
      if (node.type !== "TOMLKeyValue" || node.value.type !== "TOMLArray") return;
      const path = keyPath(node);
      if (path[0] !== "package" || path[2] !== "metadata" || path[3] !== "requires-dist") return;
      for (const item of node.value.elements) {
        if (item.type !== "TOMLInlineTable") continue;
        const data: unknown = getStaticTOMLValue(item);
        if (!record(data) || typeof data.name !== "string") continue;
        const member = members.get(normalize(data.name));
        if (!member || (data.editable !== member.path && data.virtual !== member.path)) continue;
        for (const property of item.body) {
          if (
            JSON.stringify(getStaticTOMLValue(property.key)) !== '["specifier"]' ||
            property.value.type !== "TOMLValue" ||
            property.value.kind !== "string"
          )
            continue;
          const raw = source.slice(...property.value.range),
            changed = updateConstraint(raw, previous, next);
          if (changed !== raw)
            edits.push({
              start: property.value.range[0],
              end: property.value.range[1],
              text: changed,
            });
        }
      }
    },
    leaveNode() {},
  });
  let result = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
