import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const args = process.argv.slice(2);
const selection = args.length
  ? args
  : globSync("tests/*.test.ts", { exclude: ["tests/*.integration.test.ts"] }).toSorted();
if (selection.length === 0) throw new Error("No fast tests found in tests/.");

const child = spawn(process.execPath, ["--test", ...selection], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
