import { execFileSync, spawnSync } from "node:child_process";

// Linked-worktree hooks export absolute Git paths; fixture Git commands must not inherit them.
const environment = { ...process.env };
const localVariables = execFileSync("git", ["--no-pager", "rev-parse", "--local-env-vars"], {
  encoding: "utf8",
  timeout: 10_000,
});
for (const name of localVariables.trim().split("\n")) delete environment[name];
for (const name of Object.keys(environment)) {
  if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name)) delete environment[name];
}

const result = spawnSync("pnpm", ["check"], {
  env: environment,
  stdio: "inherit",
  timeout: 600_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
