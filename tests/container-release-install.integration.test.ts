import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseDocument } from "yaml";

const execute = promisify(execFile);

void test("container release bootstraps a cold CI install without executing dependency scripts", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/container-release.yml", import.meta.url),
    "utf8",
  );
  const commands = [...workflow.matchAll(/^\s+run: (pnpm[^\n]+)$/gmu)]
    .slice(0, 2)
    .map((match) => match[1]);
  assert.equal(commands.length, 2);
  const directory = await mkdtemp(join(tmpdir(), "release-container-install-"));
  const environment = { ...process.env, CI: "true", npm_config_offline: "true" };
  async function run(args: string[], ci = true) {
    return execute("pnpm", args, {
      cwd: directory,
      env: { ...environment, CI: String(ci) },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  try {
    // A local tarball reproduces esbuild's build-policy boundary without registry access.
    const dependency = join(directory, "package");
    await mkdir(dependency);
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "esbuild",
        version: "0.21.5",
        scripts: { postinstall: "node postinstall.cjs" },
      }),
    );
    await writeFile(
      join(dependency, "postinstall.cjs"),
      "require('node:fs').writeFileSync('build-script-ran', 'unexpected');\n",
    );
    await execute("tar", ["-czf", "esbuild.tgz", "package"], { cwd: directory, timeout: 10_000 });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "release-install-fixture",
        version: "1.0.0",
        private: true,
        packageManager: "pnpm@12.14.0",
        scripts: { "container:release": "node validate.cjs" },
        dependencies: { esbuild: "file:esbuild.tgz" },
      }),
    );
    await writeFile(
      join(directory, "validate.cjs"),
      "require('node:assert/strict').ok(require('node:fs').existsSync('node_modules/esbuild/package.json')); console.log('validated');\n",
    );
    const policy = parseDocument(
      await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
    );
    // This fixture installs only synthetic esbuild, so the SDK declaration patch is unrelated.
    policy.delete("patchedDependencies");
    await writeFile(
      join(directory, "pnpm-workspace.yaml"),
      `${policy.toString()}\nstoreDir: ${JSON.stringify(join(directory, "store"))}\n`,
    );
    await run(["install", "--lockfile-only", "--offline", "--ignore-scripts"], false);
    // Execute the workflow's actual first two pnpm commands, retaining pnpm's automatic
    // pre-script dependency verification. An early script can succeed after a failed install.
    let output = "";
    for (const command of commands) {
      assert.ok(command);
      const args = command.trim().split(/\s+/u);
      assert.equal(args.shift(), "pnpm");
      const result = await run(args);
      output += result.stdout + result.stderr;
    }
    assert.match(output, /validated/u);
    assert.doesNotMatch(output, /ERR_PNPM_IGNORED_BUILDS|install that runs before scripts failed/u);
    await assert.rejects(readFile(join(directory, "node_modules/esbuild/build-script-ran")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
