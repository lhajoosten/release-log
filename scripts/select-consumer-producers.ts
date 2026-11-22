import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { selectConsumerProducers } from "../src/consumer-producers.ts";
import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import { parseReleaseAutomation } from "../src/config/automation.ts";
import { parseProducerPins } from "../src/config/producer-pins.ts";
import { isObject } from "../src/evidence/schema.ts";
import { retryGitHubReads } from "../src/github-retry.ts";

const { GITHUB_OUTPUT, GITHUB_TOKEN, RUNNER_TEMP, TOOL_SHA, CATALOG } = process.env;
if (!GITHUB_OUTPUT || !GITHUB_TOKEN || !RUNNER_TEMP || !TOOL_SHA || !CATALOG)
  throw new Error(
    "Consumer replay discovery requires a reviewed catalog and a repository read token.",
  );
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const configuration = parseReleaseInputConfiguration(
  await json(join(RUNNER_TEMP, "release-config.json")),
);
const automation = parseReleaseAutomation(await json(join(RUNNER_TEMP, "release-automation.json")));
const event = process.env.GITHUB_EVENT_PATH ? await json(process.env.GITHUB_EVENT_PATH) : null;
const pullNumber =
  process.env.GITHUB_EVENT_NAME === "pull_request_target" &&
  isObject(event) &&
  typeof event.number === "number"
    ? event.number
    : undefined;
const runtimes = await selectConsumerProducers(
  configuration,
  automation.botUserId,
  GITHUB_TOKEN,
  TOOL_SHA,
  parseProducerPins(JSON.parse(CATALOG)),
  pullNumber,
  retryGitHubReads(),
);
console.log(
  `Reviewed replay producers: ${runtimes.map(({ sha }) => sha).join(", ") || "(active revision only)"}`,
);
await appendFile(GITHUB_OUTPUT, `runtimes=${JSON.stringify(runtimes)}\n`);
