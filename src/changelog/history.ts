import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { bounded, ChangelogError } from "./bounds.ts";

const endMarker = "<!-- release-log:pending:end -->";

function generatedSection(content: string): string {
  if (
    !/^## v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?: \(\d{4}-\d{2}-\d{2}\))?\n/u.test(
      content,
    ) ||
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
  const released =
    releasedVersion !== undefined &&
    /^## v([^\s]+)(?: \(\d{4}-\d{2}-\d{2}\))?\n/u.exec(content)?.[1] === releasedVersion;
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
