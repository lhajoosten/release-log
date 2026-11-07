import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type GitInspectionErrorCode =
  | "repository-unavailable"
  | "shallow-history"
  | "invalid-tag"
  | "tag-not-found"
  | "tag-not-commit"
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

export async function inspectTagRange(
  repository: string,
  fromTag: string,
  toTag: string,
): Promise<TagRangeInspection> {
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

  const from = await resolveTag(repository, fromTag);
  const to = await resolveTag(repository, toTag);
  const ancestry = await runGit(repository, [
    "merge-base",
    "--is-ancestor",
    from.commitSha,
    to.commitSha,
  ]);

  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
    requireSuccess(ancestry, "Could not inspect tag ancestry.");
  }

  const revisions = await runGit(repository, [
    "rev-list",
    to.commitSha,
    "--not",
    from.commitSha,
    "--",
  ]);
  const output = requireSuccess(revisions, "Could not enumerate the commits between tags.");
  const commitShas =
    output.trim() === "" ? [] : output.trim().split("\n").map(requireObjectSha).toSorted();

  return { from, to, fromIsAncestor: ancestry.exitCode === 0, commitShas };
}
