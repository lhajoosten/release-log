import type { ReleaseInputConfiguration } from "./config/repository.ts";
import type { ReadinessIssue } from "./evidence/readiness-issue.ts";
import { deriveReleasePlan } from "./planning/derive-release-plan.ts";
import type { ReleaseVersionConfiguration } from "./planning/derive-release-plan.ts";
import type { ReleaseContextV1 } from "./release-context.ts";
import { replayReleaseSnapshot } from "./snapshot/replay.ts";

interface NotesEvidence {
  readonly title: string;
  readonly context: ReleaseContextV1 | null;
  readonly breakingChanges: readonly string[];
  readonly warnings?: readonly ReadinessIssue[];
}

function literal(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\p{P}\p{Cc}<>+=|~$^`]/gu, (character, offset: number, line: string) => {
      // Escape URL punctuation as well as Markdown syntax to prevent authored links.
      if (
        ",?!'\";".includes(character) ||
        (character === "." && !/\S/u.test(line.charAt(offset + 1)))
      )
        return character;
      return `&#${character.codePointAt(0)};`;
    });
}

function sentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : value + ".";
}

type Source =
  | { readonly kind: "pull-request"; readonly number: number }
  | { readonly kind: "commit"; readonly sha: string };

function sourcePath(source: Source): string {
  return source.kind === "pull-request" ? `pull/${source.number}` : `commit/${source.sha}`;
}

export async function renderReleaseNotes(
  serializedSnapshot: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
): Promise<string | null> {
  const snapshot = await replayReleaseSnapshot(serializedSnapshot, expected);
  const plan = deriveReleasePlan(snapshot, version);
  if (plan.nextVersion === null) return null;

  const normalized = snapshot.normalized;
  const evidence = new Map<string, NotesEvidence>();
  for (const pull of normalized.pullRequests)
    evidence.set(`pull/${pull.number}`, {
      title: pull.title.description,
      context: pull.context,
      breakingChanges: pull.breakingChanges,
    });
  for (const { sha, metadata } of normalized.bootstrapCommits)
    evidence.set(`commit/${sha}`, {
      title: metadata.description,
      context: null,
      breakingChanges: metadata.breakingChanges,
    });
  for (const entry of normalized.historicalEntries) evidence.set(sourcePath(entry.source), entry);

  const breakingChanges: string[] = [];
  const requiredActions: string[] = [];
  const improvements: string[] = [];
  const fixes: string[] = [];
  const otherChanges: string[] = [];
  const needsReview: string[] = [];

  function renderEntry(source: Source, breaking: boolean, type: string | null): void {
    const path = sourcePath(source);
    const entry = evidence.get(path);
    if (!entry) throw new Error("Release plan contribution has no replayed evidence.");
    const { context, warnings } = entry;
    const label = source.kind === "pull-request" ? `#${source.number}` : source.sha.slice(0, 12);
    const reference = `([${label}](https://github.com/${snapshot.configuration.repository}/${path}))`;

    if (breaking) {
      const explanation =
        entry.breakingChanges.map(literal).filter(Boolean).map(sentence).join(" ") ||
        "The source declares a breaking change and supplies no explanation.";
      breakingChanges.push(`- ${explanation} ${reference}`);
    }

    const action = context?.requiredAction ?? null;
    if (breaking || action !== null) {
      const instruction =
        action === null
          ? "Migration instructions are missing. Review the linked source."
          : literal(action);
      requiredActions.push(`- ${instruction} ${reference}`);
    }

    if (context?.audience === "users") {
      const section =
        type === "feat" || type === "perf" ? improvements : type === "fix" ? fixes : otherChanges;
      section.push(`- ${literal(context.summary)} ${literal(context.impact)} ${reference}`);
    }

    const review: string[] = [];
    if (context === null) {
      const unusable = warnings?.some(
        ({ location, code }) => location === "context" && code !== "block-missing",
      );
      const gap = unusable ? "unusable" : "missing";
      review.push(
        `${sentence(literal(entry.title))} Audience and impact are unknown because release context is ${gap}.`,
      );
    }
    if (warnings?.length) {
      const codes = [
        ...new Set(warnings.map(({ location, code }) => literal(`${location}/${code}`))),
      ];
      review.push(`Metadata review: ${codes.join(", ")}.`);
    }
    if (review.length) needsReview.push(`- ${review.join(" ")} ${reference}`);
  }

  for (const { number, breaking, type } of plan.contributions)
    renderEntry({ kind: "pull-request", number }, breaking, type);
  for (const { sha, breaking, type } of plan.bootstrapContributions)
    renderEntry({ kind: "commit", sha }, breaking, type);
  for (const { source, breaking } of plan.historicalContributions)
    renderEntry(source, breaking, null);

  const sections = [
    ["Breaking changes", breakingChanges],
    ["Required actions", requiredActions],
    ["Improvements", improvements],
    ["Fixes", fixes],
    ["Other changes", otherChanges],
    ["Needs review", needsReview],
  ] as const;
  const blocks = [
    `# Release notes for v${plan.nextVersion}`,
    "> Draft for maintainer review.",
    `Snapshot ID: ${plan.snapshotId}\nContract: release-notes-v1`,
  ];
  for (const [heading, entries] of sections)
    if (entries.length) blocks.push(`## ${heading}\n\n${entries.join("\n")}`);
  if (blocks.length === 3) blocks.push("No user-facing changes or required actions were recorded.");

  return blocks.join("\n\n") + "\n";
}
