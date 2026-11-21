import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { rehearseRelease } from "../scripts/release-rehearsal.ts";
import type { RehearsalOptions } from "../scripts/release-rehearsal.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";
import { captureReleaseSnapshot, serializeReleaseSnapshot } from "../src/release-snapshot.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

for (const scenario of ["released", "bootstrap", "no-release"] as const) {
  void test(
    `read-only ${scenario} rehearsal executes real offline CLI commands without changing the inspected repository`,
    { timeout: 30_000 },
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "rehearsal-test-"));
      context.after(() => rm(directory, { recursive: true, force: true }));
      const manifest = scenario === "bootstrap" ? '{"version":"0.0.0"}\n' : '{"version":"1.2.3"}\n';
      await writeFile(join(directory, "package.json"), manifest);
      const fixture = await releaseFixture(
        [
          {
            title: scenario === "no-release" ? "docs(api): explain keys" : "fix(api): retain keys",
          },
        ],
        scenario === "bootstrap" ? null : "1.2.3",
      );
      const output = join(directory, "preview");
      const calls: { args: readonly string[]; phase: string }[] = [];
      await rehearseRelease(
        {
          configuration: fixtureConfiguration,
          sourceSha: fixture.snapshot.normalized.sourceCommitSha,
          baseline:
            scenario === "bootstrap"
              ? { kind: "bootstrap", commitSha: fixture.snapshot.normalized.baselineCommitSha }
              : { kind: "released", tag: "v1.2.3", currentVersion: "1.2.3" },
          repositoryDirectory: directory,
          outputDirectory: output,
        },
        async (args, phase) => {
          calls.push({ args, phase });
          if (phase === "collect") return fixture.serialized;
          return (
            await execute(process.execPath, [cli, ...args], {
              timeout: 10_000,
              env: { PATH: process.env.PATH },
              maxBuffer: 16 * 1024 * 1024,
            })
          ).stdout;
        },
      );
      assert.equal(await readFile(join(directory, "package.json"), "utf8"), manifest);
      assert.deepEqual((await readdir(directory)).toSorted(), ["package.json", "preview"]);
      assert.equal(calls.filter(({ phase }) => phase === "collect").length, 1);
      assert.equal(calls.filter(({ args }) => args[0] === "plan").length, 2);
      assert.equal(calls.filter(({ args }) => args[0] === "render").length, 2);
      assert.ok(calls.find(({ args }) => args[0] === "prepare")?.args.includes("--dry-run"));
      assert.ok(calls.every(({ args }) => !args.includes("--write")));
      assert.deepEqual((await readdir(output)).toSorted(), [
        "changelog.md",
        "evidence.json",
        "plan.json",
      ]);
      const evidence: unknown = JSON.parse(await readFile(join(output, "evidence.json"), "utf8"));
      assert.ok(
        typeof evidence === "object" &&
          evidence !== null &&
          "replayStable" in evidence &&
          evidence.replayStable === true,
      );
      const combined = (
        await Promise.all(
          (await readdir(output)).map((name) => readFile(join(output, name), "utf8")),
        )
      ).join("\n");
      assert.ok(!combined.includes("```release-log"));
      assert.ok(!combined.includes("originalCommits"));
      assert.ok(!combined.includes("before"));
      const config = calls[0]?.args[2];
      assert.ok(config);
      await assert.rejects(readFile(config), { code: "ENOENT" });
      if (scenario === "no-release")
        assert.match(
          await readFile(join(output, "changelog.md"), "utf8"),
          /No releasable changes/u,
        );
    },
  );
}

