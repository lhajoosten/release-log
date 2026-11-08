import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import { GitInspectionError, inspectPendingRelease, inspectTagRange } from "../src/git.ts";

const execute = promisify(execFile);

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execute(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      `core.hooksPath=${join(directory, "disabled-hooks")}`,
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Release Log Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Release Log Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );

  return stdout.trim();
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "release-log-git-"));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function repository(context: TestContext, objectFormat = "sha1"): Promise<string> {
  const directory = await temporaryDirectory(context);

  await git(directory, ["init", "--initial-branch=main", `--object-format=${objectFormat}`]);

  return directory;
}

async function commit(directory: string, message: string): Promise<string> {
  await git(directory, ["commit", "--allow-empty", "-m", message]);

  return git(directory, ["rev-parse", "HEAD"]);
}

function hasCode(code: GitInspectionError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof GitInspectionError && error.code === code;
}

void test("captures lightweight and annotated tags and sorts the exact commit set", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  const second = await commit(directory, "feat: add exports");
  const third = await commit(directory, "fix: preserve selected rows");
  await git(directory, ["tag", "-a", "v2", "-m", "Release two"]);
  const tagObject = await git(directory, ["rev-parse", "refs/tags/v2"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.deepEqual(result, {
    from: { name: "v1", objectSha: first, commitSha: first },
    to: { name: "v2", objectSha: tagObject, commitSha: third },
    fromIsAncestor: true,
    commitShas: [second, third].toSorted(),
  });
  assert.notEqual(tagObject, third);
});

void test("includes merged side-branch commits and the merge commit", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  await git(directory, ["switch", "-c", "feature"]);
  const feature = await commit(directory, "feat: add exports");
  await git(directory, ["switch", "main"]);
  const main = await commit(directory, "fix: handle retries");
  await git(directory, ["merge", "--no-ff", "feature", "-m", "Merge feature branch"]);
  const merge = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["tag", "v2"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.equal(result.fromIsAncestor, true);
  assert.deepEqual(result.commitShas, [feature, main, merge].toSorted());
});

void test("does not substitute merge dates or commit timestamps for reachability", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  await git(directory, ["switch", "-c", "unmerged"]);
  const excluded = await commit(directory, "feat: not released");
  await git(directory, ["switch", "main"]);
  const included = await commit(directory, "fix: released change");
  await git(directory, ["tag", "v2"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.deepEqual(result.commitShas, [included]);
  assert.equal(result.commitShas.includes(excluded), false);
});

void test("reports divergent ancestry without approving or rejecting a release policy", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["switch", "-c", "other"]);
  await commit(directory, "feat: other branch");
  await git(directory, ["tag", "v1"]);
  await git(directory, ["switch", "main"]);
  const included = await commit(directory, "fix: target branch");
  await git(directory, ["tag", "v2"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.equal(result.fromIsAncestor, false);
  assert.deepEqual(result.commitShas, [included]);
});

void test("returns an empty set for aliases of the same commit", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  await git(directory, ["tag", "-a", "v2", "-m", "Alias"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.equal(result.fromIsAncestor, true);
  assert.deepEqual(result.commitShas, []);
});

void test("returns an empty set and false ancestry for a reversed range", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  await commit(directory, "feat: later change");
  await git(directory, ["tag", "v2"]);

  const result = await inspectTagRange(directory, "v2", "v1");

  assert.equal(result.fromIsAncestor, false);
  assert.deepEqual(result.commitShas, []);
});

void test("does not resolve a branch when the requested tag is missing", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["branch", "v1"]);
  await git(directory, ["tag", "v2"]);

  await assert.rejects(inspectTagRange(directory, "v1", "v2"), hasCode("tag-not-found"));
});

