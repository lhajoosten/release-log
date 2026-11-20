import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { updateChangelog } from "../src/changelog.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "release-formatting-"));
  const environment = { ...process.env };
  const variables = (await execute("git", ["rev-parse", "--local-env-vars"])).stdout
    .trim()
    .split("\n");
  for (const name of Object.keys(environment)) {
    if (variables.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name))
      delete environment[name];
  }
  async function run(file: string, args: string[]) {
    return (await execute(file, args, { cwd: directory, env: environment, timeout: 30_000 }))
      .stdout;
  }
  const git = (args: string[]) =>
    run("git", [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=Formatting Fixture",
      "-c",
      "user.email=format@example.invalid",
      ...args,
    ]);
  const pkg: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(
    typeof pkg === "object" &&
      pkg !== null &&
      "scripts" in pkg &&
      typeof pkg.scripts === "object" &&
      pkg.scripts !== null,
  );
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, ".release-log"));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  for (const name of [".oxfmtrc.json", "lefthook.yml", "scripts/check-hook.ts"])
    await copyFile(join(root, name), join(directory, name));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, check: "oxfmt --check ." } }),
  );
  // The fixture shares installed tools; running a script must never try to install dependencies.
  await writeFile(join(directory, "pnpm-workspace.yaml"), "verifyDepsBeforeRun: false\n");
  await writeFile(join(directory, ".gitignore"), "node_modules/\n");
  await run("pnpm", ["format"]);
  await git(["init", "--initial-branch=main"]);
  return { directory, run, git };
}

const released = "# Changelog\n\n## v0.1.0\n\nPreserved release.\n\n";
const generated = updateChangelog(released, "## v0.2.0\n\n### Features\n\n- New feature.\n");
const snapshot = '{"schemaVersion":1,"captured":"canonical bytes"}\n';

void test("format and check preserve generated changelog/snapshot bytes while formatting maintained files", async () => {
  const f = await fixture();
  try {
    assert.ok(generated.endsWith(released.slice("# Changelog\n\n".length)));
    await writeFile(join(f.directory, "CHANGELOG.md"), generated);
    await writeFile(join(f.directory, ".release-log/inputs.json"), snapshot);
    // This reproduces the release PR's trailing blank line without invalidating its generated content.
    await f.run("pnpm", ["check:format"]);
    await writeFile(join(f.directory, "maintained.ts"), "export const value=1\n");
    await assert.rejects(f.run("pnpm", ["check:format"]));
    await f.run("pnpm", ["format"]);
    await f.run("pnpm", ["check:format"]);
    assert.equal(await readFile(join(f.directory, "CHANGELOG.md"), "utf8"), generated);
    assert.equal(await readFile(join(f.directory, ".release-log/inputs.json"), "utf8"), snapshot);
    assert.equal(
      await readFile(join(f.directory, "maintained.ts"), "utf8"),
      "export const value = 1;\n",
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

void test(
  "pre-commit formats/restages selected content and restores partially staged and unrelated edits",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      const middle = Array.from(
        { length: 20 },
        (_, index) => `export const separator${index} = ${index};\n`,
      ).join("");
      const original = `export const staged = 1;\n${middle}export const unselected = 1;\n`;
      await writeFile(join(f.directory, "partial.ts"), original);
      await writeFile(join(f.directory, "unrelated.ts"), "export const unrelated = 1;\n");
      await f.git(["add", "."]);
      await f.git(["commit", "-m", "chore: initialize fixture"]);
      const staged = `export const staged=2\n${middle}export const unselected = 1;\n`;
      await writeFile(join(f.directory, "partial.ts"), staged);
      await f.git(["add", "partial.ts"]);
      const unstaged = staged.replace("unselected = 1", "unselected = 2");
      await writeFile(join(f.directory, "partial.ts"), unstaged);
      await writeFile(join(f.directory, "unrelated.ts"), "export const unrelated = 2;\n");
      const name = "notes $(touch unexpected).md";
      await writeFile(join(f.directory, name), "# Heading   \n\nSelected content.   \n");
      await writeFile(join(f.directory, "--config=unexpected.md"), "# Positional filename   \n");
      await writeFile(join(f.directory, "CHANGELOG.md"), generated);
      await writeFile(join(f.directory, ".release-log/inputs.json"), snapshot);
      await f.git([
        "add",
        "--",
        name,
        "--config=unexpected.md",
        "CHANGELOG.md",
        ".release-log/inputs.json",
      ]);
      await f.run("pnpm", ["exec", "lefthook", "run", "pre-commit"]);
      const formatted = staged.replace("staged=2", "staged = 2;");
      assert.equal(await f.git(["show", ":partial.ts"]), formatted);
      assert.equal(
        await readFile(join(f.directory, "partial.ts"), "utf8"),
        formatted.replace("unselected = 1", "unselected = 2"),
      );
      assert.equal(await f.git(["show", ":unrelated.ts"]), "export const unrelated = 1;\n");
      assert.equal(
        await readFile(join(f.directory, "unrelated.ts"), "utf8"),
        "export const unrelated = 2;\n",
      );
      assert.equal(await f.git(["show", `:${name}`]), "# Heading\n\nSelected content.\n");
      assert.equal(await f.git(["show", ":--config=unexpected.md"]), "# Positional filename\n");
      assert.equal(await f.git(["show", ":CHANGELOG.md"]), generated);
      assert.equal(await f.git(["show", ":.release-log/inputs.json"]), snapshot);
      await assert.rejects(readFile(join(f.directory, "unexpected")), { code: "ENOENT" });
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

void test("a formatter error stops the hook before validation and preserves the staged file", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "package.json");
    const pkg: unknown = JSON.parse(await readFile(path, "utf8"));
    assert.ok(
      typeof pkg === "object" &&
        pkg !== null &&
        "scripts" in pkg &&
        typeof pkg.scripts === "object" &&
        pkg.scripts !== null,
    );
    await writeFile(
      path,
      JSON.stringify({
        ...pkg,
        scripts: {
          ...pkg.scripts,
          check:
            "node --input-type=module -e \"import {writeFileSync} from 'node:fs'; writeFileSync('check-ran', 'unexpected')\"",
        },
      }),
    );
    await f.run("pnpm", ["format"]);
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "chore: initialize fixture"]);
    const invalid = "export const =\n";
    await writeFile(join(f.directory, "invalid.ts"), invalid);
    await f.git(["add", "invalid.ts"]);
    await assert.rejects(f.run("pnpm", ["exec", "lefthook", "run", "pre-commit"]));
    await assert.rejects(readFile(join(f.directory, "check-ran")), { code: "ENOENT" });
    assert.equal(await f.git(["show", ":invalid.ts"]), invalid);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

void test("a commit containing only generated release files needs no formatter matches", async () => {
  const f = await fixture();
  try {
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "chore: initialize fixture"]);
    await writeFile(join(f.directory, "CHANGELOG.md"), generated);
    await writeFile(join(f.directory, ".release-log/inputs.json"), snapshot);
    await f.git(["add", "CHANGELOG.md", ".release-log/inputs.json"]);
    await f.run("pnpm", ["exec", "lefthook", "run", "pre-commit"]);
    assert.equal(await f.git(["show", ":CHANGELOG.md"]), generated);
    assert.equal(await f.git(["show", ":.release-log/inputs.json"]), snapshot);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
