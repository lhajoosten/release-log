import { jsonPropertyRange, record, VersionFilesError } from "./version-adapters.ts";
import type { NpmLockPath } from "./version-paths.ts";
import type { VersionPlan } from "./version-adapters.ts";

export function updateNpmLockVersion(
  source: string,
  path: NpmLockPath,
  manifestVersion: string,
  plan: VersionPlan,
): string {
  let lock: unknown;
  try {
    lock = JSON.parse(source);
  } catch {
    throw new VersionFilesError(
      `${path} must be valid JSON. Regenerate and commit the lockfile before retrying.`,
    );
  }

  if (
    !record(lock) ||
    (lock.lockfileVersion !== 1 && lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
  )
    throw new VersionFilesError(`${path} requires npm lockfile format 1, 2, or 3.`);

  jsonPropertyRange(source, "lockfileVersion", path);
  if (lock.lockfileVersion === 1 && "packages" in lock)
    throw new VersionFilesError(
      `${path} format 1 must not contain a packages object. Regenerate and commit the lockfile before retrying.`,
    );

  const stale = `${path} root version must match package.json. Regenerate and commit the lockfile before retrying.`;
  const rootVersion = jsonPropertyRange(source, "version", path);
  if (lock.version !== manifestVersion || !rootVersion) throw new VersionFilesError(stale);

  let packageVersion: { start: number; end: number } | null = null;
  if (lock.lockfileVersion !== 1) {
    const packages = jsonPropertyRange(source, "packages", path);
    if (!packages || !record(lock.packages))
      throw new VersionFilesError(
        `${path} is missing the packages object. Regenerate and commit the lockfile before retrying.`,
      );

    const rootPackage = lock.packages[""];
    const root = jsonPropertyRange(source.slice(packages.start, packages.end), "", path);
    if (!root || !record(rootPackage) || rootPackage.version !== manifestVersion)
      throw new VersionFilesError(stale);

    const start = packages.start + root.start;
    const version = jsonPropertyRange(
      source.slice(start, packages.start + root.end),
      "version",
      path,
    );
    if (!version) throw new VersionFilesError(stale);
    packageVersion = { start: start + version.start, end: start + version.end };
  }

  if (plan.nextVersion === null || plan.nextVersion === manifestVersion) return source;

  const replacement = JSON.stringify(plan.nextVersion);
  const ranges = packageVersion ? [rootVersion, packageVersion] : [rootVersion];
  let result = source;
  for (const range of ranges.toSorted((left, right) => right.start - left.start))
    result = result.slice(0, range.start) + replacement + result.slice(range.end);
  return result;
}