void test("does not resolve a same-named branch instead of an existing tag", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  const second = await commit(directory, "feat: later change");
  await git(directory, ["branch", "v1"]);
  await git(directory, ["tag", "v2"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.equal(result.from.commitSha, first);
  assert.deepEqual(result.commitShas, [second]);
});

for (const name of ["", "v1\0suffix", "v1^{commit}", "v1..v2", "../v1", "v1\nother"]) {
  void test(`rejects invalid tag input ${JSON.stringify(name)}`, async (context) => {
    const directory = await repository(context);

    await assert.rejects(inspectTagRange(directory, name, "v2"), hasCode("invalid-tag"));
  });
}

void test("handles command-looking tag names as literal refs", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  await git(directory, ["update-ref", "refs/tags/-n", first]);
  const second = await commit(directory, "feat: later change");
  await git(directory, ["update-ref", "refs/tags/v2;not-a-command", second]);

  const result = await inspectTagRange(directory, "-n", "v2;not-a-command");

  assert.deepEqual(result.commitShas, [second]);
});

void test("rejects a tag pointing at a tree instead of a commit", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  const tree = await git(directory, ["rev-parse", "HEAD^{tree}"]);
  await git(directory, ["update-ref", "refs/tags/v1", tree]);
  await git(directory, ["tag", "v2"]);

  await assert.rejects(inspectTagRange(directory, "v1", "v2"), hasCode("tag-not-commit"));
});

void test("rejects a directory that is not a Git repository", async (context) => {
  const directory = await temporaryDirectory(context);

  await assert.rejects(inspectTagRange(directory, "v1", "v2"), hasCode("repository-unavailable"));
});

void test("rejects a missing working directory with an actionable execution error", async (context) => {
  const directory = await temporaryDirectory(context);

  await assert.rejects(
    inspectTagRange(join(directory, "missing"), "v1", "v2"),
    hasCode("git-command-failed"),
  );
});

void test("rejects shallow history rather than returning an incomplete range", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  await commit(directory, "feat: later change");
  await git(directory, ["tag", "v2"]);
  const destination = join(await temporaryDirectory(context), "shallow");
  await git(directory, ["clone", "--depth=1", "--no-local", directory, destination]);

  await assert.rejects(inspectTagRange(destination, "v1", "v2"), hasCode("shallow-history"));
});

void test("supports bare repositories", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  const second = await commit(directory, "feat: later change");
  await git(directory, ["tag", "v2"]);
  const destination = join(await temporaryDirectory(context), "bare.git");
  await git(directory, ["clone", "--bare", directory, destination]);

  const result = await inspectTagRange(destination, "v1", "v2");

  assert.deepEqual(result.commitShas, [second]);
});

void test("supports SHA-256 repository object IDs", async (context) => {
  const directory = await repository(context, "sha256");
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  const second = await commit(directory, "feat: later change");
  await git(directory, ["tag", "v2"]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.equal(result.from.commitSha.length, 64);
  assert.deepEqual(result.commitShas, [second]);
});

void test("ignores replacement refs when inspecting the actual commit graph", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  const second = await commit(directory, "feat: middle change");
  const third = await commit(directory, "fix: final change");
  await git(directory, ["tag", "v2"]);
  await git(directory, ["switch", "--orphan", "replacement"]);
  const replacement = await commit(directory, "chore: unrelated replacement");
  await git(directory, ["replace", third, replacement]);

  const result = await inspectTagRange(directory, "v1", "v2");

  assert.equal(result.fromIsAncestor, true);
  assert.deepEqual(result.commitShas, [second, third].toSorted());
});

void test("does not let inherited Git routing inspect a different repository", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: selected repository");
  await git(directory, ["tag", "v1"]);
  await commit(directory, "feat: selected change");
  await git(directory, ["tag", "v2"]);

  const other = await repository(context);
  await commit(other, "chore: unrelated repository");
  await git(other, ["tag", "v1"]);
  await git(other, ["tag", "v2"]);
  const expected = await inspectTagRange(directory, "v1", "v2");
  const moduleUrl = new URL("../src/git.ts", import.meta.url).href;
  const script = `
    const { inspectTagRange } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(await inspectTagRange(${JSON.stringify(directory)}, "v1", "v2")));
  `;

  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script], {
    cwd: other,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_DIR: join(other, ".git"),
      GIT_COMMON_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"),
    },
  });

  assert.equal(stdout.trim(), JSON.stringify(expected));
});

