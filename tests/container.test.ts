import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const builder = fileURLToPath(new URL("../scripts/build-container.ts", import.meta.url));

void test("container builder requires an explicit local tag and rejects publication/extra arguments before building", async () => {
  for (const args of [
    [],
    ["--tag", "--push"],
    ["--tag", "release-log:local", "--push"],
    ["--tag", "release-log@sha256:invalid"],
  ]) {
    await assert.rejects(
      execute(process.execPath, [builder, ...args], { timeout: 10_000 }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("Usage: pnpm container:build"),
    );
  }
});
