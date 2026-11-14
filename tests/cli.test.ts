import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";
import { captureReleaseSnapshot, serializeReleaseSnapshot } from "../src/release-snapshot.ts";

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
    async function run(args: string[], githubToken = "", registryToken = "") {
      return execute(process.execPath, ["--import", prelude, cli, ...args], {
        cwd: consumer,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GITHUB_TOKEN: githubToken, GHCR_READ_TOKEN: registryToken },
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
    for (const verbosity of ["detailed", "concise", "one-liner"] as const) {
      const configuration = { ...fixtureConfiguration, changelog: { verbosity } };
      const capture = await captureReleaseSnapshot(snapshot.snapshot.input, configuration);
      const configurationPath = join(path, `config-${verbosity}.json`);
      const capturePath = join(path, `snapshot-${verbosity}.json`);

      await writeFile(configurationPath, JSON.stringify(configuration));
      await writeFile(capturePath, await serializeReleaseSnapshot(capture));

      const selectedArgs = [
        "--config",
        configurationPath,
        "--snapshot",
        capturePath,
        "--current-version",
        "1.2.3",
      ];
      const rendered = (await run(["render", ...selectedArgs])).stdout;
      const repository = join(path, `verbosity-${verbosity}`);

      assert.equal(rendered.includes("  - Impact:"), verbosity === "detailed");
      assert.match(rendered, /^## v1\.2\.4/u);

      await mkdir(repository);
      await writeFile(join(repository, "package.json"), '{"version":"1.2.3"}\n');
      await writeFile(join(repository, "pyproject.toml"), '[project]\nversion="1.2.3"\n');
      await run(["prepare", ...selectedArgs, "--repository", repository, "--write"]);

      assert.ok((await readFile(join(repository, "CHANGELOG.md"), "utf8")).includes(rendered));
      assert.equal(
        await readFile(join(repository, "package.json"), "utf8"),
        '{"version":"1.2.4"}\n',
      );
      assert.equal(
        await readFile(join(repository, "pyproject.toml"), "utf8"),
        '[project]\nversion="1.2.4"\n',
      );
    }

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

    const adoptionConfig = {
      ...fixtureConfiguration,
      schemaVersion: 2 as const,
      bootstrap: {
        baselineSha: bootstrap.snapshot.input.range.baseline.commitSha,
        onboardingSha: bootstrap.snapshot.input.range.sourceCommitSha,
      },
    };
    const adoptionSnapshot = await captureReleaseSnapshot(
      {
        ...bootstrap.snapshot.input,
        bootstrapCommits: bootstrap.snapshot.input.bootstrapCommits.map((entry) => ({
          ...entry,
          message:
            "Set up the old application\n\nBREAKING CHANGE: Select the new startup entry point",
        })),
      },
      adoptionConfig,
    );
    const adoptionConfigPath = join(path, "adoption-config.json");
    const adoptionSnapshotPath = join(path, "adoption-snapshot.json");

    await writeFile(adoptionConfigPath, JSON.stringify(adoptionConfig));
    await writeFile(adoptionSnapshotPath, await serializeReleaseSnapshot(adoptionSnapshot));

    const adoptionArgs = [
      "--config",
      adoptionConfigPath,
      "--snapshot",
      adoptionSnapshotPath,
      "--initial-version",
      "0.1.0",
    ];
    const adoptionPlan: unknown = JSON.parse((await run(["plan", ...adoptionArgs])).stdout);

    assert.ok(
      typeof adoptionPlan === "object" &&
        adoptionPlan !== null &&
        "nextVersion" in adoptionPlan &&
        "historicalContributions" in adoptionPlan,
    );
    assert.equal(adoptionPlan.nextVersion, "0.1.0");
    assert.ok(Array.isArray(adoptionPlan.historicalContributions));
    assert.equal(adoptionPlan.historicalContributions.length, 2);
    assert.match((await run(["render", ...adoptionArgs])).stdout, /Historical changes/u);

    const pythonAdoption = join(path, "python-initial-adoption");

    await mkdir(pythonAdoption);
    await writeFile(join(pythonAdoption, "pyproject.toml"), '[project]\nversion="0.0.0"\n');
    await run(["prepare", ...adoptionArgs, "--repository", pythonAdoption, "--write"]);

    assert.equal(
      await readFile(join(pythonAdoption, "pyproject.toml"), "utf8"),
      '[project]\nversion="0.1.0"\n',
    );
    assert.match(
      await readFile(join(pythonAdoption, "CHANGELOG.md"), "utf8"),
      /Select the new startup entry point/u,
    );

    await assert.rejects(
      run(
        [
          "collect",
          "--config",
          configPath,
          "--repository",
          consumer,
          "--source",
          "a".repeat(40),
          "--bootstrap-sha",
          "0".repeat(40),
        ],
        "synthetic-read-token",
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("fixed bootstrap baselineSha/onboardingSha"),
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
    const tagArgs = [
      "tag-release",
      "--config",
      configPath,
      "--automation",
      automationPath,
      "--pull-number",
      "1",
      "--landing-sha",
      "c".repeat(40),
    ];
    await assert.rejects(
      run(tagArgs),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GITHUB_TOKEN"),
    );
    for (const [option, value, expected] of [
      ["--pull-number", "1.5", /positive safe integer/u],
      ["--landing-sha", "main", /complete lowercase commit ID/u],
    ] as const)
      await assert.rejects(
        run(tagArgs.with(tagArgs.indexOf(option) + 1, value)),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === 2 &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          expected.test(error.stderr),
      );
    await assert.rejects(
      run([...tagArgs, "--dry-run"], "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GitHub read failed") &&
        !error.stderr.includes("synthetic-secret-never-print"),
    );
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
    const publicationPolicyPath = join(path, "publication-policy.json");
    const receiptPath = join(path, "receipt.json");
    const receipt = {
      schemaVersion: 1,
      approvalVerificationId: "a".repeat(64),
      landingSha: approval.landingSha,
      assets: [{ name: "tool.tgz", sha256: "b".repeat(64), size: 1024 }],
      images: [{ name: "ghcr.io/example/project", digest: "sha256:" + "c".repeat(64) }],
    };

    await writeFile(
      publicationPolicyPath,
      JSON.stringify({
        schemaVersion: 1,
        assets: ["tool.tgz"],
        images: ["ghcr.io/example/project"],
      }),
    );
    await writeFile(receiptPath, JSON.stringify(receipt));

    const publicationArgs = [
      "inspect-publication",
      ...approvalArgs.slice(1),
      "--publication-policy",
      publicationPolicyPath,
      "--receipt",
      receiptPath,
    ];

    assert.match((await run(["--help"])).stdout, /inspect-publication/u);

    for (const flag of ["--write", "--dry-run"])
      await assert.rejects(
        run([...publicationArgs, flag]),
        (error: unknown) => error instanceof Error && "code" in error && error.code === 2,
      );

    for (const [githubToken, registryToken, message, code] of [
      ["", "", "GITHUB_TOKEN", 2],
      ["synthetic-secret-never-print", "", "separate pull-scoped", 1],
      ["synthetic-secret-never-print", "synthetic-registry-never-print", "GitHub read failed", 1],
    ] as const)
      await assert.rejects(
        run(publicationArgs, githubToken, registryToken),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === code &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          error.stderr.includes(message) &&
          !error.stderr.includes("synthetic-secret-never-print") &&
          !error.stderr.includes("synthetic-registry-never-print"),
      );

    await writeFile(receiptPath, JSON.stringify({ ...receipt, complete: true }));

    await assert.rejects(
      run(publicationArgs, "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("supported schema fields"),
    );

    await writeFile(receiptPath, JSON.stringify({ ...receipt, landingSha: approval.sourceSha }));

    await assert.rejects(
      run(publicationArgs, "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("exact approved landing"),
    );

    const assetDirectory = join(path, "publication-assets");
    const assetBytes = Buffer.from("packaged CLI fixture bytes");
    const publishArgs = [
      "publish-github",
      ...publicationArgs.slice(1),
      "--asset-directory",
      assetDirectory,
    ];

    await mkdir(assetDirectory);
    await writeFile(join(assetDirectory, "tool.tgz"), assetBytes);
    await writeFile(
      publicationPolicyPath,
      JSON.stringify({ schemaVersion: 1, assets: ["tool.tgz"], images: [] }),
    );
    await writeFile(
      receiptPath,
      JSON.stringify({
        ...receipt,
        images: [],
        assets: [
          {
            name: "tool.tgz",
            sha256: createHash("sha256").update(assetBytes).digest("hex"),
            size: assetBytes.length,
          },
        ],
      }),
    );

    assert.match((await run(["--help"])).stdout, /publish-github/u);

    for (const flags of [[], ["--dry-run"], ["--write"]])
      await assert.rejects(
        run([...publishArgs, ...flags], "synthetic-secret-never-print"),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === 1 &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          error.stderr.includes("Could not resolve the commit object") &&
          !error.stderr.includes("synthetic-secret-never-print"),
      );

    await assert.rejects(
      run([...publishArgs, "--dry-run", "--write"], "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("mutually exclusive"),
    );

    await assert.rejects(
      run(["publish-github", ...publicationArgs.slice(1)], "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("--asset-directory"),
    );

    await writeFile(join(assetDirectory, "tool.tgz"), "changed");

    await assert.rejects(
      run([...publishArgs, "--write"], "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("asset size differs"),
    );

    const targetPath = join(path, "review-target.json");
    const reviewPath = join(path, "stored-review.json");
    const attestationPath = join(path, "merge-attestation.json");
    const target = {
      schemaVersion: 1,
      pullNumber: 1,
      headSha: approval.headSha,
      approverUserId: 7,
    };

    await writeFile(targetPath, JSON.stringify(target));
    await writeFile(
      reviewPath,
      JSON.stringify({
        ...target,
        repositoryId: approval.repositoryId,
        sourceSha: approval.sourceSha,
        baseline: approval.baseline,
        snapshotId: approval.snapshotId,
        proposalId: approval.proposalId,
        configurationId: "a".repeat(64),
        policyId: "b".repeat(64),
      }),
    );
    await writeFile(
      attestationPath,
      JSON.stringify({
        ...target,
        repositoryId: approval.repositoryId,
        landingSha: approval.landingSha,
        mergeKind: approval.mergeKind,
      }),
    );

    for (const command of [
      ["capture-review", "--target", targetPath],
      ["finalize-approval", "--review", reviewPath, "--attestation", attestationPath],
    ]) {
      const commandArgs = [
        ...command,
        "--config",
        configPath,
        "--policy",
        policyPath,
        "--repository",
        consumer,
      ];

      await assert.rejects(
        run([...commandArgs, "--write"]),
        (error: unknown) => error instanceof Error && "code" in error && error.code === 2,
      );
      await assert.rejects(
        run(commandArgs),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === 2 &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          error.stderr.includes("GITHUB_TOKEN"),
      );
      await assert.rejects(
        run(commandArgs, "synthetic-secret-never-print"),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === 1 &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          error.stderr.includes("GitHub read failed") &&
          !error.stderr.includes("synthetic-secret-never-print"),
      );
    }

    const strictApprovalPolicy = {
      schemaVersion: 2,
      botUserId: 42,
      approverUserIds: [7],
      requiredChecks: [{ name: "verify", appId: 90, workflowId: 201, event: "pull_request" }],
    };

    await writeFile(policyPath, JSON.stringify(strictApprovalPolicy));

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

    await writeFile(policyPath, JSON.stringify({ ...strictApprovalPolicy, requiredChecks: [] }));

    await assert.rejects(
      run(approvalArgs, "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("1–20 explicitly trusted"),
    );

    await writeFile(
      policyPath,
      JSON.stringify({ schemaVersion: 1, botUserId: 42, approverUserIds: [7] }),
    );

    const exclusionConfigPath = join(path, "exclusion-config.json");
    const authoritiesPath = join(path, "trusted-authorities.json");
    const authorities = {
      schemaVersion: 1,
      approvals: [
        {
          configuration: fixtureConfiguration,
          policy: { schemaVersion: 1, botUserId: 42, approverUserIds: [7] },
          approval,
        },
      ],
    };

    await writeFile(
      exclusionConfigPath,
      JSON.stringify({
        ...fixtureConfiguration,
        automationExclusions: [{ pullNumber: 1, verificationId: "a".repeat(64) }],
      }),
    );
    await writeFile(authoritiesPath, JSON.stringify(authorities));

    const collectArgs = [
      "collect",
      "--repository",
      consumer,
      "--source",
      approval.landingSha,
      "--baseline-tag",
      "v1.2.3",
    ];

    for (const selection of [
      ["--config", exclusionConfigPath],
      ["--config", configPath, "--exclusions", authoritiesPath],
    ]) {
      await assert.rejects(
        run([...collectArgs, ...selection], "synthetic-secret-never-print"),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === 2 &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          error.stderr.includes("both trusted configuration pins") &&
          !error.stderr.includes("synthetic-secret-never-print"),
      );
    }

    await writeFile(
      authoritiesPath,
      JSON.stringify(authorities).replace('"approvals":', '"approvals":[],"approvals":'),
    );

    await assert.rejects(
      run(
        [...collectArgs, "--config", exclusionConfigPath, "--exclusions", authoritiesPath],
        "synthetic-secret-never-print",
      ),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("repeat property names"),
    );

    const auditArgs = [
      "audit-exclusion",
      "--config",
      configPath,
      "--approval",
      approvalPath,
      "--policy",
      policyPath,
      "--repository",
      consumer,
      "--source",
      approval.landingSha,
      "--bootstrap-sha",
      approval.baseline.commitSha,
    ];

    await assert.rejects(
      run([...auditArgs, "--write"]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 2,
    );
    await assert.rejects(
      run(auditArgs),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("GITHUB_TOKEN"),
    );
    await assert.rejects(
      run(auditArgs, "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("selected Git repository is unavailable") &&
        !error.stderr.includes("synthetic-secret-never-print"),
    );
    await assert.rejects(
      run([...auditArgs, "--baseline-tag", "v1.2.3"], "synthetic-secret-never-print"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("Select exactly one"),
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
        'import { reconcileReleaseTag } from "release-log/tags"; import { inspectReleasePublication, publishGitHubRelease, parsePublicationPolicy, parsePublicationReceipt } from "release-log/publication"; import { reconcileReleaseProposal } from "release-log/proposals"; import { verifyReleaseApproval, parseReleaseApproval, captureReleaseReview, finalizeReleaseApproval, parseReleaseReviewTarget, parseReleaseReview, parseReleaseMergeAttestation, auditReleaseExclusion, parseVerifiedReleaseApproval, parseReleaseExclusionAuthorities } from "release-log/approval"; if ([reconcileReleaseTag, inspectReleasePublication, publishGitHubRelease, parsePublicationPolicy, parsePublicationReceipt, reconcileReleaseProposal, verifyReleaseApproval, parseReleaseApproval, captureReleaseReview, finalizeReleaseApproval, parseReleaseReviewTarget, parseReleaseReview, parseReleaseMergeAttestation, auditReleaseExclusion, parseVerifiedReleaseApproval, parseReleaseExclusionAuthorities].some(value => typeof value !== "function")) throw new Error("Missing packaged proposal/approval API");',
      ],
      { cwd: consumer, timeout: 10_000 },
    );
    await writeFile(
      snapshotPath,
      snapshot.serialized.replace('"schemaVersion":3', '"schemaVersion":99'),
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
