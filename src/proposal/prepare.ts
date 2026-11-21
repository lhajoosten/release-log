import { updateChangelog } from "../changelog/history.ts";
import { updateToolPins } from "./tool-pins.ts";
import { proposalPaths, workflowPath } from "../proposal-paths.ts";
import type { ProposalPath } from "../proposal-paths.ts";
import { renderPlannedChangelog } from "../changelog/render.ts";
import { deriveReleasePlan } from "../planning/derive-release-plan.ts";
import type { ReleasePlan, ReleaseVersionConfiguration } from "../planning/derive-release-plan.ts";
import { encodeVerifiedSnapshot } from "../snapshot/canonical.ts";
import type { ReleaseSnapshot } from "../snapshot/model.ts";
import { replayReleaseSnapshot } from "../snapshot/replay.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { updateCargoVersions } from "../cargo-version.ts";
import type { CargoContents } from "../cargo-version.ts";
import { updateUvLockVersion } from "../uv-version.ts";
import { updatePackageVersion, updatePyprojectVersion } from "../version-files.ts";

export class ProposalFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalFilesError";
  }
}

export interface ProposalFile {
  readonly path: ProposalPath;
  readonly before: string | null;
  readonly after: string;
}
export interface PreparedRelease {
  readonly plan: ReleasePlan;
  readonly pendingChangelog?: string;
  readonly files: readonly ProposalFile[];
}
const unsupportedLocks = ["package-lock.json", "npm-shrinkwrap.json"] as const;
export const releaseInputPaths = [...proposalPaths, ...unsupportedLocks] as const;
export type ReleaseFileContents = Readonly<
  Record<Exclude<(typeof releaseInputPaths)[number], typeof workflowPath>, string | null> &
    Partial<Record<typeof workflowPath, string | null>> &
    CargoContents
>;

export function validateReleaseFileContents(contents: ReleaseFileContents): void {
  for (const value of Object.values(contents)) {
    if (
      value != null &&
      (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024 * 1024)
    )
      throw new ProposalFilesError(
        "Proposal input files require bounded UTF-8 text or explicit null.",
      );
  }
}

export function prepareVerifiedRelease(
  snapshot: ReleaseSnapshot,
  version: ReleaseVersionConfiguration,
  contents: ReleaseFileContents,
): PreparedRelease {
  const plan = deriveReleasePlan(snapshot, version);
  for (const lock of unsupportedLocks) {
    if (contents[lock] !== null)
      throw new ProposalFilesError(
        `${lock} needs a root-version mirror adapter before preparing a release; no files were written.`,
      );
  }
  const packageJSON = contents["package.json"];
  const pyprojectTOML = contents["pyproject.toml"];
  const uvLock = contents["uv.lock"];
  if (uvLock !== null && pyprojectTOML === null)
    throw new ProposalFilesError(
      "uv.lock requires a root pyproject.toml; restore and commit the manifest before retrying.",
    );
  const cargo = updateCargoVersions(contents, plan);
  if (packageJSON === null && pyprojectTOML === null && cargo === null)
    throw new ProposalFilesError(
      "A root package.json, pyproject.toml, or Cargo.toml with a static release version is required.",
    );
  const manifests: ProposalFile[] = [];
  const packageUpdate = packageJSON === null ? null : updatePackageVersion(packageJSON, plan);
  const pythonUpdate = pyprojectTOML === null ? null : updatePyprojectVersion(pyprojectTOML, plan);
  if (packageUpdate && pythonUpdate && packageUpdate.version !== pythonUpdate.version)
    throw new ProposalFilesError(
      "Node and Python manifest versions disagree; align them before planning.",
    );
  if (cargo) {
    if ([packageUpdate, pythonUpdate].some((update) => update && update.version !== cargo.version))
      throw new ProposalFilesError(
        "Cargo and other manifest versions disagree; align them before planning.",
      );
    manifests.push(...cargo.files);
  }
  if (packageJSON !== null && packageUpdate)
    manifests.push({ path: "package.json", before: packageJSON, after: packageUpdate.content });
  if (pyprojectTOML !== null && pythonUpdate)
    manifests.push({ path: "pyproject.toml", before: pyprojectTOML, after: pythonUpdate.content });
  if (uvLock !== null && pyprojectTOML !== null && pythonUpdate)
    manifests.push({
      path: "uv.lock",
      before: uvLock,
      after: updateUvLockVersion(pyprojectTOML, uvLock, pythonUpdate, plan),
    });
  const changelog = contents["CHANGELOG.md"];
  const rendered = renderPlannedChangelog(snapshot, plan);
  const updatedChangelog = updateChangelog(
    changelog ?? "",
    rendered,
    version.kind === "released" ? version.currentVersion : undefined,
  );
  if (!plan.release) return { plan, files: [] };
  if (rendered === null) throw new ProposalFilesError("A release plan must render a changelog.");
  const inputs = contents[".release-log/inputs.json"];
  return {
    plan,
    pendingChangelog: rendered,
    files: [
      ...manifests,
      ...(snapshot.configuration.selfUpgrade === true
        ? [
            {
              path: workflowPath,
              before: contents[workflowPath] ?? null,
              after: updateToolPins(contents[workflowPath] ?? null, plan.sourceCommitSha),
            },
          ]
        : []),
      { path: "CHANGELOG.md", before: changelog, after: updatedChangelog },
      {
        path: ".release-log/inputs.json",
        before: inputs,
        after: encodeVerifiedSnapshot(snapshot),
      },
    ],
  };
}

export async function prepareReleaseFileContents(
  snapshotJSON: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
  contents: ReleaseFileContents,
): Promise<PreparedRelease> {
  validateReleaseFileContents(contents);
  const snapshot = await replayReleaseSnapshot(snapshotJSON, expected);
  return prepareVerifiedRelease(snapshot, version, contents);
}
