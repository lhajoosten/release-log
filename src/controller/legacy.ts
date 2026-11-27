import { createHash } from "node:crypto";
import { ancestor, blob, git } from "./local.ts";
import { ensureProposalHead } from "./cycle.ts";
import { object, sha, type Remote } from "./remote.ts";

/** Recognize a previously tagged release-log proposal from its reviewed evidence. */
export async function verifyHistoricalRelease(
  root: string,
  remote: Remote,
  pull: Record<string, unknown>,
): Promise<string> {
  if (!remote.owned(pull, "release-log/main") || pull.merged !== true || pull.state !== "closed")
    throw new Error("Historical release is not a merged proposal owned by the configured App.");
  const match =
    typeof pull.title === "string"
      ? /^chore\(release\): prepare v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(
          pull.title,
        )
      : null;
  const version = match?.[1];
  if (!version || typeof pull.body !== "string" || pull.body.length > 4 * 1024 * 1024)
    throw new Error("Historical release lacks a stable version or valid proposal body.");
  const markers = [...pull.body.matchAll(/<!-- release-log:proposal:v1 ([A-Za-z0-9_-]+) -->/gu)];
  if (markers.length !== 1 || !markers[0]?.[1])
    throw new Error("Historical release lacks one proposal record.");
  let marker: Record<string, unknown>;
  try {
    marker = object(JSON.parse(Buffer.from(markers[0][1], "base64url").toString("utf8")));
  } catch {
    throw new Error("Historical proposal record is malformed.");
  }
  const landing = sha(pull.merge_commit_sha),
    head = await ensureProposalHead(root, remote, pull);
  const source = sha(marker.sourceSha),
    tag = `v${version}`;
  const localTag = sha(
    (await git(root, "rev-parse", "--verify", `refs/tags/${tag}^{commit}`)).trim(),
  );
  if (localTag !== landing || (await remote.tag(tag)) !== landing)
    throw new Error(`Historical tag ${tag} does not independently resolve to the landing.`);
  const main = await remote.ref("heads/main");
  if (!main || !(await ancestor(root, landing, main)))
    throw new Error("Historical release is outside main.");
  const parentList = (await git(root, "show", "-s", "--format=%P", landing)).trim().split(" ");
  const headParent = sha((await git(root, "rev-parse", `${head}^1`)).trim());
  if (
    headParent !== source ||
    parentList[0] !== source ||
    parentList.length > 2 ||
    (parentList.length === 2 && parentList[1] !== head) ||
    (await git(root, "rev-parse", `${head}^{tree}`)) !==
      (await git(root, "rev-parse", `${landing}^{tree}`))
  )
    throw new Error("Historical release head, landing, parents or tree disagree.");
  const commit = object(await remote.request(`commits/${head}`));
  if (commit.sha !== head || object(object(commit.commit).verification).verified !== true)
    throw new Error("Historical proposal head lacks a verified signature.");
  const base = object(pull.base),
    author = object(pull.user);
  if (
    marker.schemaVersion !== 1 ||
    marker.botUserId !== author.id ||
    marker.repositoryId !== object(base.repo).id ||
    marker.releaseBranch !== base.ref ||
    typeof marker.snapshotId !== "string" ||
    typeof marker.configurationId !== "string"
  )
    throw new Error("Historical proposal identity is inconsistent.");
  const snapshotText = await blob(root, landing, ".release-log/inputs.json");
  if (!snapshotText) throw new Error("Historical release snapshot is missing.");
  const snapshot = object(JSON.parse(snapshotText));
  const input = object(snapshot.input),
    range = object(input.range);
  if (
    ![3, 4, 5].includes(Number(snapshot.schemaVersion)) ||
    snapshot.snapshotId !== marker.snapshotId ||
    snapshot.configurationId !== marker.configurationId ||
    range.sourceCommitSha !== source ||
    input.releaseBranch !== base.ref
  )
    throw new Error("Historical snapshot disagrees with the proposal.");
  if (!Array.isArray(marker.files) || marker.files.length === 0 || marker.files.length > 100)
    throw new Error("Historical generated file list is invalid.");
  const expected = new Map<string, string>();
  for (const raw of marker.files) {
    const file = object(raw),
      path = file.path,
      digest = file.sha256;
    if (
      typeof path !== "string" ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      expected.has(path) ||
      !/^(?:CHANGELOG\.md|\.release-log\/inputs\.json|package\.json|package-lock\.json|npm-shrinkwrap\.json|pyproject\.toml|uv\.lock|poetry\.lock|Cargo\.lock|Cargo\.toml|(?:[A-Za-z0-9_.-]+\/)+Cargo\.toml|\.github\/workflows\/rolling-release-caller\.yml)$/u.test(
        path,
      )
    )
      throw new Error("Historical proposal lists an unsupported generated path.");
    expected.set(path, digest);
  }
  if (!expected.has("CHANGELOG.md") || !expected.has(".release-log/inputs.json"))
    throw new Error("Historical proposal omits generated evidence.");
  const changed = (await git(root, "diff", "--no-renames", "--name-only", "-z", source, head))
    .split("\0")
    .filter(Boolean);
  if (changed.length !== expected.size || changed.some((path) => !expected.has(path)))
    throw new Error("Historical proposal includes unexpected changes.");
  for (const [path, digest] of expected) {
    const entry = await git(root, "ls-tree", "-z", head, "--", path);
    if (!/^100644 blob [a-f0-9]{40}\t/u.test(entry))
      throw new Error(`Historical output is not an ordinary file: ${path}`);
    const text = await blob(root, head, path);
    if (text === null || createHash("sha256").update(text).digest("hex") !== digest)
      throw new Error(`Historical output differs from reviewed evidence: ${path}`);
  }
  return landing;
}
