import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isCargoManifest,
  isProposalPath,
  isRootLockPath,
  proposalPaths,
} from "../proposal-paths.ts";
import { cargoMemberPaths } from "../cargo-version.ts";
import { prepareReleaseFileContents, ProposalFilesError } from "./prepare.ts";
import { readReleaseContents } from "../version-file-inputs.ts";
import type { PreparedRelease } from "./prepare.ts";
import type { ReleaseVersionConfiguration } from "../planning/derive-release-plan.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";

const allowed: ReadonlySet<string> = new Set(proposalPaths);

async function inspectPath(root: string, relative: string): Promise<string> {
  if (!isProposalPath(relative))
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
    if (!isRootLockPath(relative)) return await readFile(path, "utf8");
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes))
      throw new ProposalFilesError(
        `${relative} must be UTF-8 text. Regenerate and commit the lockfile before retrying.`,
      );
    return text;
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
  return prepareReleaseFileContents(
    snapshotJSON,
    expected,
    version,
    await readReleaseContents((path) => currentFile(root, path), expected.selfUpgrade),
  );
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
    if (isRootLockPath(file.path) && file.before === null)
      throw new ProposalFilesError(`Release preparation can only update an existing ${file.path}.`);
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
