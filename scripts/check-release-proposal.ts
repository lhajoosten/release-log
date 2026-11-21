import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import { GitHubProposalRepository, ProposalConflictError } from "../src/github-proposals.ts";
import { pullRequestFromEvent } from "../src/github-pr-readiness.ts";
import { loadProducerRuntimes, withProducerRuntimes } from "../src/producer-runtime.ts";
import { verifyPrevious } from "../src/proposal/verification.ts";
import { updateToolPins, workflowPath } from "../src/tool-upgrade.ts";

const execute = promisify(execFile);
const { GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_TOKEN, RUNNER_TEMP } =
  process.env;
if (
  GITHUB_EVENT_NAME !== "pull_request_target" ||
  GITHUB_REPOSITORY !== "lhajoosten/release-log" ||
  !GITHUB_EVENT_PATH ||
  !GITHUB_TOKEN ||
  !RUNNER_TEMP ||
  (await stat(GITHUB_EVENT_PATH)).size > 4 * 1024 * 1024
)
  throw new Error("Expected a bounded release PR event in the trusted read-only workflow.");

const event: unknown = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8"));
const expected = pullRequestFromEvent(event, GITHUB_REPOSITORY);
const baseSha = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
const caller = await readFile(workflowPath, "utf8");
const document = parseDocument(caller, { uniqueKeys: true });
const configurationJSON: unknown = document.getIn(["env", "CONFIGURATION"]);
const pins: unknown = document.getIn(["env", "VERIFICATION_RUNTIMES"]);
if (document.errors.length || typeof configurationJSON !== "string" || typeof pins !== "string")
  throw new Error("Expected reviewed self-release configuration and verification runtime pins.");
const configuration = parseReleaseInputConfiguration(JSON.parse(configurationJSON));
if (
  configuration.repository !== GITHUB_REPOSITORY ||
  configuration.releaseBranch !== "main" ||
  !configuration.selfUpgrade ||
  !configuration.internalPublication
)
  throw new Error("Expected the reviewed self-upgrading Release Log caller.");

const api = new GitHubProposalRepository(
  configuration,
  Number(process.env.BOT_USER_ID),
  GITHUB_TOKEN,
  fetch,
  1_100_000,
);
await api.verifyRepository();
const pull = await api.readPull(expected.number);
if (pull.number !== expected.number || pull.state !== "open" || pull.headSha !== expected.headSha)
  throw new ProposalConflictError("The release PR changed; rerun the check on its current head.");

// A valid landing retains the captured source as its main-side parent. The only
// supported caller change is the generated self-upgrade to that reviewed source.
const proposalCaller = (await api.contents(await api.tree(pull.headSha)))[workflowPath];
if (proposalCaller !== updateToolPins(caller, baseSha))
  throw new ProposalConflictError("Refresh the release proposal from current main before replay.");

await execute(process.execPath, ["scripts/install-producer-runtimes.ts"], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RUNNER_TEMP,
    TOOL_SHA: baseSha,
    CONFIGURATION: configurationJSON,
    VERIFICATION_RUNTIMES: pins,
  },
  timeout: 900_000,
});
const registry: unknown = JSON.parse(
  await readFile(join(RUNNER_TEMP, "release-producer-runtimes.json"), "utf8"),
);
const verified = await withProducerRuntimes(await loadProducerRuntimes(registry), () =>
  verifyPrevious(api, pull, configuration, Number(process.env.BOT_USER_ID)),
);
if (verified.source.commitSha !== baseSha)
  throw new ProposalConflictError("The verified proposal source is not the checked main revision.");
console.log(JSON.stringify({ valid: true, number: pull.number, headSha: pull.headSha }));
