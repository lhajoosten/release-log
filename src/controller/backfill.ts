import { ensureProposalHead } from "./cycle.ts";
import { renderRelease, type Change } from "../release/core.ts";
import { readChanges } from "./history.ts";
import { ancestor, blob, git, stableHistory, type StableTag } from "./local.ts";
import { Remote, sha } from "./remote.ts";

const branch = "release/changelog-backfill";
const title = "docs(changelog): rebuild historical releases";
const body =
  "Rebuilt stable releases from Git tag ancestry and captured GitHub PR metadata. Review the replacement CHANGELOG.md.";

export async function historicalChangelog(
  root: string,
  repository: string,
  head: string,
  start: string | null,
  collect: (
    root: string,
    repository: string,
    base: string | null,
    head: string,
  ) => Promise<readonly Change[]> = readChanges,
) {
  const tags = await stableHistory(root, head);
  if (!tags.length) throw new Error("No reachable stable version tags");
  const sections: string[] = [];
  const evidence: string[] = [];
  const seen = new Set<number>();
  let previous: StableTag | null = null;
  for (const tag of tags) {
    const base = previous?.commit ?? start;
    if (base && !(await ancestor(root, base, tag.commit)))
      throw new Error("Starting boundary is outside " + tag.name);
    try {
      const changes = await collect(root, repository, base, tag.commit);
      for (const change of changes) {
        if (seen.has(change.number))
          throw new Error("PR appears in two tag ranges: #" + change.number);
        seen.add(change.number);
      }
      sections.push(
        renderRelease({
          repository,
          version: tag.version,
          previousVersion: previous?.version ?? null,
          changes,
        }).trimEnd(),
      );
      evidence.push(
        tag.name + " (" + tag.commit + "): " + changes.map((p) => "#" + p.number).join(", "),
      );
    } catch (error) {
      throw new Error(
        `Cannot rebuild ${tag.name} (${base ?? "beginning"}..${tag.commit}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    previous = tag;
  }
  return {
    markdown: "# Changelog\n\n" + sections.toReversed().join("\n\n") + "\n",
    tags,
    evidence,
  };
}

export async function runBackfill(root: string, repository: string) {
  const remote = new Remote(
    repository,
    process.env.GITHUB_TOKEN ?? "",
    process.env.ROLLING_RELEASE_BOT ?? "",
  );
  const source = sha((await git(root, "rev-parse", "HEAD")).trim());
  if (source !== (await remote.ref("heads/main")))
    throw new Error("Check out current main for backfill");
  const { markdown, tags, evidence } = await historicalChangelog(
    root,
    repository,
    source,
    process.env.ROLLING_RELEASE_START_SHA || null,
  );
  console.log(
    "Historical PR titles use available GitHub PR metadata at capture time. Merge-time titles may differ.\n" +
      evidence.join("\n"),
  );
  const recheck = async () => {
    for (const tag of tags)
      if ((await remote.tag(tag.name)) !== tag.commit)
        throw new Error("Historical tag changed: " + tag.name);
  };
  await recheck();
  const prior = await remote.ref("heads/" + branch);
  const pr = await remote.openProposal(branch);
  if ((await blob(root, source, "CHANGELOG.md")) === markdown) {
    if (pr)
      throw new Error(
        "Backfill is already on main; close the obsolete proposal and remove its branch",
      );
    return;
  }
  if (prior || pr) {
    if (!pr || prior !== pr.head)
      throw new Error("Unowned or conflicting historical changelog proposal");
    await ensureProposalHead(root, remote, pr.pull);
    const parent = sha((await git(root, "rev-parse", prior + "^")).trim());
    if (
      (await git(root, "diff", "--name-only", "-z", parent, prior)) !== "CHANGELOG.md\0" ||
      !(await git(root, "ls-tree", prior, "--", "CHANGELOG.md")).startsWith("100644 blob ") ||
      (await blob(root, prior, "CHANGELOG.md")) !== markdown ||
      pr.title !== title ||
      pr.body !== body ||
      !(await ancestor(root, parent, source))
    )
      throw new Error("Existing backfill proposal differs; review it before starting another");
    if (parent === source) return;
  }
  await remote.writeProposal({
    branch,
    source,
    previous: prior,
    number: pr?.number ?? null,
    title,
    body,
    expectedTitle: pr?.title,
    expectedBody: pr?.body,
    files: new Map([["CHANGELOG.md", markdown]]),
    recheck,
  });
}