void test(
  "initial-adoption rehearsal emits a stable 0.1.0 preview for maintenance-only legacy history without writes",
  { timeout: 30_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "adoption-rehearsal-"));
    context.after(() => rm(directory, { recursive: true, force: true }));

    const manifest = '[project]\nversion="0.0.0"\n';

    await writeFile(join(directory, "pyproject.toml"), manifest);

    const fixture = await releaseFixture([], null, ["chore: initialize tooling"]);
    const configuration = {
      ...fixtureConfiguration,
      schemaVersion: 2 as const,
      bootstrap: {
        baselineSha: fixture.snapshot.input.range.baseline.commitSha,
        onboardingSha: fixture.snapshot.input.range.sourceCommitSha,
      },
    };
    const snapshot = await captureReleaseSnapshot(fixture.snapshot.input, configuration);
    const serialized = await serializeReleaseSnapshot(snapshot);
    const output = join(directory, "preview");

    await rehearseRelease(
      {
        configuration,
        sourceSha: snapshot.input.range.sourceCommitSha,
        baseline: { kind: "bootstrap", commitSha: configuration.bootstrap.baselineSha },
        repositoryDirectory: directory,
        outputDirectory: output,
      },
      async (args, phase) => {
        if (phase === "collect") return serialized;

        return (
          await execute(process.execPath, [cli, ...args], {
            timeout: 10_000,
            env: { PATH: process.env.PATH },
            maxBuffer: 16 * 1024 * 1024,
          })
        ).stdout;
      },
    );

    const plan: unknown = JSON.parse(await readFile(join(output, "plan.json"), "utf8"));
    const evidence: unknown = JSON.parse(await readFile(join(output, "evidence.json"), "utf8"));

    assert.equal(record(plan).nextVersion, "0.1.0");
    assert.equal(record(evidence).onboardingSha, configuration.bootstrap.onboardingSha);
    assert.equal(record(evidence).replayStable, true);
    assert.match(await readFile(join(output, "changelog.md"), "utf8"), /Historical changes/u);
    assert.equal(await readFile(join(directory, "pyproject.toml"), "utf8"), manifest);
    assert.deepEqual((await readdir(directory)).toSorted(), ["preview", "pyproject.toml"]);
  },
);

void test("invalid baselines, changed replay results, and CLI failures fail without producing success evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rehearsal-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const options: RehearsalOptions = {
    configuration: fixtureConfiguration,
    sourceSha: "a".repeat(40),
    baseline: { kind: "released", tag: "v1.2.3", currentVersion: "1.2.3" },
    repositoryDirectory: directory,
    outputDirectory: join(directory, "preview"),
  };
  await assert.rejects(
    rehearseRelease({ ...options, sourceSha: "main" }, () => Promise.resolve("")),
    /full source SHA/u,
  );
  await assert.rejects(
    rehearseRelease(
      { ...options, baseline: { kind: "released", tag: "v1.2.4", currentVersion: "1.2.3" } },
      () => Promise.resolve(""),
    ),
    /matching the current version/u,
  );
  await assert.rejects(
    rehearseRelease(options, () => Promise.reject(new Error("controlled CLI failure"))),
    /controlled CLI failure/u,
  );
  const plan = { sourceCommitSha: options.sourceSha, snapshotId: "0".repeat(64), release: false };
  let plans = 0;
  await assert.rejects(
    rehearseRelease(options, (args) => {
      if (args[0] === "collect") return Promise.resolve("captured synthetic snapshot");
      if (args[0] === "plan")
        return Promise.resolve(
          JSON.stringify({ ...plan, ...(++plans > 1 ? { changed: true } : {}) }),
        );
      if (args[0] === "prepare")
        return Promise.resolve(JSON.stringify({ mode: "dry-run", plan, files: [] }));
      return Promise.resolve("");
    }),
    /Offline replay changed/u,
  );
  assert.deepEqual(await readdir(directory), []);
});

