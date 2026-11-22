import { isDeepStrictEqual } from "node:util";
import { inspectGitTree, readGitBlob } from "../git.ts";
import { invalid, isObject } from "../evidence/schema.ts";
import { parseReleaseInputConfiguration } from "./repository.ts";
import type { ReleaseInputConfiguration } from "./repository.ts";

export const consumerSettingsPath = ".release-log/settings.json";
const maximumSettingsBytes = 32 * 1024;

interface Caller {
  readonly repository: string;
  readonly repositoryId: number;
  readonly releaseBranch: string;
}

const releaseFields = new Set([
  "bootstrap",
  "releasePolicy",
  "releaseBumps",
  "contextPolicy",
  "githubRelease",
  "changelog",
  "adoptedRelease",
  "commitMessageRepairs",
]);

export function requireConsumerConfiguration(
  value: unknown,
  caller: Caller,
): ReleaseInputConfiguration {
  const config = parseReleaseInputConfiguration(value);
  if (
    config.repository !== caller.repository ||
    config.repositoryId !== caller.repositoryId ||
    config.releaseBranch !== caller.releaseBranch ||
    config.selfUpgrade ||
    config.internalPublication ||
    config.freshSeries
  )
    return invalid(
      "Consumer release configuration must match the caller repository, ID and release branch, and cannot select provider-only release modes.",
    );
  return config;
}

export function resolveConsumerSettings(value: unknown, caller: Caller, inline?: string) {
  if (!isObject(value)) return invalid(`Expected an object in ${consumerSettingsPath}.`);
  for (const key of Object.keys(value)) {
    if (!releaseFields.has(key) && key !== "priorConfigurations")
      return invalid(`Unsupported setting "${key}" in ${consumerSettingsPath}.`);
  }

  const {
    priorConfigurations,
    contextPolicy = "required",
    releasePolicy = "release-policy-v2",
    githubRelease = true,
    changelog = {},
    ...overrides
  } = value;
  if (githubRelease !== true && githubRelease !== false)
    return invalid("githubRelease must be true or false.");
  if (
    changelog !== null &&
    (!isObject(changelog) ||
      Object.keys(changelog).some((key) => key !== "verbosity" && key !== "format"))
  )
    return invalid("Changelog settings accept verbosity and format.");
  const { verbosity = "concise", format = "compact" } = changelog ?? {};
  const configuration = requireConsumerConfiguration(
    inline
      ? parseSettingsJSON(inline, "inline configuration")
      : {
          ...caller,
          ...overrides,
          schemaVersion: Object.hasOwn(overrides, "bootstrap") ? 2 : 1,
          releasePolicy,
          ...(contextPolicy === null ? {} : { contextPolicy }),
          ...(githubRelease ? { githubRelease: true } : {}),
          ...(changelog === null
            ? {}
            : { changelog: { verbosity, ...(format === null ? {} : { format }) } }),
        },
    caller,
  );

  if (
    priorConfigurations !== undefined &&
    (!Array.isArray(priorConfigurations) || priorConfigurations.length > 8)
  )
    return invalid("priorConfigurations accepts up to eight reviewed configuration objects.");
  const historical = (priorConfigurations ?? []).map((prior: unknown) =>
    requireConsumerConfiguration(prior, caller),
  );
  return { configuration, historical };
}

export function migrateConsumerConfiguration(
  config: ReleaseInputConfiguration,
): Record<string, unknown> {
  const {
    repository,
    repositoryId,
    releaseBranch,
    schemaVersion: _version,
    contextPolicy,
    githubRelease,
    changelog,
    ...existing
  } = config;
  const caller = { repository, repositoryId, releaseBranch };
  const settings = {
    ...existing,
    contextPolicy: contextPolicy ?? null,
    githubRelease: githubRelease === true,
    changelog: changelog ? { ...changelog, format: changelog.format ?? null } : null,
  };
  if (!isDeepStrictEqual(resolveConsumerSettings(settings, caller).configuration, config))
    return invalid("The migrated settings do not preserve the captured release configuration.");
  return settings;
}

function parseSettingsJSON(raw: string, label: string): unknown {
  if (Buffer.byteLength(raw) > maximumSettingsBytes)
    return invalid(`${label} exceeds the 32 KiB limit.`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalid(`Invalid JSON in ${label}.`);
  }
}

export async function readConsumerSettings(
  repository: string,
  sourceSha: string,
  caller: Caller,
  inline?: string,
) {
  const tree = await inspectGitTree(repository, sourceSha);
  const entry = tree.entries.get(consumerSettingsPath);
  if (entry === undefined) return resolveConsumerSettings({}, caller, inline);
  if (inline) return invalid(`Remove inline configuration when adopting ${consumerSettingsPath}.`);
  if (entry.type !== "blob" || entry.mode !== "100644")
    return invalid(`${consumerSettingsPath} must be a regular tracked JSON file.`);
  return resolveConsumerSettings(
    parseSettingsJSON(await readGitBlob(repository, entry.sha), consumerSettingsPath),
    caller,
  );
}
