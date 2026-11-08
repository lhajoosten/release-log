import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const config = fileURLToPath(new URL("../commitlint.config.mjs", import.meta.url));
const cli = fileURLToPath(import.meta.resolve("@commitlint/cli/cli.js"));
const rangeScript = fileURLToPath(new URL("../scripts/check-commit-range.ts", import.meta.url));
const prConfig = fileURLToPath(new URL("../commitlint.pr.config.mjs", import.meta.url));

async function repository(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "release-log-commitlint-"));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await git(directory, ["init", "--initial-branch=main"]);
  await git(directory, ["commit", "--allow-empty", "-m", "chore: initial state"]);

  return directory;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execute(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "commit.gpgSign=false",
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
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );

  return stdout.trim();
}

function checkCommits(directory: string, args: readonly string[]) {
  return execute(process.execPath, [rangeScript, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
}

void test("commit-range checks accept generated merges and conventional side-branch commits", async (context) => {
  const directory = await repository(context);
  const base = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["switch", "-c", "feature"]);
  await git(directory, ["commit", "--allow-empty", "-m", "feat: add exports"]);
  await git(directory, ["switch", "main"]);
  await git(directory, [
    "merge",
    "--no-ff",
    "feature",
    "-m",
    "Merge pull request #1 from example/feature\n\nfeat: add exports",
  ]);

  await checkCommits(directory, ["--from", base, "--to", "HEAD"]);
});

for (const [name, merged, message] of [
  ["linear commits", false, "not conventional"],
  ["merged side-branch commits", true, "not conventional"],
  ["merge-looking single-parent commits", false, "Merge pull request #1 from example/feature"],
  ["scoped commits", false, "feat(exports): add exports"],
] as const) {
  void test(`commit-range checks reject invalid ${name}`, async (context) => {
    const directory = await repository(context);
    const base = await git(directory, ["rev-parse", "HEAD"]);
    await git(directory, ["switch", "-c", "feature"]);
    await git(directory, ["commit", "--allow-empty", "-m", message]);

    if (merged) {
      await git(directory, ["switch", "main"]);
      await git(directory, [
        "merge",
        "--no-ff",
        "feature",
        "-m",
        "Merge pull request #1 from example/feature",
      ]);
    }

    await assert.rejects(
      checkCommits(directory, ["--from", base, "--to", "HEAD"]),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stdout" in error && "code" in error);
        assert.equal(error.code, 1);
        assert.ok(String(error.stdout).includes(message));
        assert.match(String(error.stdout), /type-empty|scope-empty/);
        return true;
      },
    );
  });
}

for (const args of [
  [],
  ["--from", "HEAD"],
  ["--to", "HEAD"],
  ["--from", "", "--to", "HEAD"],
  ["--from", "HEAD", "--to", ""],
]) {
  void test(`commit-range checks explain missing bounds for ${JSON.stringify(args)}`, async (context) => {
    const directory = await repository(context);

    await assert.rejects(checkCommits(directory, args), (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && "code" in error);
      assert.equal(error.code, 1);
      assert.match(
        String(error.stderr),
        /Usage: pnpm check:commit-range --from <base> --to <head>/,
      );
      return true;
    });
  });
}

void test("commit-range checks honor both bounds and continue after an invalid commit", async (context) => {
  const directory = await repository(context);
  await git(directory, ["commit", "--allow-empty", "-m", "invalid excluded base"]);
  const base = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["commit", "--allow-empty", "-m", "feat: add exports"]);
  const first = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["commit", "--allow-empty", "-m", "invalid included message"]);
  const invalid = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["commit", "--allow-empty", "-m", "fix: preserve selection"]);
  const target = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["commit", "--allow-empty", "-m", "invalid excluded head"]);

  await assert.rejects(
    checkCommits(directory, ["--from", base, "--to", target]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "code" in error);
      assert.equal(error.code, 1);
      const output = String(error.stdout);
      const validated = [...output.matchAll(/Validating commit ([a-f0-9]+)/g)].map(
        (match) => match[1],
      );
      assert.deepEqual(validated, [target, invalid, first]);
      assert.match(output, /invalid included message/);
      assert.doesNotMatch(output, /invalid excluded/);
      return true;
    },
  );
});

