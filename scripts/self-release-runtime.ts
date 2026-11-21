import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { readToolPin, workflowPath } from "../src/tool-upgrade.ts";

const cutoff = execFileSync(
  "git",
  ["log", "--first-parent", "--diff-filter=A", "--format=%H", "--", "scripts/self-release.ts"],
  { encoding: "utf8" },
).trim();
const pinned = readToolPin(await readFile(workflowPath, "utf8"));
if (!/^[a-f0-9]{40}$/u.test(cutoff) || !process.env.GITHUB_OUTPUT)
  throw new Error("Expected one reviewed introduction of the self-release controller.");
const main = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function ancestor(base: string, next: string) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, next]);
    return true;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) return false;
    throw error;
  }
}
if (!ancestor(pinned, main))
  throw new Error("The pinned release producer is outside reviewed main history.");
await appendFile(
  process.env.GITHUB_OUTPUT,
  `tool-sha=${ancestor(cutoff, pinned) ? pinned : cutoff}\n`,
);
