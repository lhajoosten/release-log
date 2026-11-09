import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const runner = fileURLToPath(new URL("../scripts/check-hook.ts", import.meta.url));

void test("pre-commit delegates to the isolated runner without changing commit-message validation", async () => {
  const config: unknown = parse(
    await readFile(new URL("../lefthook.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(config, {
    "pre-commit": { commands: { check: { run: "node scripts/check-hook.ts" } } },
    "commit-msg": {
      commands: { "conventional-commit": { run: 'pnpm check:commits --edit "{1}"' } },
    },
  });
});

void test(
  "hook checks in a linked worktree isolate fixture Git writes and preserve check exit status",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-hook-isolation-"));
    const localVariables = (
      await execute("git", ["--no-pager", "rev-parse", "--local-env-vars"], { timeout: 10_000 })
    ).stdout
      .trim()
      .split("\n");
    const environment = { ...process.env };
    for (const name of localVariables) delete environment[name];
    async function git(cwd: string, args: string[]) {
      return (
        await execute(
          "git",
          [
            "--no-pager",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "user.name=Hook Fixture",
            "-c",
            "user.email=hook@example.invalid",
            ...args,
          ],
          { cwd, env: environment, timeout: 10_000 },
        )
      ).stdout.trim();
    }
    try {
      const repository = join(directory, "repository");
      const worktree = join(directory, "worktree");
      const fixture = join(directory, "fixture");
      const bin = join(directory, "bin");
      const callPath = join(directory, "check-call.json");
      await Promise.all([mkdir(repository), mkdir(fixture), mkdir(bin)]);
      await git(repository, ["init", "--initial-branch=main"]);
      await writeFile(join(repository, "protected.txt"), "preserve the real worktree\n");
      await git(repository, ["add", "protected.txt"]);
      await git(repository, ["commit", "-m", "chore: initialize fixture"]);
      await git(repository, ["worktree", "add", "--detach", worktree]);
      const gitDirectory = await git(worktree, ["rev-parse", "--absolute-git-dir"]);
      const beforeHead = await git(worktree, ["rev-parse", "HEAD"]);
      const beforeIndex = await readFile(join(gitDirectory, "index"));
      const beforeConfig = await readFile(join(repository, ".git", "config"));
      const pnpm = join(bin, "pnpm");
      await writeFile(
        pnpm,
        `#!${process.execPath}
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
assert.deepEqual(process.argv.slice(2), ["check"]);
writeFileSync(${JSON.stringify(callPath)}, JSON.stringify({gitVariables:Object.keys(process.env).filter(name => ${JSON.stringify(localVariables)}.includes(name) || name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")), preserved:process.env.HOOK_FIXTURE_VALUE}));
const args=["--no-pager","-C",${JSON.stringify(fixture)},"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false","-c","user.name=Hook Fixture","-c","user.email=hook@example.invalid"];
execFileSync("git",[...args,"init","--initial-branch=main"]);
execFileSync("git",[...args,"commit","--allow-empty","-m","chore: create a disposable fixture"]);
process.exit(Number(process.env.HOOK_FIXTURE_EXIT));
`,
      );
      await chmod(pnpm, 0o755);
      for (const exit of [0, 17]) {
        const operation = execute(process.execPath, [runner], {
          cwd: worktree,
          timeout: 10_000,
          env: {
            ...environment,
            PATH: `${bin}:${environment.PATH ?? ""}`,
            GIT_DIR: gitDirectory,
            GIT_COMMON_DIR: join(repository, ".git"),
            GIT_WORK_TREE: worktree,
            GIT_INDEX_FILE: join(gitDirectory, "index"),
            GIT_PREFIX: "subdirectory/",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.bare",
            GIT_CONFIG_VALUE_0: "true",
            HOOK_FIXTURE_VALUE: "preserved",
            HOOK_FIXTURE_EXIT: String(exit),
          },
        });
        if (exit === 0) await operation;
        else
          await assert.rejects(
            operation,
            (error: unknown) => error instanceof Error && "code" in error && error.code === 17,
          );
        const call: unknown = JSON.parse(await readFile(callPath, "utf8"));
        assert.ok(
          typeof call === "object" &&
            call !== null &&
            "gitVariables" in call &&
            "preserved" in call,
        );
        assert.deepEqual(call.gitVariables, []);
        assert.equal(call.preserved, "preserved");
        assert.equal(await git(worktree, ["rev-parse", "HEAD"]), beforeHead);
        assert.deepEqual(await readFile(join(gitDirectory, "index")), beforeIndex);
        assert.deepEqual(await readFile(join(repository, ".git", "config")), beforeConfig);
        assert.equal(
          await readFile(join(worktree, "protected.txt"), "utf8"),
          "preserve the real worktree\n",
        );
        assert.equal(
          await git(fixture, ["log", "-1", "--format=%s"]),
          "chore: create a disposable fixture",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
