import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

void test(
  "packed CLI installs with production dependencies and exercises offline Node/Python planning and writes",
  { timeout: 90_000 },
  async (context) => {
    const path = await mkdtemp(join(tmpdir(), "release-cli-package-"));
    context.after(() => rm(path, { recursive: true, force: true }));
    await execute("pnpm", ["pack", "--pack-destination", path], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const archives = (await readdir(path)).filter((file) => file.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    const archive = archives[0];
    assert.ok(archive);
    const consumer = join(path, "consumer");
    await mkdir(consumer);
    await execute(
      "tar",
      ["-xzf", join(path, archive), "--strip-components=1", "--directory", consumer],
      { timeout: 10_000 },
    );
    const installed = consumer;
    await writeFile(
      join(consumer, "pnpm-lock.yaml"),
      await readFile(join(installed, "dist", "dependency-lock.txt")),
    );
    await execute(
      "pnpm",
      ["install", "--offline", "--prod", "--frozen-lockfile", "--ignore-scripts"],
      {
        cwd: consumer,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const entries = await readdir(installed);
    assert.ok(
      !entries.includes("tests") &&
        !entries.includes(".env") &&
        !entries.includes("scripts") &&
        !entries.includes("src"),
    );
    const runtime: unknown = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.ok(typeof runtime === "object" && runtime !== null && "devDependencies" in runtime);
    const development = runtime.devDependencies;
    assert.ok(typeof development === "object" && development !== null);
    // A dependency's dev declarations can remain in its manifest; they must not be installed.
    for (const name of Object.keys(development))
      await assert.rejects(readFile(join(installed, "node_modules", name, "package.json")), {
        code: "ENOENT",
      });
    const cli = join(installed, "dist", "src", "cli.js");
    assert.ok(!(await readFile(cli, "utf8")).includes("./release-plan.ts"));
    assert.equal(
      await readFile(join(installed, "dist", "dependency-lock.txt"), "utf8"),
      await readFile(join(root, "pnpm-lock.yaml"), "utf8"),
    );
    const prelude = join(path, "offline.mjs");
    await writeFile(
      prelude,
      'globalThis.fetch = () => { throw new Error("Unexpected network access"); };\n',
    );
    async function run(args: string[], githubToken = "") {
      return execute(process.execPath, ["--import", prelude, cli, ...args], {
        cwd: consumer,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GITHUB_TOKEN: githubToken },
      });
    }
    assert.match((await run(["--help"])).stdout, /pyproject.toml/u);
    assert.equal((await run(["--version"])).stdout, "0.0.0\n");
    await assert.rejects(
      run(["unknown"]),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("Unknown command"),
    );
    const snapshot = await releaseFixture([{ title: "fix(api): retain keys" }]);
    const configPath = join(path, "config.json");
    const snapshotPath = join(path, "snapshot.json");
    await writeFile(configPath, JSON.stringify(fixtureConfiguration));
    await writeFile(snapshotPath, snapshot.serialized);
    const args = ["--config", configPath, "--snapshot", snapshotPath, "--current-version", "1.2.3"];
    const plan: unknown = JSON.parse((await run(["plan", ...args])).stdout);
    assert.ok(
      typeof plan === "object" &&
        plan !== null &&
        "nextVersion" in plan &&
        plan.nextVersion === "1.2.4",
    );
    assert.match((await run(["render", ...args])).stdout, /^## v1\.2\.4/u);
    for (const mode of ["node", "python", "both"]) {
      const repository = join(path, mode);
      await mkdir(repository);
      if (mode !== "python")
        await writeFile(
          join(repository, "package.json"),
          '{"version":"1.2.3","scripts":{"prepare":"do-not-run"}}\n',
        );
      if (mode !== "node")
        await writeFile(join(repository, "pyproject.toml"), '[project]\nversion="1.2.3" # keep\n');
      const before = await readdir(repository);
      assert.match(
        (await run(["prepare", ...args, "--repository", repository, "--dry-run"])).stdout,
        /"mode": "dry-run"/u,
      );
      assert.deepEqual(await readdir(repository), before);
      await run(["prepare", ...args, "--repository", repository, "--write"]);
      if (mode !== "python")
        assert.match(
          await readFile(join(repository, "package.json"), "utf8"),
          /"version":"1.2.4"/u,
        );
      if (mode !== "node")
        assert.equal(
          await readFile(join(repository, "pyproject.toml"), "utf8"),
          '[project]\nversion="1.2.4" # keep\n',
        );
    }
    await assert.rejects(
      run(["plan", ...args, "--write"]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 2,
    );
    await assert.rejects(
      run([
        "collect",
        "--config",
        configPath,
        "--repository",
        consumer,
        "--source",
        "a".repeat(40),
        "--bootstrap-sha",
        "0".repeat(40),
      ]),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GITHUB_TOKEN"),
    );
    await writeFile(
      snapshotPath,
      snapshot.serialized.replace('"schemaVersion":1', '"schemaVersion":99'),
    );
    await assert.rejects(
      run(["plan", ...args], "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        !error.stderr.includes("synthetic-secret-never-print"),
    );
  },
);
