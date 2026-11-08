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

    const bootstrap = await releaseFixture([], null, [
      "chore: add the license",
      "feat: import historical exports",
    ]);
    const bootstrapPath = join(path, "bootstrap.json");
    await writeFile(bootstrapPath, bootstrap.serialized);

    const bootstrapArgs = [
      "--config",
      configPath,
      "--snapshot",
      bootstrapPath,
      "--initial-version",
      "0.1.0",
    ];
    const bootstrapPlan: unknown = JSON.parse((await run(["plan", ...bootstrapArgs])).stdout);

    assert.ok(
      typeof bootstrapPlan === "object" &&
        bootstrapPlan !== null &&
        "nextVersion" in bootstrapPlan &&
        "bootstrapContributions" in bootstrapPlan,
    );
    assert.equal(bootstrapPlan.nextVersion, "0.1.0");
    assert.ok(Array.isArray(bootstrapPlan.bootstrapContributions));
    assert.equal(bootstrapPlan.bootstrapContributions.length, 2);

    assert.match(
      (await run(["render", ...bootstrapArgs])).stdout,
      /\[bootstrap commit\]: import historical exports/u,
    );

    const bootstrapRepository = join(path, "bootstrap-repository");
    await mkdir(bootstrapRepository);
    await writeFile(join(bootstrapRepository, "package.json"), '{"version":"0.0.0"}\n');
    await writeFile(join(bootstrapRepository, "pyproject.toml"), '[project]\nversion="0.0.0"\n');

    await run(["prepare", ...bootstrapArgs, "--repository", bootstrapRepository, "--write"]);

    assert.equal(
      await readFile(join(bootstrapRepository, "package.json"), "utf8"),
      '{"version":"0.1.0"}\n',
    );
    assert.equal(
      await readFile(join(bootstrapRepository, "pyproject.toml"), "utf8"),
      '[project]\nversion="0.1.0"\n',
    );

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
    const automationPath = join(path, "automation.json");
    await writeFile(automationPath, JSON.stringify({ schemaVersion: 1, botUserId: 42 }));
    await assert.rejects(
      run(["propose", ...args, "--automation", automationPath]),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GITHUB_TOKEN"),
    );
    await assert.rejects(
      run(
        ["propose", ...args, "--automation", automationPath, "--dry-run"],
        "synthetic-secret-never-print",
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GitHub read failed") &&
        !error.stderr.includes("synthetic-secret-never-print"),
    );
    const approvalPath = join(path, "approval.json");
    const policyPath = join(path, "policy.json");
    const approval = {
      schemaVersion: 1,
      repositoryId: 17,
      pullNumber: 1,
      approverUserId: 7,
      sourceSha: "a".repeat(40),
      headSha: "b".repeat(40),
      landingSha: "c".repeat(40),
      mergeKind: "merge",
      baseline: { kind: "bootstrap", commitSha: "d".repeat(40) },
      snapshotId: "e".repeat(64),
      proposalId: "f".repeat(64),
    };
    await writeFile(approvalPath, JSON.stringify(approval));
    await writeFile(
      policyPath,
      JSON.stringify({ schemaVersion: 1, botUserId: 42, approverUserIds: [7] }),
    );
    const approvalArgs = [
      "verify-approval",
      "--config",
      configPath,
      "--approval",
      approvalPath,
      "--policy",
      policyPath,
      "--repository",
      consumer,
    ];
    await assert.rejects(
      run([...approvalArgs, "--write"]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 2,
    );
    await assert.rejects(
      run(approvalArgs),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GITHUB_TOKEN"),
    );
    await assert.rejects(
      run(approvalArgs, "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GitHub read failed") &&
        !error.stderr.includes("synthetic-secret-never-print"),
    );
    await writeFile(approvalPath, JSON.stringify({ ...approval, valid: true }));
    await assert.rejects(
      run(approvalArgs),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("supported schema fields"),
    );
    await writeFile(approvalPath, JSON.stringify(approval));
    await writeFile(
      policyPath,
      '{"schemaVersion":1,"botUserId":42,"approverUserIds":[7],"approverUserIds":[9]}',
    );
    await assert.rejects(
      run(approvalArgs),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("repeat property names"),
    );
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { reconcileReleaseProposal } from "release-log/proposals"; import { verifyReleaseApproval, parseReleaseApproval } from "release-log/approval"; if ([reconcileReleaseProposal, verifyReleaseApproval, parseReleaseApproval].some(value => typeof value !== "function")) throw new Error("Missing packaged proposal/approval API");',
      ],
      { cwd: consumer, timeout: 10_000 },
    );
    await writeFile(
      snapshotPath,
      snapshot.serialized.replace('"schemaVersion":2', '"schemaVersion":99'),
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