for (const annotated of [false, true]) {
  void test(`inspects a pending release from a ${annotated ? "annotated" : "lightweight"} baseline without a target tag`, async (context) => {
    const directory = await repository(context);
    const first = await commit(directory, "chore: initial state");
    await git(
      directory,
      annotated ? ["tag", "-a", "v1.0.0", "-m", "Released baseline"] : ["tag", "v1.0.0"],
    );
    const objectSha = await git(directory, ["rev-parse", "refs/tags/v1.0.0"]);
    const second = await commit(directory, "feat: add exports");
    const third = await commit(directory, "fix: retain selected rows");

    const result = await inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, third);

    assert.deepEqual(result, {
      baseline: { kind: "tag", name: "v1.0.0", objectSha, commitSha: first },
      sourceCommitSha: third,
      baselineIsAncestor: true,
      commitShas: [second, third].toSorted(),
    });
    assert.equal(await git(directory, ["tag", "--list"]), "v1.0.0");
  });
}

void test("pending inspection includes the complete merged graph and excludes unmerged changes", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  await git(directory, ["switch", "-c", "feature"]);
  const feature = await commit(directory, "feat: add exports");
  await git(directory, ["switch", "main"]);
  const main = await commit(directory, "fix: handle retries");
  await git(directory, ["merge", "--no-ff", "feature", "-m", "Merge feature branch"]);
  const source = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["switch", "-c", "unmerged"]);
  const excluded = await commit(directory, "feat: not yet merged");

  const result = await inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, source);

  assert.deepEqual(result.commitShas, [feature, main, source].toSorted());
  assert.equal(result.commitShas.includes(excluded), false);
  assert.equal(result.sourceCommitSha, source);
});

void test("bootstrap uses a real exclusive commit baseline without inventing tags or versions", async (context) => {
  const directory = await repository(context);
  const bootstrap = await commit(directory, "chore: adoption boundary");
  const source = await commit(directory, "feat: first releasable change");

  const result = await inspectPendingRelease(
    directory,
    { kind: "bootstrap", commitSha: bootstrap },
    source,
  );

  assert.deepEqual(result, {
    baseline: { kind: "bootstrap", commitSha: bootstrap },
    sourceCommitSha: source,
    baselineIsAncestor: true,
    commitShas: [source],
  });
  assert.equal(await git(directory, ["tag", "--list"]), "");
});

void test("pending inspection requires an explicit baseline rather than inferring history", async (context) => {
  const directory = await repository(context);
  const source = await commit(directory, "chore: initial state");
  for (const invalid of [undefined, null, {}, { kind: "whole-history" }]) {
    await assert.rejects(
      Reflect.apply(inspectPendingRelease, undefined, [directory, invalid, source]),
      hasCode("invalid-baseline"),
    );
  }
});

void test("pending inspection accepts an empty range for both baseline forms", async (context) => {
  const directory = await repository(context);
  const source = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  const tag = await inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, source);
  const bootstrap = await inspectPendingRelease(
    directory,
    { kind: "bootstrap", commitSha: source },
    source,
  );

  assert.deepEqual(tag.commitShas, []);
  assert.deepEqual(bootstrap.commitShas, []);
  assert.equal(tag.baselineIsAncestor, true);
  assert.equal(bootstrap.baselineIsAncestor, true);
});

void test("pending inspection rejects reversed and divergent baselines instead of approving an empty or partial plan", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  const later = await commit(directory, "feat: later change");
  await git(directory, ["tag", "v1.0.0"]);
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, first),
    hasCode("baseline-not-ancestor"),
  );
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "bootstrap", commitSha: later }, first),
    hasCode("baseline-not-ancestor"),
  );

  await git(directory, ["switch", "-c", "other", first]);
  const divergent = await commit(directory, "fix: unrelated branch change");
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, divergent),
    hasCode("baseline-not-ancestor"),
  );
});

