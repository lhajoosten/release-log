import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { migrateConsumerConfiguration } from "../src/config/consumer.ts";
import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import { isObject } from "../src/evidence/schema.ts";

const [path, repository] = process.argv.slice(2);
if (!path || !repository || process.argv.length !== 4)
  throw new Error("Usage: node scripts/migrate-consumer-release.ts CALLER_YML OWNER/REPO");

const caller: unknown = parse(await readFile(path, "utf8"), { maxAliasCount: 0 });
if (!isObject(caller) || !isObject(caller.jobs))
  throw new Error("Expected GitHub Actions jobs in the previous caller.");
const configs = Object.values(caller.jobs).flatMap((job: unknown) => {
  if (
    !isObject(job) ||
    !isObject(job.with) ||
    typeof job.uses !== "string" ||
    !/^lhajoosten\/(rolling-release|release-log)\/\.github\/workflows\/(consumer-release|rolling-release)\.yml@/u.test(
      job.uses,
    ) ||
    typeof job.with.configuration !== "string"
  )
    return [];
  return [job.with.configuration];
});
if (configs.length !== 1 || configs[0] === undefined)
  throw new Error("Expected exactly one Rolling Release job with reviewed inline configuration.");

const legacy: unknown = JSON.parse(configs[0]);
if (!isObject(legacy)) throw new Error("Expected a release configuration object.");
const repositoryExpression = "${{ github.repository }}";
if (legacy.repository === repositoryExpression) legacy.repository = repository;
if (legacy.repository !== repository)
  throw new Error("The previous caller names a different repository.");
const settings = migrateConsumerConfiguration(parseReleaseInputConfiguration(legacy));
console.log(JSON.stringify(settings, null, 2));