for (const failure of ["launch error", "signal termination"]) {
  void test(`commit-range checks fail closed on Commitlint ${failure}`, async (context) => {
    const directory = await repository(context);
    const base = await git(directory, ["rev-parse", "HEAD"]);
    await git(directory, ["commit", "--allow-empty", "-m", "feat: add exports"]);
    const head = await git(directory, ["rev-parse", "HEAD"]);
    const result =
      failure === "launch error"
        ? '{ error: new Error("synthetic Commitlint launch failure"), status: null }'
        : '{ status: null, signal: "SIGTERM" }';
    // Replace only the Commitlint process boundary; range selection still uses real Git.
    const bootstrap = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      childProcess.spawnSync = () => (${result});
      syncBuiltinESMExports();
      process.argv = [process.execPath, "--from", ${JSON.stringify(base)}, "--to", "HEAD"];
      await import(${JSON.stringify(pathToFileURL(rangeScript).href)});
    `;

    await assert.rejects(
      execute(process.execPath, ["--input-type=module", "--eval", bootstrap], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && "stdout" in error && "stderr" in error && "code" in error,
        );
        assert.equal(error.code, 1);
        assert.ok(String(error.stdout).includes(`Validating commit ${head}`), String(error.stderr));

        if (failure === "launch error") {
          assert.match(String(error.stderr), /synthetic Commitlint launch failure/);
        }

        return true;
      },
    );
  });
}

void test("commit-range checks do not load policy from the inspected repository", async (context) => {
  const directory = await repository(context);
  const base = await git(directory, ["rev-parse", "HEAD"]);
  await writeFile(
    join(directory, "commitlint.config.mjs"),
    'throw new Error("untrusted policy loaded");\n',
  );
  await git(directory, ["commit", "--allow-empty", "-m", "not conventional"]);

  await assert.rejects(
    checkCommits(directory, ["--from", base, "--to", "HEAD"]),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && "stdout" in error && "stderr" in error && "code" in error,
      );
      assert.equal(error.code, 1);
      assert.match(String(error.stdout), /type-empty/);
      assert.doesNotMatch(String(error.stderr), /untrusted policy loaded/);
      return true;
    },
  );
});

void test("commit-range checks accept an empty range", async (context) => {
  const directory = await repository(context);

  await checkCommits(directory, ["--from", "HEAD", "--to", "HEAD"]);
});

for (const [from, to] of [
  ["missing", "HEAD"],
  ["HEAD", "missing"],
] as const) {
  void test(`commit-range checks reject invalid refs in ${from}..${to}`, async (context) => {
    const directory = await repository(context);

    await assert.rejects(
      checkCommits(directory, ["--from", from, "--to", to]),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error && "code" in error);
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /Not a valid object name missing/);
        return true;
      },
    );
  });
}

void test("commit-range checks reject unrelated histories", async (context) => {
  const directory = await repository(context);
  const base = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, ["switch", "--orphan", "unrelated"]);
  await git(directory, ["commit", "--allow-empty", "-m", "feat: unrelated history"]);

  await assert.rejects(
    checkCommits(directory, ["--from", base, "--to", "HEAD"]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "code" in error);
      assert.equal(error.code, 1);
      assert.doesNotMatch(String(error.stdout), /Validating commit/);
      return true;
    },
  );
});

void test("commit-range checks reject shallow history", async (context) => {
  const directory = await repository(context);
  const destination = join(directory, "shallow");
  await git(directory, ["clone", "--depth=1", "--no-local", directory, destination]);

  await assert.rejects(
    checkCommits(destination, ["--from", "HEAD", "--to", "HEAD"]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error);
      assert.match(String(error.stderr), /require full history/);
      return true;
    },
  );
});

function checkMessage(policy: string, message: string) {
  const pending = execute(process.execPath, [cli, "--config", policy], {
    encoding: "utf8",
    timeout: 10_000,
  });
  pending.child.stdin?.end(message);
  return pending;
}

for (const type of ["feat", "fix", "refactor"]) {
  void test(`${type} messages require unscoped commits and scoped PR titles`, async () => {
    await checkMessage(config, `${type}: update exports`);
    await checkMessage(prConfig, `${type}(exports): update exports`);
    await assert.rejects(checkMessage(config, `${type}(exports): update exports`));
    await assert.rejects(checkMessage(prConfig, `${type}: update exports`));
  });
}

for (const policy of [config, prConfig]) {
  void test(`${policy} keeps type and generated-message validation strict`, async () => {
    await assert.rejects(checkMessage(policy, "feature(exports): update exports"));
    await assert.rejects(checkMessage(policy, "Merge pull request #1 from example/feature"));
  });
}

void test("direct commit-message validation still rejects generated merge messages", async (context) => {
  const directory = await repository(context);
  await git(directory, [
    "commit",
    "--allow-empty",
    "-m",
    "Merge pull request #1 from example/feature",
  ]);

  await assert.rejects(
    execute(
      process.execPath,
      [cli, "--config", config, "--edit", join(directory, ".git", "COMMIT_EDITMSG")],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "code" in error);
      assert.equal(error.code, 1);
      assert.match(String(error.stdout), /type-empty/);
      return true;
    },
  );
});
