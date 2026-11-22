import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseReleaseAutomation } from "../src/config/automation.ts";
import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import { selectReleaseCycle } from "../src/cycle/select.ts";
import { ReleaseCycleError } from "../src/cycle/types.ts";
import { inspectBranchSource } from "../src/git.ts";
import { retryGitHubReads } from "../src/github-retry.ts";
import { loadProducerRuntimes, withProducerRuntimes } from "../src/producer-runtime.ts";
import { preflightRelease } from "../src/release-preflight.ts";
import { proposeReleaseForCycle } from "../src/release-roll.ts";

const {
  GITHUB_TOKEN: token,
  GITHUB_SHA: sourceSha,
  TOOL_SHA: producerSha,
  RUNNER_TEMP,
} = process.env;
if (!sourceSha || !token || !producerSha || !RUNNER_TEMP)
  throw new Error(
    "The captured source, reviewed producer revision and GitHub read token are required.",
  );

const repository = "../source";
if ((await inspectBranchSource(repository, "HEAD")) !== sourceSha)
  throw new Error("The preview checkout must match the dispatch commit.");

async function input(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(RUNNER_TEMP ?? "", path), "utf8")) as unknown;
}
const configuration = parseReleaseInputConfiguration(await input("release-config.json"));
const automation = parseReleaseAutomation(await input("release-automation.json"));
const runtimes = await loadProducerRuntimes(await input("release-producer-runtimes.json"));
await withProducerRuntimes(runtimes, async () => {
  const request = { configuration, automation, sourceSha, token };
  const transport = retryGitHubReads();
  const cycle = await selectReleaseCycle(request, transport).catch((error: unknown) => {
    if (error instanceof ReleaseCycleError && error.code === "baseline-unavailable") return null;
    throw error;
  });
  if (cycle === null) {
    const report = await preflightRelease(
      {
        ...request,
        repository,
        producerSha,
        consumerSetup: true,
        initialVersion: "0.1.0",
      },
      transport,
    );
    console.log(
      JSON.stringify(
        {
          setup: "Record the reviewed range in .release-log/settings.json before enabling writes.",
          ...report,
        },
        null,
        2,
      ),
    );
    if (report.status === "blocked") process.exitCode = 1;
    return;
  }
  if (cycle.outcome !== "selected")
    throw new Error(
      `Complete release history recovery before previewing: ${JSON.stringify(cycle)}`,
    );
  const result = await proposeReleaseForCycle(
    { ...request, repository, cycle, landingSha: sourceSha, write: false },
    transport,
  );
  console.log(JSON.stringify(result, null, 2));
});
