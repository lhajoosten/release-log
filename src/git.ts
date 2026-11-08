import { execFile } from "node:child_process";
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

export async function inspectCommit(
  repository: string,
  commitSha: string,
): Promise<GitCommitEvidence> {
  const sha = await resolveCommit(repository, commitSha);
  const raw = requireSuccess(
    await runGit(repository, ["cat-file", "commit", sha]),
    "Could not read the captured commit object.",
  );
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
