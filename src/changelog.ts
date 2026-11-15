import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createReleasePlan } from "./release-plan.ts";
import type { ReleaseVersionConfiguration } from "./release-plan.ts";
import { replayReleaseSnapshot } from "./release-snapshot.ts";
import type {
  ChangelogVerbosity,
  ReleaseInputConfiguration,
  ReleaseSnapshot,
} from "./release-snapshot.ts";

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

function appendEntry(
  lines: string[],
  entry: string,
  details: readonly string[],
  verbosity: ChangelogVerbosity,
): void {
  if (verbosity === "one-liner") lines.push([entry, ...details].join(" "));
  else lines.push(entry, ...details.map((detail) => `  - ${detail}`));
}

interface CompactEntry {
  readonly type: string | null;
  readonly summary: string;
  readonly reference: string;
  readonly url: string;
  readonly internal: boolean;
  readonly context: ReleaseSnapshot["normalized"]["pullRequests"][number]["context"];
  readonly breaking: boolean;
  readonly breakingChanges: readonly string[];
  readonly missing: string | null;
  readonly warnings: readonly string[];
}

function renderCompactChangelog(
  snapshot: ReleaseSnapshot,
  nextVersion: string | null,
  verbosity: ChangelogVerbosity,
  initialAdoption: boolean,
): string {
  const entries: CompactEntry[] = snapshot.normalized.pullRequests.map((pull) => ({
    type: pull.title.type,
    summary: pull.context?.summary ?? pull.title.description,
    reference: `#${pull.number}`,
    url: pull.url,
    internal: pull.context?.audience === "internal",
    context: pull.context,
    breaking: pull.title.breaking,
    breakingChanges: pull.breakingChanges,
    missing:
      pull.context === null
        ? "Context unavailable; audience and impact are unknown. Review the linked PR."
        : null,
    warnings: [],
  }));

  entries.push(
    ...snapshot.normalized.bootstrapCommits.map((entry) => ({
      type: entry.metadata.type,
      summary: `[bootstrap commit] ${entry.metadata.description}`,
      reference: entry.sha.slice(0, 12),
      url: entry.url,
      internal: false,
      context: null,
      breaking: entry.metadata.breaking,
      breakingChanges: entry.metadata.breakingChanges,
      missing: "Bootstrap context unavailable; impact and migration instructions are not inferred.",
      warnings: [],
    })),
  );

  entries.push(
    ...snapshot.normalized.historicalEntries.map((entry) => ({
      type: null,
      summary: `[historical ${entry.source.kind === "pull-request" ? "PR" : "commit"}] ${entry.title}`,
      reference:
        entry.source.kind === "pull-request"
          ? `#${entry.source.number}`
          : entry.source.sha.slice(0, 12),
      url: entry.source.url,
      internal: entry.context?.audience === "internal",
      context: entry.context,
      breaking: entry.breakingChanges.length > 0,
      breakingChanges: entry.breakingChanges,
      missing:
        entry.context === null ? "Historical context unavailable; review the linked source." : null,
      warnings: entry.warnings.map((issue) => issue.code),
    })),
  );

  entries.sort((left, right) => {
    const leftPull = left.reference.startsWith("#");
    const rightPull = right.reference.startsWith("#");
    if (leftPull && rightPull)
      return Number(left.reference.slice(1)) - Number(right.reference.slice(1));
    if (leftPull !== rightPull) return leftPull ? -1 : 1;
    return left.url < right.url ? -1 : left.url > right.url ? 1 : 0;
  });

  const lines = [`## v${nextVersion}`, ""];
  if (initialAdoption) lines.push("Initial release of the captured repository state.", "");
  if (snapshot.normalized.historicalEntries.length)
    lines.push(
      "> Historical entries predate onboarding and may lack current release metadata. Review their sources and breaking warnings; no missing impact or migration instructions are inferred.",
      "",
    );

  const reference = (entry: CompactEntry) => `([${entry.reference}](${entry.url}))`;
  const append = (entry: CompactEntry) => {
    const details: string[] = [];
    if (entry.missing !== null) details.push(entry.missing);
    if (verbosity === "detailed" && entry.type === null && entry.context !== null)
      details.push(`Summary: ${escapeText(entry.context.summary)}`);
    if (verbosity === "detailed" && entry.context !== null)
      details.push(`Impact: ${escapeText(entry.context.impact)}`);
    if (verbosity === "detailed" && entry.warnings.length)
      details.push(`Metadata review: ${entry.warnings.map(escapeText).join(", ")}`);
    appendEntry(lines, `- ${escapeText(entry.summary)} ${reference(entry)}`, details, verbosity);
  };

  for (const [type, heading] of [...groups, [null, "Historical changes"]] as const) {
    const visible = entries.filter((entry) => !entry.internal && entry.type === type);
    if (!visible.length) continue;
    lines.push(`### ${heading}`, "");
    visible.forEach(append);
    lines.push("");
  }

  const breaking = entries.filter((entry) => entry.breaking);
  if (breaking.length) {
    lines.push("### Breaking changes", "");
    for (const entry of breaking)
      lines.push(`- ${entry.breakingChanges.map(escapeText).join("; ")} ${reference(entry)}`);
    lines.push("");
  }

  const actions = entries.filter(
    (entry) =>
      entry.context?.requiredAction != null ||
      (entry.breaking && entry.context?.requiredAction == null),
  );
  if (actions.length) {
    lines.push("### Required actions", "");
    for (const entry of actions) {
      const action = entry.context?.requiredAction;
      lines.push(
        `- ${action == null ? "Migration instructions are missing; review the linked source." : escapeText(action)} ${reference(entry)}`,
      );
    }
    lines.push("");
  }

  const internal = entries.filter((entry) => entry.internal);
  if (internal.length) {
    lines.push("<details>", "<summary>Internal maintenance</summary>", "");
    internal.forEach(append);
    lines.push("", "</details>", "");
  }

  const rendered = lines.join("\n");
  bounded(rendered);
  return rendered;
}

