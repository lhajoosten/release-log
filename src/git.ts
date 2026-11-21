import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type GitInspectionErrorCode =
  | "repository-unavailable"
  | "shallow-history"
  | "invalid-tag"
  | "tag-not-found"
  | "tag-not-commit"
  | "invalid-baseline"
  | "invalid-commit-sha"
  | "commit-not-found"
  | "object-not-commit"
  | "baseline-not-ancestor"
  | "git-command-failed";

export class GitInspectionError extends Error {
  readonly code: GitInspectionErrorCode;

  constructor(code: GitInspectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitInspectionError";
    this.code = code;
  }
}

export interface ResolvedTag {
  readonly name: string;
  readonly objectSha: string;
  readonly commitSha: string;
}

export interface TagRangeInspection {
  readonly from: ResolvedTag;
  readonly to: ResolvedTag;
  readonly fromIsAncestor: boolean;
  readonly commitShas: readonly string[];
}

export type PendingReleaseBaseline =
  | { readonly kind: "tag"; readonly name: string }
  | { readonly kind: "bootstrap"; readonly commitSha: string };

export type ResolvedReleaseBaseline =
  | (ResolvedTag & { readonly kind: "tag" })
  | { readonly kind: "bootstrap"; readonly commitSha: string };

export interface GitCommitEvidence {
  readonly sha: string;
  readonly parentShas: readonly string[];
  readonly message: string;
}

export interface PendingReleaseInspection {
  readonly baseline: ResolvedReleaseBaseline;
  readonly sourceCommitSha: string;
  readonly baselineIsAncestor: true;
  readonly commitShas: readonly string[];
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(repository: string, args: readonly string[]): Promise<GitResult> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  // Git's inherited routing overrides cwd, including when invoked from hooks.
  // Inspect the explicitly selected repository and its own object storage.
  for (const variable of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE",
  ]) {
    delete environment[variable];
  }

  try {
    const { stdout, stderr } = await execute(
      "git",
      ["--no-pager", "--no-optional-locks", "--no-replace-objects", ...args],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: environment,
      },
    );

    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }

    throw new GitInspectionError(
      "git-command-failed",
      "Git inspection could not finish. Check Git availability, repository access, and output limits.",
      { cause: error },
    );
  }
}

function requireSuccess(result: GitResult, message: string): string {
  if (result.exitCode !== 0) {
    throw new GitInspectionError("git-command-failed", message, {
      cause: new Error(result.stderr),
    });
  }

  return result.stdout;
}

function requireObjectSha(value: string): string {
  const sha = value.trim();

  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) {
    throw new GitInspectionError("git-command-failed", "Git did not return a complete object ID.");
  }

  return sha;
}

async function resolveTag(repository: string, name: string): Promise<ResolvedTag> {
  if (name.length === 0 || name.includes("\0")) {
    throw new GitInspectionError("invalid-tag", "A tag name must be nonempty and contain no NUL.");
  }

  const reference = `refs/tags/${name}`;
  const referenceCheck = await runGit(repository, ["check-ref-format", reference]);

  if (referenceCheck.exitCode === 1) {
    throw new GitInspectionError("invalid-tag", `Invalid tag name: ${JSON.stringify(name)}.`);
  }

  requireSuccess(referenceCheck, "Could not validate the tag reference.");

  const object = await runGit(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    reference,
  ]);

  if (object.exitCode === 1) {
    throw new GitInspectionError("tag-not-found", `Tag not found: ${JSON.stringify(name)}.`);
  }

  const objectSha = requireObjectSha(requireSuccess(object, "Could not resolve the tag object."));
  const commit = await runGit(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${objectSha}^{commit}`,
  ]);

  if (commit.exitCode === 1) {
    throw new GitInspectionError(
      "tag-not-commit",
      `Tag does not resolve to a commit: ${JSON.stringify(name)}.`,
    );
  }

  const commitSha = requireObjectSha(requireSuccess(commit, "Could not peel the tag to a commit."));

  return { name, objectSha, commitSha };
}

async function requireCompleteHistory(repository: string): Promise<void> {
  const shallow = await runGit(repository, ["rev-parse", "--is-shallow-repository"]);

  if (shallow.exitCode !== 0) {
    throw new GitInspectionError(
      "repository-unavailable",
      "The selected Git repository is unavailable.",
      {
        cause: new Error(shallow.stderr),
      },
    );
  }

  if (shallow.stdout.trim() === "true") {
    throw new GitInspectionError(
      "shallow-history",
      "Complete Git history is required for inspection.",
    );
  }

  if (shallow.stdout.trim() !== "false") {
    throw new GitInspectionError("git-command-failed", "Git did not report the history depth.");
  }
}

async function resolveCommit(repository: string, sha: string): Promise<string> {
  if (sha.trim() !== sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) {
    throw new GitInspectionError(
      "invalid-commit-sha",
      "Supply a complete lowercase SHA-1 or SHA-256 commit ID, not a ref or revision expression.",
    );
  }

  const object = await runGit(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${sha}^{object}`,
  ]);
  if (object.exitCode === 1) {
    throw new GitInspectionError("commit-not-found", `Commit object not found: ${sha}.`);
  }

  const objectSha = requireObjectSha(
    requireSuccess(object, "Could not resolve the commit object."),
  );
  if (objectSha !== sha) {
    throw new GitInspectionError(
      "invalid-commit-sha",
      "The supplied ID is abbreviated for this repository's object format. Supply the complete commit ID.",
    );
  }

  const type = requireSuccess(
    await runGit(repository, ["cat-file", "-t", objectSha]),
    "Could not inspect the commit object type.",
  ).trim();
  if (type !== "commit") {
    throw new GitInspectionError(
      "object-not-commit",
      `The supplied object is not a commit: ${sha}.`,
    );
  }

  return objectSha;
}

