import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderChangelog, updateChangelog } from "./changelog.ts";
import { createReleasePlan } from "./release-plan.ts";
import type { ReleasePlan, ReleaseVersionConfiguration } from "./release-plan.ts";
import { replayReleaseSnapshot, serializeReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";
import { updatePackageVersion, updatePyprojectVersion } from "./version-files.ts";

export class ProposalFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalFilesError";
  }
}
export const proposalPaths = [
  "package.json",
  "pyproject.toml",
  "CHANGELOG.md",
  ".release-log/inputs.json",
] as const;
export type ProposalPath = (typeof proposalPaths)[number];

export interface ProposalFile {
  readonly path: ProposalPath;
  readonly before: string | null;
  readonly after: string;
}
export interface PreparedRelease {
  readonly plan: ReleasePlan;
  readonly files: readonly ProposalFile[];
}
const allowed: ReadonlySet<string> = new Set(proposalPaths);
const unsupportedLocks = ["package-lock.json", "npm-shrinkwrap.json", "uv.lock"] as const;
export const releaseInputPaths = [...proposalPaths, ...unsupportedLocks] as const;
export type ReleaseFileContents = Readonly<
  Record<(typeof releaseInputPaths)[number], string | null>
>;
const readable: ReadonlySet<string> = new Set(releaseInputPaths);

async function inspectPath(root: string, relative: string): Promise<string> {
  if (!readable.has(relative))
    throw new ProposalFilesError("Only the fixed proposal output paths are permitted.");
  let target = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    try {
      const info = await lstat(target);
      if (
        info.isSymbolicLink() ||
        (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
      )
        throw new ProposalFilesError(
          "Proposal output paths must be ordinary files in ordinary directories, not symlinks.",
        );
      if (info.isFile() && info.size > 16 * 1024 * 1024)
        throw new ProposalFilesError("A proposal file exceeds 16 MiB.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return target;
}

async function rootPath(repository: string): Promise<string> {
  const selected = resolve(repository);
  if ((await lstat(selected)).isSymbolicLink())
    throw new ProposalFilesError("Select a real repository directory, not a symlink.");
  return realpath(selected);
}

async function currentFile(root: string, relative: string): Promise<string | null> {
  const path = await inspectPath(root, relative);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function prepareReleaseFiles(
  repository: string,
  snapshotJSON: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
): Promise<PreparedRelease> {
  const root = await rootPath(repository);
  return prepareReleaseFileContents(snapshotJSON, expected, version, {
    "package.json": await currentFile(root, "package.json"),
    "pyproject.toml": await currentFile(root, "pyproject.toml"),
    "CHANGELOG.md": await currentFile(root, "CHANGELOG.md"),
    ".release-log/inputs.json": await currentFile(root, ".release-log/inputs.json"),
    "package-lock.json": await currentFile(root, "package-lock.json"),
    "npm-shrinkwrap.json": await currentFile(root, "npm-shrinkwrap.json"),
    "uv.lock": await currentFile(root, "uv.lock"),
  });
}

export async function prepareReleaseFileContents(
  snapshotJSON: string,
  expected: ReleaseInputConfiguration,
  version: ReleaseVersionConfiguration,
  contents: ReleaseFileContents,
): Promise<PreparedRelease> {
  for (const path of releaseInputPaths) {
    const value = contents[path];
    if (
      value !== null &&
      (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024 * 1024)
    )
      throw new ProposalFilesError(
        "Proposal input files require bounded UTF-8 text or explicit null.",
      );
  }
  const plan = await createReleasePlan(snapshotJSON, expected, version);
  for (const lock of unsupportedLocks) {
    if (contents[lock] !== null)
      throw new ProposalFilesError(
        `${lock} needs a root-version mirror adapter before preparing a release; no files were written.`,
      );
  }
  const packageJSON = contents["package.json"];
  const pyprojectTOML = contents["pyproject.toml"];
  if (packageJSON === null && pyprojectTOML === null)
    throw new ProposalFilesError(
      "A root package.json or pyproject.toml with a static version is required.",
    );
  const manifests: ProposalFile[] = [];
  const packageUpdate = packageJSON === null ? null : updatePackageVersion(packageJSON, plan);
  const pythonUpdate = pyprojectTOML === null ? null : updatePyprojectVersion(pyprojectTOML, plan);
  if (packageUpdate && pythonUpdate && packageUpdate.version !== pythonUpdate.version)
    throw new ProposalFilesError(
      "Node and Python manifest versions disagree; align them before planning.",
    );
  if (packageJSON !== null && packageUpdate)
    manifests.push({ path: "package.json", before: packageJSON, after: packageUpdate.content });
  if (pyprojectTOML !== null && pythonUpdate)
    manifests.push({ path: "pyproject.toml", before: pyprojectTOML, after: pythonUpdate.content });
  const changelog = contents["CHANGELOG.md"];
  const rendered = await renderChangelog(snapshotJSON, expected, version);
  const updatedChangelog = updateChangelog(changelog ?? "", rendered);
  if (!plan.release) return { plan, files: [] };
  const snapshot = await replayReleaseSnapshot(snapshotJSON, expected);
  const inputs = contents[".release-log/inputs.json"];
  return {
    plan,
    files: [
      ...manifests,
      { path: "CHANGELOG.md", before: changelog, after: updatedChangelog },
      {
        path: ".release-log/inputs.json",
        before: inputs,
        after: await serializeReleaseSnapshot(snapshot),
      },
    ],
  };
}

export async function writeReleaseFiles(
  repository: string,
  prepared: PreparedRelease,
): Promise<void> {
  const root = await rootPath(repository);
  if (!prepared.plan.release && prepared.files.length)
    throw new ProposalFilesError("A no-release plan cannot write proposal files.");
  if (new Set(prepared.files.map((file) => file.path)).size !== prepared.files.length)
    throw new ProposalFilesError("Duplicate proposal output paths.");
  for (const file of prepared.files) {
    if (!allowed.has(file.path))
      throw new ProposalFilesError("Only the fixed proposal output paths are permitted.");
    if (Buffer.byteLength(file.after, "utf8") > 16 * 1024 * 1024)
      throw new ProposalFilesError("A proposal output exceeds 16 MiB.");
    if ((await currentFile(root, file.path)) !== file.before)
      throw new ProposalFilesError(
        "Proposal inputs changed after preparation; regenerate rather than overwriting edits.",
      );
  }
  for (const file of prepared.files) {
    const destination = await inspectPath(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    if ((await realpath(dirname(destination))) !== dirname(destination))
      throw new ProposalFilesError("An output directory changed or resolves through a symlink.");
    const temporary = join(dirname(destination), `.release-log-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, file.after, { flag: "wx", mode: 0o600 });
      if ((await currentFile(root, file.path)) !== file.before)
        throw new ProposalFilesError("A proposal file changed before replacement; regenerate.");
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  }
}
