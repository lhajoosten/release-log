import { bounded } from "./bounds.ts";
import type { ReleasePlan } from "../planning/derive-release-plan.ts";
import type { ChangelogVerbosity } from "../config/repository.ts";
import type { ReleaseSnapshot } from "../snapshot/model.ts";

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

export const sectionEmojis: Readonly<Record<string, string>> = {
  Features: "✨",
  Fixes: "🐛",
  Performance: "⚡",
  Reverts: "⏪",
  Refactoring: "♻️",
  Documentation: "📚",
  Build: "📦",
  "Continuous integration": "👷",
  Tests: "🧪",
  Style: "🎨",
  Maintenance: "🔧",
  "Historical changes": "📜",
  "Breaking changes": "💥",
  "Required actions": "🛠️",
  "Internal maintenance": "🔧",
};

export function encodeComparisonRef(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contributorAttribution(login: string | null | undefined): string {
  return login
    ? ` by [${escapeText(`@${login}`)}](https://github.com/${encodeComparisonRef(login)})`
    : "";
}

function attribution(snapshot: ReleaseSnapshot, number: number): string {
  return snapshot.capturedAt === undefined
    ? ""
    : contributorAttribution(
        snapshot.input.pullRequests.find((pull) => pull.number === number)?.authorLogin,
      );
}

function presentation(snapshot: ReleaseSnapshot, content: string): string {
  if (snapshot.capturedAt === undefined) return content;
  let result = content
    .replace(/^(## v\d+\.\d+\.\d+)\n/u, `$1 (${snapshot.capturedAt.slice(0, 10)})\n`)
    .replace(/^(### )(.+)$/gmu, (line: string, prefix: string, name: string) =>
      Object.hasOwn(sectionEmojis, name) ? `${prefix}${sectionEmojis[name]} ${name}` : line,
    )
    .replace(
      "<summary>Internal maintenance</summary>",
      "<summary>🔧 Internal maintenance</summary>",
    );
  const baseline = snapshot.input.range.baseline;
  if (baseline.kind === "tag") {
    const source = snapshot.input.range.sourceCommitSha;
    const label = `${baseline.name}…${source}`;
    result += `${result.trimEnd().endsWith("</details>") ? "\n<br>\n\n" : "\n"}Full changelog: [${escapeText(label)}](https://github.com/${snapshot.configuration.repository}/compare/${encodeComparisonRef(baseline.name)}...${encodeComparisonRef(source)}) (captured source).\n`;
  }
  return result;
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
    appendEntry(
      lines,
      `- ${escapeText(entry.summary)} ${reference(entry)}${entry.reference.startsWith("#") ? attribution(snapshot, Number(entry.reference.slice(1))) : ""}`,
      details,
      verbosity,
    );
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

  const rendered = presentation(snapshot, lines.join("\n"));
  bounded(rendered);
  return rendered;
}

export function renderPlannedChangelog(
  snapshot: ReleaseSnapshot,
  plan: ReleasePlan,
): string | null {
  if (!plan.release) return null;
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
        `- **${escapeText(pull.title.scope ?? "")}**${label}: ${escapeText(pull.context?.summary ?? pull.title.description)} ([#${pull.number}](${pull.url}))${attribution(snapshot, pull.number)}`,
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
        `- [${kind}]${audience}: ${escapeText(entry.title)} ([${reference}](${entry.source.url}))${entry.source.kind === "pull-request" ? attribution(snapshot, entry.source.number) : ""}`,
        details,
        verbosity,
      );
    }

    lines.push("");
  }

  const rendered = presentation(snapshot, lines.join("\n"));
  bounded(rendered);
  return rendered;
}