async function isAncestor(repository: string, from: string, to: string): Promise<boolean> {
  const ancestry = await runGit(repository, ["merge-base", "--is-ancestor", from, to]);

  // Missing objects can produce exit 1 as well as an ancestry mismatch.
  if (ancestry.exitCode !== 0 && (ancestry.exitCode !== 1 || ancestry.stderr.trim() !== "")) {
    requireSuccess(
      ancestry,
      "Could not inspect commit ancestry; complete local history is required.",
    );
  }

  return ancestry.exitCode === 0;
}

async function commitsBetween(
  repository: string,
  from: string,
  to: string,
): Promise<readonly string[]> {
  const revisions = await runGit(repository, ["rev-list", to, "--not", from, "--"]);
  const output = requireSuccess(
    revisions,
    "Could not enumerate complete local commit history; obtain missing history explicitly before retrying.",
  );

  return output.trim() === "" ? [] : output.trim().split("\n").map(requireObjectSha).toSorted();
}

export async function inspectTagRange(
  repository: string,
  fromTag: string,
  toTag: string,
): Promise<TagRangeInspection> {
  await requireCompleteHistory(repository);
  const from = await resolveTag(repository, fromTag);
  const to = await resolveTag(repository, toTag);
  const fromIsAncestor = await isAncestor(repository, from.commitSha, to.commitSha);
  const commitShas = await commitsBetween(repository, from.commitSha, to.commitSha);

  return { from, to, fromIsAncestor, commitShas };
}

export async function inspectTagDate(
  repository: string,
  tag: ResolvedTag,
): Promise<{
  readonly date: string;
  readonly source: "annotated tag" | "tagged commit committer";
}> {
  const annotated = tag.objectSha !== tag.commitSha;
  const raw = requireSuccess(
    await runGit(repository, [
      "cat-file",
      annotated ? "tag" : "commit",
      requireObjectSha(tag.objectSha),
    ]),
    "Could not read the captured release tag date.",
  );
  const header = raw.split("\n\n", 1)[0] ?? "";
  const record = header
    .split("\n")
    .find((line) => line.startsWith(annotated ? "tagger " : "committer "));
  const seconds = record && / ([+-]?\d+) [+-]\d{4}$/u.exec(record)?.[1];
  const milliseconds = seconds ? Number(seconds) * 1000 : NaN;
  if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000)
    throw new GitInspectionError(
      "git-command-failed",
      "The release tag has no supported recorded date.",
    );
  const timestamp = new Date(milliseconds).toISOString();
  if (!/^\d{4}-/u.test(timestamp))
    throw new GitInspectionError(
      "git-command-failed",
      "The release tag date must have a four-digit year.",
    );
  return {
    date: timestamp.slice(0, 10),
    source: annotated ? "annotated tag" : "tagged commit committer",
  };
}

