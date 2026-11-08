import { replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration, ReleaseSnapshot } from "./release-snapshot.ts";

export class ReleasePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleasePlanError";
  }
}

export type ReleaseVersionConfiguration =
  | { readonly kind: "bootstrap"; readonly initialVersion: "0.1.0" }
  | { readonly kind: "released"; readonly currentVersion: string };

export type ReleaseBump = "none" | "patch" | "minor" | "major";

export interface ReleasePlan {
  readonly schemaVersion: 1;
  readonly policy: "release-policy-v1";
  readonly snapshotId: string;
  readonly baselineCommitSha: string;
  readonly sourceCommitSha: string;
  readonly version: ReleaseVersionConfiguration;
  readonly currentVersion: string | null;
  readonly nextVersion: string | null;
  readonly release: boolean;
  readonly bump: ReleaseBump | "initial";
  readonly contributions: readonly {
    readonly number: number;
    readonly url: string;
    readonly type: string;
    readonly scope: string;
    readonly breaking: boolean;
    readonly bump: ReleaseBump;
  }[];
}

const ranks: Record<ReleaseBump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

function parseVersion(value: string): readonly [bigint, bigint, bigint] {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)
  )
    throw new ReleasePlanError(
      "Expected a stable MAJOR.MINOR.PATCH version, at most 128 characters.",
    );
  const [major, minor, patch] = value.split(".");
  if (major === undefined || minor === undefined || patch === undefined)
    throw new ReleasePlanError("Version components are missing.");
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

function versionConfiguration(
  value: ReleaseVersionConfiguration,
  snapshot: ReleaseSnapshot,
): ReleaseVersionConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ReleasePlanError(
      "An explicit bootstrap or released version configuration is required.",
    );
  const keys = Object.keys(value).toSorted().join(",");
  if (
    value.kind === "bootstrap" &&
    keys === "initialVersion,kind" &&
    value.initialVersion === "0.1.0"
  ) {
    if (snapshot.input.range.baseline.kind !== "bootstrap")
      throw new ReleasePlanError(
        "Bootstrap configuration cannot replace a captured released baseline.",
      );
    return { kind: "bootstrap", initialVersion: "0.1.0" };
  }
  if (value.kind === "released" && keys === "currentVersion,kind") {
    parseVersion(value.currentVersion);
    const baseline = snapshot.input.range.baseline;
    if (baseline.kind !== "tag" || baseline.name !== `v${value.currentVersion}`)
      throw new ReleasePlanError(
        "The current version must match the captured released baseline tag.",
      );
    return { kind: "released", currentVersion: value.currentVersion };
  }
  throw new ReleasePlanError(
    "Unsupported version configuration; bootstrap requires initialVersion 0.1.0.",
  );
}

export async function createReleasePlan(
  serializedSnapshot: string,
  expected: ReleaseInputConfiguration,
  selectedVersion: ReleaseVersionConfiguration,
): Promise<ReleasePlan> {
  const snapshot = await replayReleaseSnapshot(serializedSnapshot, expected);
  const version = versionConfiguration(selectedVersion, snapshot);
  const currentVersion = version.kind === "released" ? version.currentVersion : null;
  const current = parseVersion(currentVersion ?? "0.1.0");
  let highest: ReleaseBump = "none";
  const contributions = snapshot.normalized.pullRequests.map((pull) => {
    const breaking = pull.title.breaking || pull.commits.some((entry) => entry.metadata.breaking);
    let bump: ReleaseBump;
    if (breaking) bump = current[0] === 0n ? "minor" : "major";
    else if (pull.title.type === "feat") bump = "minor";
    else if (["fix", "perf", "revert"].includes(pull.title.type)) bump = "patch";
    else if (
      ["build", "chore", "ci", "docs", "refactor", "style", "test"].includes(pull.title.type)
    )
      bump = "none";
    else throw new ReleasePlanError("The captured PR type is not part of release-policy-v1.");
    if (ranks[bump] > ranks[highest]) highest = bump;
    if (!pull.title.scope) throw new ReleasePlanError("Release entries require a scoped PR title.");
    return {
      number: pull.number,
      url: pull.url,
      type: pull.title.type,
      scope: pull.title.scope,
      breaking,
      bump,
    };
  });
  let nextVersion: string | null = null;
  let bump: ReleasePlan["bump"] = highest;
  if (highest !== "none") {
    if (version.kind === "bootstrap") {
      nextVersion = version.initialVersion;
      bump = "initial";
    } else {
      const [major, minor, patch] = current;
      nextVersion =
        highest === "major"
          ? `${major + 1n}.0.0`
          : highest === "minor"
            ? `${major}.${minor + 1n}.0`
            : `${major}.${minor}.${patch + 1n}`;
      parseVersion(nextVersion);
    }
  }
  return {
    schemaVersion: 1,
    policy: "release-policy-v1",
    snapshotId: snapshot.snapshotId,
    baselineCommitSha: snapshot.normalized.baselineCommitSha,
    sourceCommitSha: snapshot.normalized.sourceCommitSha,
    version,
    currentVersion,
    nextVersion,
    release: nextVersion !== null,
    bump,
    contributions,
  };
}
