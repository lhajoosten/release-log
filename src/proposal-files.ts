import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isCargoManifest, isProposalPath, proposalPaths, workflowPath } from "./proposal-paths.ts";
import { cargoMemberPaths, readCargoContents } from "./cargo-version.ts";
import {
  prepareVerifiedRelease,
  validateReleaseFileContents,
  ProposalFilesError,
  releaseInputPaths,
} from "./proposal/prepare.ts";
import type { PreparedRelease, ReleaseFileContents } from "./proposal/prepare.ts";
import type { ReleaseVersionConfiguration } from "./planning/derive-release-plan.ts";
import { replayReleaseSnapshot } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./config/repository.ts";

export { ProposalFilesError, releaseInputPaths } from "./proposal/prepare.ts";
export type { ProposalFile, PreparedRelease, ReleaseFileContents } from "./proposal/prepare.ts";
export { proposalPaths } from "./proposal-paths.ts";
export type { ProposalPath } from "./proposal-paths.ts";

const allowed: ReadonlySet<string> = new Set(proposalPaths);
const readable: ReadonlySet<string> = new Set(releaseInputPaths);

async function inspectPath(root: string, relative: string): Promise<string> {
  if (!readable.has(relative) && !isProposalPath(relative))
    throw new ProposalFilesError("Only supported proposal paths are permitted.");
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
    ...(await readCargoContents((path) => currentFile(root, path))),
    [workflowPath]: expected.selfUpgrade ? await currentFile(root, workflowPath) : null,
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
  validateReleaseFileContents(contents);
  const snapshot = await replayReleaseSnapshot(snapshotJSON, expected);
  return prepareVerifiedRelease(snapshot, version, contents);
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
  const cargoRoot = prepared.files.some(
    ({ path }) => path === "Cargo.lock" || isCargoManifest(path),
  )
    ? await currentFile(root, "Cargo.toml")
    : null;
  const cargoOutputs = new Set<string>(
    cargoRoot === null ? [] : ["Cargo.toml", "Cargo.lock", ...cargoMemberPaths(cargoRoot)],
  );
  for (const file of prepared.files) {
    if (!allowed.has(file.path) && (!cargoOutputs.has(file.path) || file.before === null))
      throw new ProposalFilesError("Only supported proposal paths are permitted.");
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