export async function inspectCommit(
  repository: string,
  commitSha: string,
): Promise<GitCommitEvidence> {
  const sha = await resolveCommit(repository, commitSha);
  const raw = requireSuccess(
    await runGit(repository, ["cat-file", "commit", sha]),
    "Could not read the captured commit object.",
  );
  return parseCommitEvidence(sha, raw);
}

function parseCommitEvidence(sha: string, raw: string): GitCommitEvidence {
  const separator = raw.indexOf("\n\n");
  if (separator === -1)
    throw new GitInspectionError("git-command-failed", "Git returned malformed commit evidence.");
  const parentShas = raw
    .slice(0, separator)
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => requireObjectSha(line.slice(7)));
  return { sha, parentShas, message: raw.slice(separator + 2) };
}

export async function inspectPendingRelease(
  repository: string,
  baseline: PendingReleaseBaseline,
  sourceCommitSha: string,
): Promise<PendingReleaseInspection> {
  if (!baseline || (baseline.kind !== "tag" && baseline.kind !== "bootstrap")) {
    throw new GitInspectionError(
      "invalid-baseline",
      "Select an explicit baseline tag or bootstrap commit; no release baseline is inferred.",
    );
  }

  await requireCompleteHistory(repository);
  const resolved: ResolvedReleaseBaseline =
    baseline.kind === "tag"
      ? { kind: "tag", ...(await resolveTag(repository, baseline.name)) }
      : { kind: "bootstrap", commitSha: await resolveCommit(repository, baseline.commitSha) };
  const source = await resolveCommit(repository, sourceCommitSha);

  // A difference walk can hide missing parents behind the exclusive baseline.
  requireSuccess(
    await runGit(repository, [
      "-c",
      "core.commitGraph=false",
      "rev-list",
      "--count",
      source,
      resolved.commitSha,
      "--",
    ]),
    "Could not verify complete local commit history; obtain missing history explicitly before retrying.",
  );

  if (!(await isAncestor(repository, resolved.commitSha, source))) {
    throw new GitInspectionError(
      "baseline-not-ancestor",
      "The release baseline must be an ancestor of the captured source commit. Select the correct baseline rather than planning a divergent or reversed range.",
    );
  }

  return {
    baseline: resolved,
    sourceCommitSha: source,
    baselineIsAncestor: true,
    commitShas: await commitsBetween(repository, resolved.commitSha, source),
  };
}

export async function inspectOnboardingRange(
  repository: string,
  range: PendingReleaseInspection,
  onboardingSha: string,
): Promise<PendingReleaseInspection> {
  const legacy = await inspectPendingRelease(repository, range.baseline, onboardingSha);
  await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: onboardingSha },
    range.sourceCommitSha,
  );
  return legacy;
}

export async function inspectBranchSource(repository: string, ref: string): Promise<string> {
  if (ref !== "HEAD" && (await runGit(repository, ["check-ref-format", ref])).exitCode !== 0)
    throw new GitInspectionError(
      "git-command-failed",
      "The selected release branch is not a valid Git ref.",
    );
  return requireObjectSha(
    requireSuccess(
      await runGit(repository, ["rev-parse", "--verify", "--end-of-options", ref]),
      "The selected Git ref is unavailable. Fetch the release branch and tags, or supply its full source SHA.",
    ),
  );
}

export async function inspectRootBaseline(repository: string, sourceSha: string): Promise<string> {
  await requireCompleteHistory(repository);
  const source = await resolveCommit(repository, sourceSha);
  return requireObjectSha(
    requireSuccess(
      await runGit(repository, ["rev-list", "--first-parent", "--max-parents=0", source, "--"]),
      "Could not find the first commit on the captured branch.",
    ),
  );
}

export async function inspectStableTags(repository: string): Promise<readonly string[]> {
  const refs = requireSuccess(
    await runGit(repository, ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags/v*"]),
    "Could not inspect local release tags.",
  );
  return refs
    .split("\n")
    .filter((tag) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag));
}

