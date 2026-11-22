import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import { readToolPin, workflowPath } from "../src/tool-upgrade.ts";
import { parseProducerPins } from "../src/config/producer-pins.ts";
import { requireConsumerConfiguration } from "../src/config/consumer.ts";

const execute = promisify(execFile);
const activeSha = process.env.TOOL_SHA;
const temporary = process.env.RUNNER_TEMP;
if (!activeSha || !/^[a-f0-9]{40}$/u.test(activeSha) || !temporary)
  throw new Error("Pinned active tool SHA and runner temporary directory are required.");
const pins = parseProducerPins(JSON.parse(process.env.VERIFICATION_RUNTIMES ?? "[]"));
if (pins.some(({ sha }) => sha === activeSha))
  throw new Error("The active producer must be omitted from verification pins.");
const configuration = parseReleaseInputConfiguration(
  JSON.parse(process.env.CONFIGURATION ?? "null") as unknown,
);
const historical: unknown = JSON.parse(process.env.HISTORICAL_CONFIGURATIONS ?? "[]");
if (!Array.isArray(historical) || historical.length > 8)
  throw new Error("Expected at most eight reviewed historical release configurations.");
const configurations = historical.map((config: unknown) =>
  requireConsumerConfiguration(config, configuration),
);
// This predecessor is anchored in the reviewed active tool checkout, never the
// consumer checkout or a snapshot-selected revision. Legacy pins are terminals.
if (configuration.selfUpgrade) {
  const predecessor = readToolPin(await readFile(workflowPath, "utf8"));
  if (predecessor !== activeSha && !pins.some((pin) => pin.sha === predecessor))
    pins.push({ sha: predecessor, legacy: false });
}
const producers: { sha: string; legacy: boolean; directory: string }[] = [];
for (const pin of pins) {
  if (pins.length > 20)
    throw new Error("Producer history exceeds twenty trusted runtimes; review registry retention.");
  const directory = join(temporary, "release-producers", pin.sha);
  await mkdir(directory, { recursive: true });
  const run = async (command: string, args: string[]) =>
    execute(command, args, {
      cwd: directory,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  await run("git", ["init"]);
  await run("git", [
    "fetch",
    "--depth=1",
    "https://github.com/lhajoosten/rolling-release.git",
    pin.sha,
  ]).catch(async () => {
    await run("git", [
      "fetch",
      "--depth=1",
      "https://github.com/lhajoosten/rolling-release.git",
      pin.sha,
    ]).catch((cause: unknown) => {
      throw new Error(
        `Cannot fetch reviewed producer ${pin.sha}. Retry the workflow or ask Rolling Release to restore this source revision.`,
        { cause },
      );
    });
  });
  await run("git", ["checkout", "--detach", pin.sha]);
  if ((await run("git", ["rev-parse", "HEAD"])).stdout.trim() !== pin.sha)
    throw new Error("Verification runtime checkout does not match its trusted pin.");
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
  await run("pnpm", ["build"]);
  producers.push({ ...pin, directory });
  if (configuration.selfUpgrade && !pin.legacy) {
    const predecessor = readToolPin(await readFile(join(directory, workflowPath), "utf8"));
    if (predecessor !== activeSha && !pins.some((item) => item.sha === predecessor))
      pins.push({ sha: predecessor, legacy: false });
  }
}
await writeFile(
  join(temporary, "release-producer-runtimes.json"),
  JSON.stringify({
    activeSha,
    producers,
    ...(configurations.length > 0 ? { configurations } : {}),
  }),
);