void test("manual entry point surfaces safe CLI failures without leaking tokens or raw subprocess output", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rehearsal-entry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, "docker");
  await writeFile(
    fake,
    `#!/bin/sh
case " $* " in
  *" -e GITHUB_TOKEN sha256:${"a".repeat(64)} collect --config /inputs/configuration.json "*) ;;
  *) exit 99 ;;
esac
test "$GITHUB_TOKEN" = synthetic-rehearsal-secret || exit 99
echo "private subprocess output" >&2
echo "release-log: synthetic-rehearsal-secret" >&2
echo "release-log: PR #9 release metadata must be repaired." >&2
exit 1
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(directory, "release-log.config.json"),
    JSON.stringify({
      ...fixtureConfiguration,
      schemaVersion: 2,
      bootstrap: { baselineSha: "0".repeat(40), onboardingSha: "a".repeat(40) },
    }),
  );

  const environment = {
    PATH: `${directory}:${process.env.PATH}`,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "example/project",
    GITHUB_REPOSITORY_ID: "17",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKSPACE: directory,
    GITHUB_TOKEN: "synthetic-rehearsal-secret",
    RELEASE_LOG_IMAGE_ID: `sha256:${"a".repeat(64)}`,
    REHEARSAL_OUTPUT: join(directory, "preview"),
    REHEARSAL_MODE: "bootstrap",
    REHEARSAL_BASELINE: "0".repeat(40),
  };
  const script = fileURLToPath(new URL("../scripts/release-rehearsal.ts", import.meta.url));
  await assert.rejects(
    execute(process.execPath, [script], { env: environment, timeout: 10_000 }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
      assert.match(error.stderr, /PR #9 release metadata must be repaired/u);
      assert.ok(!error.stderr.includes("synthetic-rehearsal-secret"));
      assert.ok(!error.stderr.includes("private subprocess output"));
      return true;
    },
  );
  await assert.rejects(
    execute(process.execPath, [script], {
      env: { ...environment, GITHUB_REF: "refs/heads/untrusted" },
      timeout: 10_000,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("trusted main only"),
  );
  await assert.rejects(
    execute(process.execPath, [script], {
      env: { ...environment, REHEARSAL_BASELINE: "b".repeat(40) },
      timeout: 10_000,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("fixed onboarding record"),
  );

  await writeFile(
    join(directory, "release-log.config.json"),
    '{"token":"synthetic-rehearsal-secret"',
  );

  await assert.rejects(
    execute(process.execPath, [script], { env: environment, timeout: 10_000 }),
    (error: unknown) =>
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("must be valid JSON") &&
      !error.stderr.includes("synthetic-rehearsal-secret"),
  );

  assert.deepEqual((await readdir(directory)).toSorted(), ["docker", "release-log.config.json"]);
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

void test("rehearsal workflow is manual, read-only, trusted-main-only, and pins every external Action", async () => {
  const workflow: unknown = parse(
    await readFile(new URL("../.github/workflows/release-rehearsal.yml", import.meta.url), "utf8"),
  );
  const root = record(workflow);
  assert.deepEqual(Object.keys(record(root.on)), ["workflow_dispatch"]);
  assert.deepEqual(root.permissions, { contents: "read", "pull-requests": "read" });
  const job = record(record(root.jobs).rehearse);
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.ok(Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  for (const step of steps.map(record))
    if ("uses" in step) assert.match(String(step.uses), /^[a-zA-Z0-9_./-]+@[a-f0-9]{40}$/u);
  const checkout = steps
    .map(record)
    .find((step) => String(step.uses).startsWith("actions/checkout@"));
  assert.ok(checkout);
  assert.equal(record(checkout.with).ref, "${{ github.sha }}");
  assert.equal(record(checkout.with)["persist-credentials"], false);
  assert.deepEqual(job.env, { RELEASE_LOG_IMAGE: "ghcr.io/lhajoosten/release-log:latest" });
  const pull = steps
    .map(record)
    .find((step) => typeof step.run === "string" && step.run.includes("docker pull"));
  assert.ok(pull && typeof pull.run === "string");
  assert.ok(pull.run.includes('docker pull --platform linux/amd64 "$RELEASE_LOG_IMAGE"'));
  assert.ok(pull.run.includes("RELEASE_LOG_IMAGE_ID="));
  assert.ok(
    steps.map(record).every((step) => typeof step.run !== "string" || !step.run.includes("pnpm")),
  );
  const upload = steps
    .map(record)
    .find((step) => String(step.uses).startsWith("actions/upload-artifact@"));
  assert.ok(upload);
  assert.equal(record(upload.with)["retention-days"], 7);
  assert.equal(record(upload.with).path, "${{ runner.temp }}/release-preview/");
});

void test("preflight CLI checks a disposable consumer without writing and distinguishes local App evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "consumer-preflight-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (
      await execute(
        "git",
        [
          "-c",
          "user.name=Preflight Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: directory, timeout: 10_000 },
      )
    ).stdout.trim();
  await git("init", "--initial-branch=main");
  const args = [
    cli,
    "preflight",
    "--repository",
    directory,
    "--target",
    "example/project",
    "--repository-id",
    "17",
    "--release-branch",
    "main",
    "--initial-version",
    "0.1.0",
    "--producer-sha",
    (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
  ];
  const env = { PATH: process.env.PATH };
  await assert.rejects(execute(process.execPath, args, { env }), (error: unknown) => {
    assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
    assert.match(error.stderr, /first commit with a root package.json/u);
    return true;
  });

  const manifest = '{"version":"0.0.0","scripts":{"prepare":"exit 89"}}\n';
  await writeFile(join(directory, "package.json"), manifest);
  await git("add", "package.json");
  await git("commit", "-m", "Plan the initial application");
  const source = await git("rev-parse", "HEAD");

  await assert.rejects(execute(process.execPath, args, { env }), (error: unknown) => {
    assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
    const output = record(JSON.parse(error.stdout) as unknown);
    assert.equal(output.status, "unverified");
    assert.equal(record(record(output.findings).sourceFiles).status, "passed");
    assert.equal(record(record(output.findings).history).status, "unverified");
    assert.equal(output.caller, null);
    return true;
  });

  const mock = join(directory, "mock-github.mjs");
  await writeFile(
    mock,
    [
      'import assert from "node:assert/strict";',
      "globalThis.fetch = (url, init) => {",
      '  assert.equal(init.method, "GET");',
      "  const target = new URL(url);",
      '  assert.equal(target.origin, "https://api.github.com");',
      "  switch (target.pathname) {",
      '    case "/repos/example/project": return Response.json({ id: 17, full_name: "example/project" });',
      '    case "/repos/example/project/tags":',
      '    case "/repos/example/project/pulls": return Response.json([]);',
      '    case "/repos/example/project/git/ref/heads/main":',
      '      return Response.json({ ref: "refs/heads/main", object: { sha: ' +
        JSON.stringify(source) +
        " } });",
      '    case "/repos/example/project/git/ref/heads/release-log%2Fmain":',
      "      return Response.json({}, { status: 404 });",
      '    default: throw new Error("Unexpected repository read");',
      "  }",
      "};",
    ].join("\n"),
  );
  const result = await execute(process.execPath, ["--import", mock, ...args], {
    env: { ...env, GITHUB_TOKEN: "synthetic-read-token" },
    timeout: 20_000,
  });
  const report = record(JSON.parse(result.stdout) as unknown);
  assert.equal(report.status, "unverified");
  assert.equal(report.sourceSha, source);
  assert.equal(record(record(report.findings).history).status, "passed");
  assert.equal(record(record(report.findings).appDryRun).status, "unverified");
  assert.doesNotMatch(result.stdout, /synthetic-read-token|originalCommits|exit 89/u);
  assert.equal(await readFile(join(directory, "package.json"), "utf8"), manifest);
  assert.deepEqual((await readdir(directory)).toSorted(), [
    ".git",
    "mock-github.mjs",
    "package.json",
  ]);
});

void test("manual initialization uses the immutable dispatch source, scoped App probes and the CLI without write inputs", async () => {
  const workflow = record(
    parse(
      await readFile(new URL("../.github/workflows/rolling-release.yml", import.meta.url), "utf8"),
    ) as unknown,
  );
  const job = record(record(workflow.jobs).roll);
  assert.match(String(job.if), /workflow_dispatch[\s\S]*github\.ref == format/u);
  const steps: unknown = job.steps;
  assert.ok(Array.isArray(steps));
  const config = steps.map(record).find((step) => step.id === "configuration");
  const probe = steps.map(record).find((step) => step.id === "installation");
  const mint = steps.map(record).find((step) => step.id === "app");
  const preflight = steps
    .map(record)
    .find((step) => typeof step.run === "string" && step.run.includes('cli.js" preflight '));
  assert.ok(config && probe && mint && preflight);
  assert.equal(record(probe.with)["permission-metadata"], "read");
  assert.equal(record(mint.with)["permission-contents"], "write");
  assert.equal(record(mint.with)["permission-pull-requests"], "write");
  assert.match(String(mint.if), /steps\.installation\.outcome == 'success'/u);
  assert.match(String(preflight.run), /--source "\$GITHUB_SHA"/u);
  assert.doesNotMatch(String(preflight.run), /--write|inputs\.write/u);
  for (const step of steps.map(record))
    if ("uses" in step) assert.match(String(step.uses), /@[a-f0-9]{40}$/u);
});
