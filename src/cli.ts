#!/usr/bin/env node
import { findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBackfill } from "./controller/backfill.ts";
import { propose, finalize, checkProposal } from "./controller/cycle.ts";
import { Remote, repoName, object } from "./controller/remote.ts";

export async function run(command: string | undefined) {
  if (command === "--version") {
    const path = findPackageJSON(".", import.meta.url);
    if (!path) throw new Error("Package metadata missing");
    const version = object(JSON.parse(await readFile(path, "utf8"))).version;
    if (typeof version !== "string") throw new Error("Package version missing");
    console.log(version);
    return;
  }
  if (command === "--help" || !command) {
    console.log("release-log preview | propose | promote | publish | backfill");
    return;
  }
  const repository = repoName(process.env.GITHUB_REPOSITORY);
  const root = resolve(process.env.ROLLING_RELEASE_ROOT || process.cwd());
  if (command === "backfill") {
    await runBackfill(root, repository);
    return;
  }
  const remote = new Remote(
    repository,
    process.env.GITHUB_TOKEN ?? "",
    process.env.ROLLING_RELEASE_BOT ?? "",
  );
  if (command === "preview" || command === "propose")
    await propose(root, remote, command === "preview");
  else if (command === "refresh") await propose(root, remote, false, true);
  else if (command === "check-proposal") await checkProposal(root, remote);
  else if (command === "promote" || command === "publish") await finalize(root, remote, command);
  else throw new Error("Unknown release-log command: " + command);
}
if (import.meta.main)
  run(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Release workflow failed");
    process.exitCode = 1;
  });