void test("pending inspection rejects refs, abbreviations, revision expressions, and shell-looking source input", async (context) => {
  const directory = await repository(context);
  const source = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  for (const invalid of [
    "",
    "HEAD",
    "refs/heads/main",
    source.slice(0, 12),
    `${source}^{commit}`,
    "--help",
    "$(touch sentinel)",
    "a;touch sentinel",
    `${source}\0suffix`,
    `${source}\n`,
  ]) {
    await assert.rejects(
      inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, invalid),
      hasCode("invalid-commit-sha"),
    );
  }
  await assert.rejects(access(join(directory, "sentinel")), { code: "ENOENT" });
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "bootstrap", commitSha: "HEAD" }, source),
    hasCode("invalid-commit-sha"),
  );
});

void test("pending inspection rejects absent and non-commit source/bootstrap objects without peeling annotated tag IDs", async (context) => {
  const directory = await repository(context);
  const source = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "-a", "v1.0.0", "-m", "Released baseline"]);
  const tree = await git(directory, ["rev-parse", "HEAD^{tree}"]);
  const tagObject = await git(directory, ["rev-parse", "refs/tags/v1.0.0"]);
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, "0".repeat(40)),
    hasCode("commit-not-found"),
  );
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "bootstrap", commitSha: "0".repeat(40) }, source),
    hasCode("commit-not-found"),
  );
  for (const object of [tree, tagObject]) {
    await assert.rejects(
      inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, object),
      hasCode("object-not-commit"),
    );
    await assert.rejects(
      inspectPendingRelease(directory, { kind: "bootstrap", commitSha: object }, source),
      hasCode("object-not-commit"),
    );
  }
});

void test("pending inspection preserves exact tag validation and never falls back to a branch", async (context) => {
  const directory = await repository(context);
  const source = await commit(directory, "chore: initial state");
  await git(directory, ["branch", "v1.0.0"]);
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, source),
    hasCode("tag-not-found"),
  );
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1^{commit}" }, source),
    hasCode("invalid-tag"),
  );
  const tree = await git(directory, ["rev-parse", "HEAD^{tree}"]);
  await git(directory, ["update-ref", "refs/tags/tree", tree]);
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "tree" }, source),
    hasCode("tag-not-commit"),
  );
  await git(directory, ["update-ref", "refs/tags/-n;literal", source]);
  assert.deepEqual(
    (await inspectPendingRelease(directory, { kind: "tag", name: "-n;literal" }, source))
      .commitShas,
    [],
  );
});

void test("pending inspection rejects shallow and missing-parent history", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  const middle = await commit(directory, "feat: middle change");
  const source = await commit(directory, "fix: target change");
  await git(directory, ["tag", "v2.0.0"]);
  const destination = join(await temporaryDirectory(context), "shallow");
  await git(directory, ["clone", "--depth=1", "--no-local", directory, destination]);
  await assert.rejects(
    inspectPendingRelease(destination, { kind: "tag", name: "v1.0.0" }, source),
    hasCode("shallow-history"),
  );
  await rm(join(directory, ".git", "objects", middle.slice(0, 2), middle.slice(2)));
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, source),
    hasCode("git-command-failed"),
  );
  await assert.rejects(
    inspectTagRange(directory, "v1.0.0", "v2.0.0"),
    hasCode("git-command-failed"),
  );
});

void test("pending inspection rejects missing history before the exclusive baseline even for an empty range", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  const baseline = await commit(directory, "feat: released change");
  await git(directory, ["tag", "v1.0.0"]);
  await commit(directory, "fix: pending change");
  await rm(join(directory, ".git", "objects", first.slice(0, 2), first.slice(2)));

  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, baseline),
    hasCode("git-command-failed"),
  );
});

void test("pending inspection supports bare repositories without changing their refs", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  const source = await commit(directory, "feat: pending change");
  const destination = join(await temporaryDirectory(context), "bare.git");
  await git(directory, ["clone", "--bare", directory, destination]);
  const before = await git(destination, ["show-ref"]);
  assert.deepEqual(
    (await inspectPendingRelease(destination, { kind: "tag", name: "v1.0.0" }, source)).commitShas,
    [source],
  );
  assert.equal(await git(destination, ["show-ref"]), before);
});

