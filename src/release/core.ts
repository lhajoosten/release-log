/** Captured PR metadata used by the deterministic release planner. */
export interface Change {
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly requiredAction: string | null;
}

interface Input {
  readonly repository: string;
  readonly previousVersion: string | null;
  readonly changes: readonly Change[];
}

type Section = "features" | "fixes" | "documentation" | "maintenance";
interface ParsedChange {
  readonly change: Change;
  readonly description: string;
  readonly section: Section;
  readonly bump: number;
  readonly breaking: boolean;
}

const versions = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const authorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/u;

function versionParts(version: string): [bigint, bigint, bigint] {
  const match = versions.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`Invalid stable version: ${version}`);
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function parse(input: Input): ParsedChange[] {
  if (
    !repositoryPattern.test(input.repository) ||
    input.repository.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid repository identity.");
  if (input.previousVersion !== null) versionParts(input.previousVersion);
  const numbers = new Set<number>();
  return input.changes
    .map((change) => {
      if (!Number.isSafeInteger(change.number) || change.number <= 0 || numbers.has(change.number))
        throw new Error(`Invalid or duplicate PR number: ${change.number}`);
      numbers.add(change.number);
      if (change.author !== null && !authorPattern.test(change.author))
        throw new Error(`Invalid author for PR #${change.number}.`);
      if (
        change.requiredAction !== null &&
        (typeof change.requiredAction !== "string" || !change.requiredAction.trim())
      )
        throw new Error(`Invalid required action for PR #${change.number}.`);
      const title =
        /^(feat|fix|perf|revert|docs|build|chore|ci|refactor|style|test)(?:\([^()\r\n]+\))?(!)?: ([^\r\n]+)$/u.exec(
          change.title,
        );
      if (!title?.[1] || !title[3]?.trim())
        throw new Error(`Invalid conventional title for PR #${change.number}.`);
      const type = title[1];
      const section: Section =
        type === "feat"
          ? "features"
          : ["fix", "perf", "revert"].includes(type)
            ? "fixes"
            : type === "docs"
              ? "documentation"
              : "maintenance";
      const breaking = Boolean(title[2]);
      return {
        change,
        description: title[3],
        section,
        breaking,
        bump: breaking ? 3 : type === "feat" ? 2 : ["fix", "perf", "revert"].includes(type) ? 1 : 0,
      };
    })
    .toSorted((a, b) => a.change.number - b.change.number);
}

// Text from PRs must not create Markdown structure or HTML.
function literal(value: string): string {
  return Array.from(value.replace(/\s+/gu, " ").trim(), (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127 || "\\`*_{}[]()<>!&#|~".includes(character)
      ? `&#${point};`
      : character;
  }).join("");
}

export function renderRelease(input: Input & { readonly version: string }): string {
  versionParts(input.version);
  const changes = parse(input);
  const sections: readonly [Section, string][] = [
    ["features", "✨ Features"],
    ["fixes", "🐛 Fixes"],
    ["documentation", "📚 Documentation"],
    ["maintenance", "🔧 Internal maintenance"],
  ];
  const ref = (number: number) =>
    `[#${number}](https://github.com/${input.repository}/pull/${number})`;
  const content: string[] = [`## v${input.version}`];
  for (const [section, heading] of sections) {
    if (section === "maintenance") {
      const actions = changes.filter(({ change }) => change.requiredAction !== null);
      if (actions.length)
        content.push(
          `### 🛠️ Required actions\n\n${actions.map(({ change }) => `- ${literal(change.requiredAction ?? "")} (${ref(change.number)})`).join("\n")}`,
        );
    }
    const entries = changes.filter((change) => change.section === section);
    if (!entries.length) continue;
    content.push(
      `### ${heading}\n\n${entries.map(({ change, description, breaking }) => `- ${breaking ? "**Breaking:** " : ""}${literal(description)} (${ref(change.number)})${change.author ? ` by [@${literal(change.author)}](https://github.com/${encodeURIComponent(change.author)})` : ""}`).join("\n")}`,
    );
  }
  if (input.previousVersion !== null)
    content.push(
      `[Full changelog v${input.previousVersion}...v${input.version}](https://github.com/${input.repository}/compare/v${input.previousVersion}...v${input.version})`,
    );
  return `${content.join("\n\n")}\n`;
}

export function planRelease(
  input: Input,
):
  | { readonly kind: "pending" }
  | { readonly kind: "release"; readonly version: string; readonly markdown: string } {
  const parsed = parse(input);
  const bump = Math.max(0, ...parsed.map((entry) => entry.bump));
  if (!bump) return { kind: "pending" };
  let version = "0.1.0";
  if (input.previousVersion !== null) {
    let [major, minor, patch] = versionParts(input.previousVersion);
    if (bump === 3 && major > 0n) {
      major++;
      minor = 0n;
      patch = 0n;
    } else if (bump >= 2) {
      minor++;
      patch = 0n;
    } else patch++;
    version = `${major}.${minor}.${patch}`;
  }
  return { kind: "release", version, markdown: renderRelease({ ...input, version }) };
}
