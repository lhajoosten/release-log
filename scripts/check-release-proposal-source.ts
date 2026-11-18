import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" } } });
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
if (!values.base || !values.head || !sha.test(values.base) || !sha.test(values.head))
  throw new Error("Usage: pnpm check:release-proposal-source --base <full-sha> --head <full-sha>");

const source = execFileSync("git", ["rev-parse", "--verify", `${values.head}^1`], {
  encoding: "utf8",
  timeout: 10_000,
}).trim();
if (source !== values.base)
  throw new Error(
    "Release proposal is stale or has been merged with main; refresh it with the controller.",
  );
