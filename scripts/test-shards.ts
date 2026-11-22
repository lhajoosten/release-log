import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const files = globSync("tests/*.test.ts").toSorted();

function positiveInteger(value: string | undefined, name: string): number {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, `${name} must be a positive integer`);
  return number;
}

function readTimings(path: string, requireCounts = true) {
  const timings = new Map<string, number>();
  const tests = new Map<string, number>();
  for (const row of readFileSync(path, "utf8").trim().split("\n")) {
    const [kind, file, value] = row.split("\t");
    assert.ok((kind === "tests" || kind === "time") && file);
    const records = kind === "time" ? timings : tests;
    assert.ok(!records.has(file), `Duplicate ${kind} record for ${file}`);
    records.set(file, positiveInteger(value, kind));
  }
  if (requireCounts) assert.deepEqual([...timings.keys()].toSorted(), [...tests.keys()].toSorted());
  return { timings, tests };
}

function plan(count: number, history?: string) {
  assert.ok(count <= files.length, "Every shard must have at least one file");
  const timings = history ? readTimings(history, false).timings : new Map<string, number>();
  const weighted = files.map((file) => ({
    file,
    milliseconds: timings.get(file) ?? Math.max(1, Math.ceil(statSync(file).size * 0.05)),
  }));
  const shards = Array.from({ length: count }, () => ({
    files: [] as string[],
    milliseconds: 0,
  }));
  for (const { file, milliseconds } of weighted.toSorted(
    (a, b) => b.milliseconds - a.milliseconds,
  )) {
    let lightest = 0;
    for (const [index, shard] of shards.entries()) {
      if (shard.milliseconds < (shards[lightest]?.milliseconds ?? Infinity)) lightest = index;
    }
    const shard = shards[lightest];
    assert.ok(shard);
    shard.files.push(file);
    shard.milliseconds += milliseconds;
  }
  assert.deepEqual(shards.flatMap((shard) => shard.files).toSorted(), files);
  return shards;
}

function runCoverage(args: readonly string[]) {
  const child = spawnSync(process.execPath, ["--test", "--experimental-test-coverage", ...args], {
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `Test runner failed (${child.signal ?? child.status})`);
}

function record(selected: string[], output: string) {
  const directory = mkdtempSync(join(tmpdir(), "release-log-test-shard-"));
  try {
    const report = join(directory, "results.tsv");
    runCoverage([
      "--test-reporter=spec",
      `--test-reporter=${resolve("scripts/test-file-reporter.ts")}`,
      "--test-reporter-destination=stdout",
      `--test-reporter-destination=${report}`,
      ...selected,
    ]);

    const { timings, tests } = readTimings(report);
    assert.deepEqual(
      [...timings.keys()].toSorted(),
      [...selected].toSorted(),
      "Completed files differ from the plan",
    );
    writeFileSync(output, readFileSync(report));
    console.log(`Verified ${selected.length} files and ${sum(tests.values())} tests`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sum(values: Iterable<number>) {
  return [...values].reduce((total, value) => total + value, 0);
}

const [command, ...args] = process.argv.slice(2);
if (command === "coverage") {
  assert.ok(files.length, "No test files found in tests/");
  runCoverage([...args, ...files]);
} else if (command === "plan") {
  const [count, history] = args;
  console.log(JSON.stringify(plan(positiveInteger(count, "Shard count"), history), null, 2));
} else if (command === "run") {
  const [index, count, history, output] = args;
  assert.ok(history && output, "Specify file timings and a timing output file");
  const shard = plan(positiveInteger(count, "Shard count"), history)[
    positiveInteger(index, "Shard index") - 1
  ];
  assert.ok(shard, "Shard index is outside the plan");
  record(shard.files, output);
} else if (command === "verify") {
  const [history, ...shardPaths] = args;
  assert.ok(history && shardPaths.length, "Specify file timings and each shard report");
  const shards = plan(shardPaths.length, history);
  let testCount = 0;
  for (const [index, path] of shardPaths.entries()) {
    const expected = shards[index];
    assert.ok(expected);
    const { tests } = readTimings(path);
    assert.deepEqual(
      [...tests.keys()].toSorted(),
      expected.files.toSorted(),
      `Completed files differ from the plan for shard ${index + 1}`,
    );
    testCount += sum(tests.values());
  }
  console.log(
    `Verified ${files.length} files and ${testCount} tests across ${shards.length} shards`,
  );
} else {
  throw new Error("Expected coverage, plan, run, or verify");
}
