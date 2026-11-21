import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { object } from "./proposal-fixture.ts";

const execute = promisify(execFile);
const active = "a".repeat(40);
const previous = "b".repeat(40);
const older = "c".repeat(40);
const legacy = "d".repeat(40);
const caller = (sha: string) =>
  `jobs:\n  release:\n    uses: lhajoosten/release-log/.github/workflows/rolling-release.yml@${sha}\n    with:\n      tool-sha: ${sha}\n`;
const configuration = {
  schemaVersion: 1,
  repository: "lhajoosten/release-log",
  repositoryId: 1449550207,
  releaseBranch: "main",
  releasePolicy: "release-policy-v1",
  selfUpgrade: true,
};

void test("installer retains reviewed predecessor pins before credentials without consulting consumer evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "producer-install-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, ".github/workflows/rolling-release-caller.yml"), caller(previous));
  const trace = join(root, "commands.jsonl");
  const script = `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const command=basename(process.argv[1]); const args=process.argv.slice(2);
appendFileSync(process.env.TEST_TRACE, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
if(command==='git' && args[0]==='checkout') {
 const sha=args[2]; writeFileSync('.test-sha',sha);
 const callers=${JSON.stringify({ [previous]: caller(older), [older]: caller(legacy) })};
 if(callers[sha]) { mkdirSync('.github/workflows',{recursive:true}); writeFileSync('.github/workflows/rolling-release-caller.yml',callers[sha]); }
}
if(command==='git' && args[0]==='rev-parse') process.stdout.write(readFileSync('.test-sha','utf8')+'\\n');
`;
  for (const name of ["git", "pnpm"]) await writeFile(join(bin, name), script, { mode: 0o755 });
  const run = (pins: unknown, config: unknown = configuration) =>
    execute(
      process.execPath,
      [new URL("../scripts/install-producer-runtimes.ts", import.meta.url).pathname],
      {
        cwd: root,
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: bin + delimiter + (process.env.PATH ?? ""),
          TOOL_SHA: active,
          RUNNER_TEMP: root,
          CONFIGURATION: JSON.stringify(config),
          VERIFICATION_RUNTIMES: JSON.stringify(pins),
          TEST_TRACE: trace,
          SNAPSHOT_PRODUCER_SHA: "e".repeat(40),
        },
      },
    );
  await run([{ sha: legacy, legacy: true }]);
  const registry = object(
    JSON.parse(await readFile(join(root, "release-producer-runtimes.json"), "utf8")) as unknown,
  );
  assert.equal(registry.activeSha, active);
  assert.deepEqual(
    registry.producers,
    [legacy, previous, older].map((sha) => ({
      sha,
      legacy: sha === legacy,
      directory: join(root, "release-producers", sha),
    })),
  );
  const commands = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line) as unknown));
  assert.deepEqual(
    commands
      .filter((c) => c.command === "git" && Array.isArray(c.args) && c.args[0] === "fetch")
      .map((c) => c.args),
    [legacy, previous, older].map((sha) => [
      "fetch",
      "--depth=1",
      "https://github.com/lhajoosten/rolling-release.git",
      sha,
    ]),
  );
  assert.equal(commands.filter((c) => c.command === "pnpm").length, 6);
  assert.ok(
    commands
      .filter((c) => c.command === "pnpm")
      .every(
        (c) =>
          JSON.stringify(c.args) === '["install","--frozen-lockfile","--ignore-scripts"]' ||
          JSON.stringify(c.args) === '["build"]',
      ),
  );
  const before = await readFile(trace, "utf8");
  for (const pins of [
    [{ sha: "main", legacy: true }],
    [
      { sha: legacy, legacy: true },
      { sha: legacy, legacy: false },
    ],
  ])
    await assert.rejects(run(pins));
  assert.equal(await readFile(trace, "utf8"), before);
  await run([], {
    schemaVersion: 1,
    repository: "example/project",
    repositoryId: 17,
    releaseBranch: "main",
    releasePolicy: "release-policy-v1",
  });
  assert.equal(await readFile(trace, "utf8"), before);
  const generic = object(
    JSON.parse(await readFile(join(root, "release-producer-runtimes.json"), "utf8")) as unknown,
  );
  assert.deepEqual(generic.producers, []);
});