export async function renderChangelog(
  serializedSnapshot: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
): Promise<string | null> {
  const plan = await createReleasePlan(serializedSnapshot, expected, version);
  if (!plan.release) return null;
  const snapshot = await replayReleaseSnapshot(serializedSnapshot, expected);
  const verbosity = snapshot.configuration.changelog?.verbosity ?? "detailed";
  if (snapshot.configuration.changelog?.format === "compact")
    return renderCompactChangelog(
      snapshot,
      plan.nextVersion,
      verbosity,
      plan.onboardingSha !== null,
    );

  const lines = [`## v${plan.nextVersion}`, ""];

  if (plan.onboardingSha !== null)
    lines.push("Initial release of the captured repository state.", "");

  if (snapshot.normalized.historicalEntries.length)
    lines.push(
      "> Historical entries predate onboarding and may lack current release metadata. Review their sources and breaking warnings; no missing impact or migration instructions are inferred.",
      "",
    );

  if (snapshot.normalized.bootstrapCommits.length)
    lines.push(
      "> Bootstrap history includes commit-only entries without structured PR impact or migration actions.",
      "",
    );

  for (const [type, heading] of groups) {
    const entries = snapshot.normalized.pullRequests
      .filter((pull) => pull.title.type === type)
      .toSorted((left, right) => {
        const a = left.title.scope ?? "";
        const b = right.title.scope ?? "";
        return a < b ? -1 : a > b ? 1 : left.number - right.number;
      });

    const bootstrapEntries = snapshot.normalized.bootstrapCommits
      .filter((entry) => entry.metadata.type === type)
      .toSorted((left, right) => {
        const a = left.metadata.scope ?? "";
        const b = right.metadata.scope ?? "";
        return a < b ? -1 : a > b ? 1 : left.sha < right.sha ? -1 : left.sha > right.sha ? 1 : 0;
      });

    if (!entries.length && !bootstrapEntries.length) continue;

    lines.push(`### ${heading}`, "");

    for (const pull of entries) {
      const label = pull.context?.audience === "internal" ? " [internal]" : "";
      const details: string[] = [];

      if (pull.context === null)
        details.push(
          "Release context: unavailable; audience and impact are unknown. Review the linked PR.",
        );
      else if (verbosity === "detailed") details.push(`Impact: ${escapeText(pull.context.impact)}`);
      if (pull.title.breaking)
        details.push(`**Breaking change:** ${pull.breakingChanges.map(escapeText).join("; ")}`);
      if (pull.context === null && pull.title.breaking)
        details.push(
          "**Required action:** migration instructions are missing; review the linked PR.",
        );
      if (pull.context !== null && pull.context.requiredAction !== null)
        details.push(`**Required action:** ${escapeText(pull.context.requiredAction)}`);

      appendEntry(
        lines,
        `- **${escapeText(pull.title.scope ?? "")}**${label}: ${escapeText(pull.context?.summary ?? pull.title.description)} ([#${pull.number}](${pull.url}))`,
        details,
        verbosity,
      );
    }

    for (const entry of bootstrapEntries) {
      const scope = entry.metadata.scope ? `**${escapeText(entry.metadata.scope)}** ` : "";

      const details = entry.metadata.breaking
        ? [`**Breaking change:** ${entry.metadata.breakingChanges.map(escapeText).join("; ")}`]
        : [];

      appendEntry(
        lines,
        `- ${scope}[bootstrap commit]: ${escapeText(entry.metadata.description)} ([${entry.sha.slice(0, 12)}](${entry.url}))`,
        details,
        verbosity,
      );
    }

    lines.push("");
  }

  if (snapshot.normalized.historicalEntries.length) {
    lines.push("### Historical changes", "");

    for (const entry of snapshot.normalized.historicalEntries) {
      const reference =
        entry.source.kind === "pull-request"
          ? `#${entry.source.number}`
          : entry.source.sha.slice(0, 12);
      const kind = entry.source.kind === "pull-request" ? "historical PR" : "historical commit";
      const audience = entry.context?.audience === "internal" ? " [internal]" : "";

      const details: string[] = [];

      if (entry.context !== null) {
        if (verbosity === "detailed") {
          details.push(`Summary: ${escapeText(entry.context.summary)}`);
          details.push(`Impact: ${escapeText(entry.context.impact)}`);
        }

        if (entry.context.requiredAction !== null)
          details.push(`**Required action:** ${escapeText(entry.context.requiredAction)}`);
      } else if (verbosity === "detailed") {
        details.push("Release context: unavailable; review the linked historical source.");
      }

      if (entry.breakingChanges.length)
        details.push(`**Breaking change:** ${entry.breakingChanges.map(escapeText).join("; ")}`);

      if (verbosity === "detailed")
        details.push(
          `Metadata review: ${entry.warnings.map((issue) => escapeText(issue.code)).join(", ")}`,
        );

      appendEntry(
        lines,
        `- [${kind}]${audience}: ${escapeText(entry.title)} ([${reference}](${entry.source.url}))`,
        details,
        verbosity,
      );
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

export function updateChangelog(
  existing: string,
  rendered: string | null,
  releasedVersion?: string,
): string {
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
  const released = releasedVersion !== undefined && content.startsWith(`## v${releasedVersion}\n`);
  if (released && rendered === null) return existing;
  if (rendered === null)
    throw new ChangelogError(
      "A pending release exists but the new plan has no release; review rather than silently removing it.",
    );
  const after = existing.startsWith("\r\n", end)
    ? end + 2
    : existing.startsWith("\n", end)
      ? end + 1
      : end;
  const result =
    existing.slice(0, start) +
    generatedSection(rendered) +
    (released ? `\n${content}\n` : "") +
    existing.slice(after);
  bounded(result);
  return result;
}