export async function recommendOnboardingCutoff(
  repository: string,
  range: PendingReleaseInspection,
  legacyShas: readonly string[],
): Promise<string> {
  if (legacyShas.length === 0) return range.baseline.commitSha;
  const commits = requireSuccess(
    await runGit(repository, [
      "rev-list",
      "--first-parent",
      "--reverse",
      range.sourceCommitSha,
      "--not",
      range.baseline.commitSha,
      "--",
    ]),
    "Could not enumerate candidate onboarding cutoffs.",
  )
    .trim()
    .split("\n")
    .map(requireObjectSha);
  const required = new Set(legacyShas);
  let low = 0;
  let high = commits.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = commits[middle] ?? range.sourceCommitSha;
    const covers =
      (await isAncestor(repository, range.baseline.commitSha, candidate)) &&
      (
        await inspectPendingRelease(
          repository,
          { kind: "bootstrap", commitSha: range.baseline.commitSha },
          candidate,
        )
      ).commitShas.filter((sha) => required.has(sha)).length === required.size;
    if (covers) high = middle;
    else low = middle + 1;
  }
  return commits[low] ?? range.sourceCommitSha;
}

export interface GitTreeInspection {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly entries: ReadonlyMap<
    string,
    { readonly sha: string; readonly mode: string; readonly type: string }
  >;
}

export async function inspectGitTree(
  repository: string,
  commitSha: string,
): Promise<GitTreeInspection> {
  return (await inspectGitTreeObject(repository, commitSha)).tree;
}

export async function inspectGitTreeWithCommit(repository: string, commitSha: string) {
  const { tree, raw } = await inspectGitTreeObject(repository, commitSha);
  return { tree, commit: parseCommitEvidence(tree.commitSha, raw) };
}

async function inspectGitTreeObject(repository: string, commitSha: string) {
  const commit = await resolveCommit(repository, commitSha);
  const raw = requireSuccess(
    await runGit(repository, ["cat-file", "commit", commit]),
    "Could not read the immutable commit tree header.",
  );
  const match = /^tree ([a-f0-9]{40}|[a-f0-9]{64})\n/u.exec(raw);
  if (!match?.[1])
    throw new GitInspectionError("git-command-failed", "Malformed Git commit tree header.");
  const treeSha = requireObjectSha(match[1]);
  const listing = requireSuccess(
    await runGit(repository, ["ls-tree", "--full-tree", "-r", "-t", "-z", treeSha]),
    "Could not read the complete captured Git tree.",
  );
  const entries = new Map<string, { sha: string; mode: string; type: string }>();
  for (const row of listing.split("\0").filter(Boolean)) {
    const entry = /^([0-9]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
      row,
    );
    const [, mode, type, sha, path] = entry ?? [];
    if (
      !mode ||
      !type ||
      !sha ||
      !path ||
      path.includes("\uFFFD") ||
      path.length > 4096 ||
      entries.has(path) ||
      entries.size >= 50_000
    )
      throw new GitInspectionError(
        "git-command-failed",
        "Git tree paths must be unique, bounded UTF-8 with at most 50000 entries.",
      );
    entries.set(path, { sha: requireObjectSha(sha), mode, type });
  }
  const tree: GitTreeInspection = { commitSha: commit, treeSha, entries };
  return { tree, raw };
}

export async function readGitBlob(repository: string, blobSha: string): Promise<string> {
  const sha = requireObjectSha(blobSha);
  const kind = requireSuccess(
    await runGit(repository, ["cat-file", "-t", sha]),
    "Could not read the expected Git blob object.",
  ).trim();
  if (kind !== "blob")
    throw new GitInspectionError(
      "git-command-failed",
      "Expected a Git blob, not another object type.",
    );
  const size = Number(
    requireSuccess(
      await runGit(repository, ["cat-file", "-s", sha]),
      "Could not determine the Git blob size.",
    ).trim(),
  );
  if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024)
    throw new GitInspectionError("git-command-failed", "Git input blobs must not exceed 2 MiB.");
  const text = requireSuccess(
    await runGit(repository, ["cat-file", "blob", sha]),
    "Could not read the complete Git blob contents.",
  );
  const bytes = Buffer.from(text, "utf8");
  const actual = createHash(sha.length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== size || actual !== sha)
    throw new GitInspectionError(
      "git-command-failed",
      "Git input blobs must be complete, hash-matching UTF-8 text.",
    );
  return text;
}
