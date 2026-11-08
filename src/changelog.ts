import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createReleasePlan } from "./release-plan.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import { replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export class ChangelogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangelogError";
  }
}

const maximumBytes = 16 * 1024 * 1024;
const endMarker = "<!-- release-log:pending:end -->";
const groups = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["revert", "Reverts"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["build", "Build"],
  ["ci", "Continuous integration"],
  ["test", "Tests"],
  ["style", "Style"],
  ["chore", "Maintenance"],
] as const;

function bounded(value: string): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes)
    throw new ChangelogError("Changelog exceeds 16 MiB in UTF-8.");
}

function escapeText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\p{P}\p{Cc}<>+=|~$^]/gu, (character) => `&#${character.codePointAt(0)};`);
}

export async function renderChangelog(
  serializedSnapshot: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
): Promise<string | null> {
  const plan = await createReleasePlan(serializedSnapshot, expected, version);
  if (!plan.release) return null;
  const snapshot = await replayReleaseSnapshot(serializedSnapshot, expected);
  const lines = [`## v${plan.nextVersion}`, ""];
  for (const [type, heading] of groups) {
    const entries = snapshot.normalized.pullRequests
      .filter((pull) => pull.title.type === type)
      .toSorted((left, right) => {
        const a = left.title.scope ?? "";
        const b = right.title.scope ?? "";
        return a < b ? -1 : a > b ? 1 : left.number - right.number;
      });
    if (!entries.length) continue;
    lines.push(`### ${heading}`, "");
    for (const pull of entries) {
      const label = pull.context.audience === "internal" ? " [internal]" : "";
      lines.push(
        `- **${escapeText(pull.title.scope ?? "")}**${label}: ${escapeText(pull.context.summary)} ([#${pull.number}](${pull.url}))`,
      );
      lines.push(`  - Impact: ${escapeText(pull.context.impact)}`);
      if (pull.title.breaking) {
        lines.push(`  - **Breaking change:** ${pull.breakingChanges.map(escapeText).join("; ")}`);
      }
      if (pull.context.requiredAction !== null)
        lines.push(`  - **Required action:** ${escapeText(pull.context.requiredAction)}`);
    }
    lines.push("");
  }
  const rendered = lines.join("\n");
  bounded(rendered);
  return rendered;
}

function generatedSection(content: string): string {
  if (
    !/^## v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n/u.test(content) ||
    content.includes("<!-- release-log:") ||
    !content.endsWith("\n")
  )
    throw new ChangelogError(
      "Expected rendered release content, not arbitrary owned-section markers.",
    );
  const digest = createHash("sha256").update(content).digest("hex");
  return `<!-- release-log:pending:v1 sha256:${digest} -->\n\n${content}\n${endMarker}\n`;
}

export function updateChangelog(existing: string, rendered: string | null): string {
  bounded(existing);
  if (rendered !== null) bounded(rendered);
  const tree = fromMarkdown(existing);
  const occurrences = [...existing.matchAll(/<!-- release-log:/gu)];
  const markers = tree.children.filter(
    (node) => node.type === "html" && node.value.startsWith("<!-- release-log:"),
  );
  if (!occurrences.length) {
    if (rendered === null) return existing;
    const block = generatedSection(rendered);
    if (!existing) {
      const result = `# Changelog\n\n${block}`;
      bounded(result);
      return result;
    }
    const insertion =
      tree.children.find((node) => node.type === "heading" && node.depth === 2)?.position?.start
        .offset ?? existing.length;
    const prefix = existing.slice(0, insertion);
    const separator =
      prefix.endsWith("\n\n") || !prefix ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
    const result = prefix + separator + block + "\n" + existing.slice(insertion);
    bounded(result);
    return result;
  }
  if (occurrences.length !== 2 || markers.length !== 2)
    throw new ChangelogError(
      "Malformed, nested, duplicate, or non-top-level release-log pending boundaries; repair explicitly.",
    );
  const [open, close] = markers;
  if (!open || !close || open.type !== "html" || close.type !== "html")
    throw new ChangelogError("Missing pending boundaries.");
  const match = /^<!-- release-log:pending:v1 sha256:([a-f0-9]{64}) -->$/u.exec(open.value);
  const start = open.position?.start.offset;
  const contentStart = open.position?.end.offset;
  const contentEnd = close.position?.start.offset;
  const end = close.position?.end.offset;
  if (
    !match ||
    close.value !== endMarker ||
    start === undefined ||
    contentStart === undefined ||
    contentEnd === undefined ||
    end === undefined ||
    start >= contentEnd
  )
    throw new ChangelogError("Unsupported or reversed pending boundaries.");
  const between = existing.slice(contentStart, contentEnd);
  if (!between.startsWith("\n\n") || !between.endsWith("\n"))
    throw new ChangelogError("Pending section framing was edited; review before replacing.");
  const content = between.slice(2, -1);
  if (createHash("sha256").update(content).digest("hex") !== match[1])
    throw new ChangelogError(
      "Pending generated content was edited; review and recover explicitly rather than overwriting it.",
    );
  if (rendered === null)
    throw new ChangelogError(
      "A pending release exists but the new plan has no release; review rather than silently removing it.",
    );
  const after = existing.startsWith("\r\n", end)
    ? end + 2
    : existing.startsWith("\n", end)
      ? end + 1
      : end;
  const result = existing.slice(0, start) + generatedSection(rendered) + existing.slice(after);
  bounded(result);
  return result;
}
