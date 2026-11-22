import { appendFile, readFile } from "node:fs/promises";
import { readConsumerSettings } from "../src/config/consumer.ts";
import { inspectBranchSource } from "../src/git.ts";
import { parseProducerPins } from "../src/config/producer-pins.ts";

const { GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, RELEASE_BRANCH, TOOL_SHA, GITHUB_OUTPUT } =
  process.env;
if (!GITHUB_REPOSITORY || !RELEASE_BRANCH || !TOOL_SHA || !GITHUB_OUTPUT)
  throw new Error(
    "The caller identity, release branch and resolved workflow revision are required.",
  );

const source = process.env.CONSUMER_SOURCE ?? "../source";
const sourceSha = await inspectBranchSource(source, "HEAD");
const settings = await readConsumerSettings(
  source,
  sourceSha,
  {
    repository: GITHUB_REPOSITORY,
    repositoryId: Number(GITHUB_REPOSITORY_ID),
    releaseBranch: RELEASE_BRANCH,
  },
  process.env.INLINE_CONFIGURATION,
);

const catalog = parseProducerPins(
  JSON.parse(await readFile(".github/consumer-producers.json", "utf8")),
);
const requested = parseProducerPins(JSON.parse(process.env.INLINE_REPLAY_HISTORY || "[]"), true);
for (const pin of requested) {
  if (!catalog.some((reviewed) => reviewed.sha === pin.sha && reviewed.legacy === pin.legacy))
    throw new Error(
      `Producer ${pin.sha} is not approved by Rolling Release. Request a provider catalog entry before migration.`,
    );
}
const runtimes = catalog.filter(({ sha }) => sha !== TOOL_SHA);
console.log(
  `Rolling Release revision ${TOOL_SHA} | config source ${sourceSha} | policy ${settings.configuration.releasePolicy} | context ${settings.configuration.contextPolicy ?? "required"}`,
);
await appendFile(
  GITHUB_OUTPUT,
  `configuration=${JSON.stringify(settings.configuration)}\nhistorical=${JSON.stringify(settings.historical)}\nruntimes=${JSON.stringify(runtimes)}\nsource=${sourceSha}\n`,
);