void test("pending inspection supports SHA-256 and rejects a 40-character prefix as abbreviated", async (context) => {
  const directory = await repository(context, "sha256");
  const first = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  const source = await commit(directory, "feat: pending change");
  const result = await inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, source);
  assert.equal(result.sourceCommitSha.length, 64);
  assert.deepEqual(result.commitShas, [source]);
  assert.deepEqual(
    (await inspectPendingRelease(directory, { kind: "bootstrap", commitSha: first }, source))
      .commitShas,
    [source],
  );
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, source.slice(0, 40)),
    hasCode("invalid-commit-sha"),
  );
});

void test("pending inspection keeps captured IDs when the baseline tag and source branch move mid-inspection", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "-a", "v1.0.0", "-m", "Released baseline"]);
  const objectSha = await git(directory, ["rev-parse", "refs/tags/v1.0.0"]);
  const source = await commit(directory, "feat: captured source");
  const later = await commit(directory, "fix: later source");
  await git(directory, ["update-ref", "refs/heads/main", source]);
  const moduleUrl = new URL("../src/git.ts", import.meta.url).href;
  const script = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { promisify } from "node:util";
    const original = childProcess.execFile;
    const execute = promisify(original);
    const intercepted = (...args) => original(...args);
    let moved = false;
    intercepted[promisify.custom] = async (file, args, options) => {
      const result = await execute(file, args, options);
      if (!moved && args.includes("rev-parse") && args.at(-1) === "refs/tags/v1.0.0") {
        moved = true;
        await execute("git", ["--no-pager", "--no-optional-locks", "update-ref", "refs/tags/v1.0.0", ${JSON.stringify(later)}], options);
        await execute("git", ["--no-pager", "--no-optional-locks", "update-ref", "refs/heads/main", ${JSON.stringify(later)}], options);
      }
      return result;
    };
    childProcess.execFile = intercepted;
    syncBuiltinESMExports();
    const { inspectPendingRelease } = await import(${JSON.stringify(moduleUrl)});
    const result = await inspectPendingRelease(${JSON.stringify(directory)}, {kind: "tag", name: "v1.0.0"}, ${JSON.stringify(source)});
    if (!moved) throw new Error("Ref-movement fixture did not execute");
    console.log(JSON.stringify(result));
  `;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.deepEqual(JSON.parse(stdout), {
    baseline: { kind: "tag", name: "v1.0.0", objectSha, commitSha: first },
    sourceCommitSha: source,
    baselineIsAncestor: true,
    commitShas: [source],
  });
  assert.equal(await git(directory, ["rev-parse", "refs/tags/v1.0.0"]), later);
  assert.equal(await git(directory, ["rev-parse", "refs/heads/main"]), later);
});

void test("pending inspection ignores replacement refs and preserves deterministic captured output", async (context) => {
  const directory = await repository(context);
  const first = await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1.0.0"]);
  const middle = await commit(directory, "feat: middle change");
  const source = await commit(directory, "fix: target change");
  await git(directory, ["switch", "--orphan", "replacement"]);
  const replacement = await commit(directory, "chore: unrelated replacement");
  await git(directory, ["replace", source, replacement]);
  const result = await inspectPendingRelease(
    directory,
    { kind: "bootstrap", commitSha: first },
    source,
  );
  assert.deepEqual(result.commitShas, [middle, source].toSorted());
  assert.deepEqual(
    await inspectPendingRelease(directory, { kind: "bootstrap", commitSha: first }, source),
    result,
  );
});

void test("pending inspection reports unavailable repositories using existing error codes", async (context) => {
  const directory = await temporaryDirectory(context);
  await assert.rejects(
    inspectPendingRelease(directory, { kind: "tag", name: "v1.0.0" }, "a".repeat(40)),
    hasCode("repository-unavailable"),
  );
});

void test("produces identical data on repeated inspection", async (context) => {
  const directory = await repository(context);
  await commit(directory, "chore: initial state");
  await git(directory, ["tag", "v1"]);
  await commit(directory, "feat: later change");
  await git(directory, ["tag", "v2"]);

  const first = await inspectTagRange(directory, "v1", "v2");
  const second = await inspectTagRange(directory, "v1", "v2");

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
