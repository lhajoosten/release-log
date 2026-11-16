import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  ChangelogError,
  contributorAttribution,
  encodeComparisonRef,
  sectionEmojis,
  updateChangelog,
} from "./changelog.ts";
import {
  GitInspectionError,
  inspectGitTree,
  inspectTagDate,
  inspectTagRange,
  readGitBlob,
} from "./git.ts";
import { readGitHubJson } from "./github.ts";
import type { GitHubRead } from "./github.ts";
import { parseReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// Backfill deliberately uses present-day GitHub authors; it cannot reconstruct a past capture.
export async function backfillChangelog(
  existing: string,
  configuration: ReleaseInputConfiguration,
  repository: string,
  token: string,
  read: GitHubRead = fetch,
): Promise<string> {
  const config = parseReleaseInputConfiguration(configuration);
  if (Buffer.byteLength(existing, "utf8") > 16 * 1024 * 1024)
    throw new ChangelogError("Changelog exceeds 16 MiB.");
  const tree = fromMarkdown(existing);
  const markers = tree.children.filter(
    (node) => node.type === "html" && node.value.startsWith("<!-- release-log:"),
  );
  let pendingStart = -1;
  let pendingEnd = -1;
  if (existing.includes("<!-- release-log:")) {
    const [open, close] = markers;
    pendingStart = open?.position?.start.offset ?? -1;
    pendingEnd = close?.position?.end.offset ?? -1;
    const pendingVersion = /^\n\n## v(\d+\.\d+\.\d+)(?: \(\d{4}-\d{2}-\d{2}\))?\n/u.exec(
      existing.slice(open?.position?.end.offset ?? 0),
    );
    if (!pendingVersion) throw new ChangelogError("Cannot backfill malformed pending content.");
    updateChangelog(existing, null, pendingVersion[1]);
    const version = pendingVersion[1];
    if (!version || !open?.position || !close?.position)
      throw new ChangelogError("Missing pending release identity or position.");
    let released = null;
    try {
      released = await inspectTagRange(repository, `v${version}`, `v${version}`);
    } catch (error) {
      if (!(error instanceof GitInspectionError && error.code === "tag-not-found")) throw error;
    }
    if (released) {
      const taggedTree = await inspectGitTree(repository, released.to.commitSha);
      const changelog = taggedTree.entries.get("CHANGELOG.md");
      const owned = existing.slice(pendingStart, pendingEnd);
      if (
        !changelog ||
        changelog.type !== "blob" ||
        !["100644", "100755"].includes(changelog.mode) ||
        !(await readGitBlob(repository, changelog.sha)).includes(owned)
      )
        throw new ChangelogError(
          "The version tag does not contain this pending changelog block; review the conflicting release before backfilling.",
        );
      const content = existing.slice(
        (open.position.end.offset ?? 0) + 2,
        (close.position.start.offset ?? 0) - 1,
      );
      const after = existing.startsWith("\r\n", pendingEnd)
        ? pendingEnd + 2
        : existing.startsWith("\n", pendingEnd)
          ? pendingEnd + 1
          : pendingEnd;
      return backfillChangelog(
        existing.slice(0, pendingStart) + content + existing.slice(after),
        config,
        repository,
        token,
        read,
      );
    }
  }
  const inPending = (offset: number) => pendingStart <= offset && offset < pendingEnd;
  const headings = tree.children.filter((node) => node.type === "heading" && node.depth === 2);
  const releases = headings.flatMap((node) => {
    const start = node.position?.start.offset;
    if (start === undefined) throw new ChangelogError("Missing Markdown position.");
    if (inPending(start)) return [];
    const match =
      /^## (v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?: - \d{4}-\d{2}-\d{2}| \(\d{4}-\d{2}-\d{2}\))?\s*$/u.exec(
        existing.slice(start, node.position?.end.offset),
      );
    if (!match?.[1])
      throw new ChangelogError(
        "Backfill requires stable version H2 headings (## vMAJOR.MINOR.PATCH).",
      );
    const end =
      headings.find((heading) => (heading.position?.start.offset ?? 0) > start)?.position?.start
        .offset ?? existing.length;
    return [
      {
        tag: match[1],
        start,
        end,
        headingEnd: node.position?.end.offset ?? start,
        dated: /\d{4}-\d{2}-\d{2}/u.test(match[0]),
      },
    ];
  });
  if (
    releases.length > 1000 ||
    new Set(releases.map((release) => release.tag)).size !== releases.length
  )
    throw new ChangelogError("Backfill requires at most 1000 unique releases.");
  const edits: Edit[] = [];
  const authors = new Map<number, string | null>();
  for (const [index, release] of releases.entries()) {
    const previous = releases[index + 1];
    const range = await inspectTagRange(repository, previous?.tag ?? release.tag, release.tag);
    if (!range.fromIsAncestor)
      throw new ChangelogError("Changelog release tags are not in ancestry order.");
    if (!release.dated) {
      const captured = tree.children.find(
        (node) =>
          node.type === "paragraph" &&
          (node.position?.start.offset ?? -1) > release.start &&
          (node.position?.start.offset ?? release.end) < release.end &&
          /^Inputs captured at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(UTC; not a release date\)\.$/u.test(
            existing.slice(node.position?.start.offset, node.position?.end.offset),
          ),
      );
      const recorded =
        captured &&
        /^Inputs captured at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/u.exec(
          existing.slice(captured.position?.start.offset, captured.position?.end.offset),
        )?.[1];
      if (
        recorded &&
        (!Number.isFinite(Date.parse(recorded)) || new Date(recorded).toISOString() !== recorded)
      )
        throw new ChangelogError("The recorded snapshot capture timestamp is invalid.");
      const fallback = recorded ? null : await inspectTagDate(repository, range.to);
      const date = recorded ? recorded.slice(0, 10) : fallback?.date;
      if (!date) throw new ChangelogError("No recorded date is available for this release.");
      edits.push({
        start: release.headingEnd,
        end: release.headingEnd,
        text: ` (${date})${fallback ? `\n\nDate source: ${fallback.source} (UTC); snapshot capture time unavailable.` : ""}`,
      });
    }
    if (previous) {
      const url = `https://github.com/${config.repository}/compare/${encodeComparisonRef(previous.tag)}...${encodeComparisonRef(release.tag)}`;
      const section = existing.slice(release.start, release.end);
      if (!section.includes("Full changelog:")) {
        const position = release.end - (section.match(/\s*$/u)?.[0].length ?? 0);
        edits.push({
          start: position,
          end: position,
          text: `${section.trimEnd().endsWith("</details>") ? "\n\n<br>\n\n" : "\n\n"}Full changelog: [${previous.tag}…${release.tag}](${url})`,
        });
      }
    }
    for (const node of tree.children) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        start === undefined ||
        end === undefined ||
        start <= release.start ||
        start >= release.end ||
        inPending(start)
      )
        continue;
      if (
        node.type === "paragraph" &&
        existing.slice(start, end).startsWith("Full changelog:") &&
        existing.slice(release.start, start).trimEnd().endsWith("</details>")
      )
        edits.push({ start, end: start, text: "<br>\n\n" });
      if (node.type === "heading" && node.depth === 3) {
        const heading = existing.slice(start, end);
        const name = heading.slice(4);
        if (Object.hasOwn(sectionEmojis, name))
          edits.push({ start, end, text: `### ${sectionEmojis[name]} ${name}` });
      }
      if (
        node.type === "html" &&
        node.value === "<details>\n<summary>Internal maintenance</summary>"
      )
        edits.push({
          start,
          end,
          text: node.value.replace("Internal maintenance", "🔧 Internal maintenance"),
        });
      if (node.type !== "list") continue;
      for (const item of node.children) {
        const paragraph = item.children[0];
        if (paragraph?.type !== "paragraph") continue;
        const source = paragraph.children.find(
          (child) =>
            child.type === "link" &&
            child.url.startsWith(`https://github.com/${config.repository}/pull/`),
        );
        if (source?.type !== "link") continue;
        const number = Number(
          source.url.slice(`https://github.com/${config.repository}/pull/`.length),
        );
        if (
          !Number.isSafeInteger(number) ||
          number <= 0 ||
          source.url !== `https://github.com/${config.repository}/pull/${number}`
        )
          throw new ChangelogError("Invalid source PR link in changelog.");
        if (
          paragraph.children.some(
            (child) => child.type === "link" && /^https:\/\/github\.com\/[^/]+$/u.test(child.url),
          )
        )
          continue;
        if (!authors.has(number)) {
          if (authors.size >= 1000) throw new ChangelogError("Backfill exceeds 1000 PR reads.");
          const { data } = await readGitHubJson(
            `https://api.github.com/repos/${config.repository}/pulls/${number}`,
            token,
            read,
          );
          if (
            typeof data !== "object" ||
            data === null ||
            !("number" in data) ||
            data.number !== number ||
            !("user" in data)
          )
            throw new ChangelogError("GitHub returned invalid backfill PR evidence.");
          const user = data.user;
          if (
            user !== null &&
            (typeof user !== "object" ||
              !("login" in user) ||
              typeof user.login !== "string" ||
              Buffer.byteLength(user.login, "utf8") > 256)
          )
            throw new ChangelogError("GitHub returned invalid backfill author evidence.");
          authors.set(
            number,
            user !== null &&
              typeof user === "object" &&
              "login" in user &&
              typeof user.login === "string"
              ? user.login
              : null,
          );
        }
        const position = paragraph.position?.end.offset;
        if (position === undefined) throw new ChangelogError("Missing Markdown position.");
        edits.push({
          start: position,
          end: position,
          text: contributorAttribution(authors.get(number)),
        });
      }
    }
  }
  let result = existing;
  for (const edit of edits.toSorted((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  if (Buffer.byteLength(result, "utf8") > 16 * 1024 * 1024)
    throw new ChangelogError("Backfilled changelog exceeds 16 MiB.");
  return result;
}

export async function writeBackfilledChangelog(
  repository: string,
  before: string,
  after: string,
): Promise<void> {
  const root = resolve(repository);
  if ((await realpath(root)) !== root)
    throw new ChangelogError("Select a real repository directory, not a symlink.");
  const path = join(root, "CHANGELOG.md");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ChangelogError("CHANGELOG.md must be an ordinary file.");
  const temporary = join(root, `.release-log-backfill-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, after, { flag: "wx", mode: info.mode });
    if ((await readFile(path, "utf8")) !== before || (await lstat(path)).isSymbolicLink())
      throw new ChangelogError("Changelog changed during backfill; retry from fresh inputs.");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
