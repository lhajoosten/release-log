import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
  },
});

if (!values.from || !values.to) {
  throw new Error("Usage: pnpm check:commit-range --from <base> --to <head>");
}

function git(args: readonly string[]): string {
  return execFileSync("git", ["--no-pager", "--no-optional-locks", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
  throw new Error("Commit-range checks require full history; fetch with fetch-depth: 0.");
}

git(["merge-base", "--", values.from, values.to]);

// Commitlint's pinned Git client silently drops --git-log-args=--no-merges.
// Filter by parent count in Git, then use the same strict policy as the hook.
const commits = git([
  "rev-list",
  "--no-merges",
  "--end-of-options",
  `${values.from}..${values.to}`,
  "--",
]);
const cli = fileURLToPath(import.meta.resolve("@commitlint/cli/cli.js"));
const config = fileURLToPath(new URL("../commitlint.config.mjs", import.meta.url));

for (const sha of commits.split("\n").filter(Boolean)) {
  const message = git(["show", "--no-patch", "--format=%B", sha, "--"]);
  console.log(`Validating commit ${sha}`);

  const result = spawnSync(process.execPath, [cli, "--config", config], {
    input: message,
    stdio: ["pipe", "inherit", "inherit"],
    timeout: 10_000,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode = 1;
  }
}
