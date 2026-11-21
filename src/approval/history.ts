import { readCargoContents } from "../cargo-version.ts";
import { inspectGitTreeWithCommit, inspectPendingRelease, readGitBlob } from "../git.ts";
import type { ResolvedReleaseBaseline } from "../git.ts";
import type { ProposalTree } from "../github-proposals.ts";
import { reconstructProposal } from "../producer-runtime.ts";
import { capturedVerificationConfiguration } from "../proposal/verification.ts";
import type { ReleaseFileContents } from "../proposal/prepare.ts";
import { capturedIdentity, verifyGeneratedTree } from "../proposal/identity.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { ReleaseApprovalError } from "./validation.ts";

export async function readLocalProposalTree(
  repository: string,
  commitSha: string,
): Promise<ProposalTree> {
  const { tree, commit } = await inspectGitTreeWithCommit(repository, commitSha);
  return { ...tree, message: commit.message, parents: commit.parentShas };
}
export async function readProposalContents(
  repository: string,
  tree: ProposalTree,
  includeWorkflow = false,
): Promise<ReleaseFileContents> {
  const get = async (path: string): Promise<string | null> => {
    if (path.startsWith(".github/"))
      for (const name of [".github", ".github/workflows"]) {
        const entry = tree.entries.get(name);
        if (entry && (entry.type !== "tree" || entry.mode !== "040000"))
          throw new ReleaseApprovalError(
            "content-mismatch",
            "Workflow directories must be ordinary Git trees.",
          );
      }
    const directory = tree.entries.get(".release-log");
    if (
      path.startsWith(".release-log/") &&
      directory &&
      (directory.type !== "tree" || directory.mode !== "040000")
    )
      throw new ReleaseApprovalError(
        "content-mismatch",
        "The approved snapshot directory must not be a symlink or submodule.",
      );
    const entry = tree.entries.get(path);
    if (!entry) return null;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new ReleaseApprovalError(
        "content-mismatch",
        "Approved proposal inputs must be ordinary tracked files.",
      );
    return readGitBlob(repository, entry.sha);
  };
  return {
    ".github/workflows/rolling-release-caller.yml": includeWorkflow
      ? await get(".github/workflows/rolling-release-caller.yml")
      : null,
    ...(await readCargoContents(get)),
    "package.json": await get("package.json"),
    "pyproject.toml": await get("pyproject.toml"),
    "CHANGELOG.md": await get("CHANGELOG.md"),
    ".release-log/inputs.json": await get(".release-log/inputs.json"),
    "package-lock.json": await get("package-lock.json"),
    "npm-shrinkwrap.json": await get("npm-shrinkwrap.json"),
    "uv.lock": await get("uv.lock"),
  };
}

export async function verifyProposalHistory(
  repository: string,
  config: ReleaseInputConfiguration,
  botUserId: number,
  sourceSha: string,
  headSha: string,
  expectedBaseline: ResolvedReleaseBaseline,
): Promise<readonly string[]> {
  const history = await inspectPendingRelease(
    repository,
    { kind: "bootstrap", commitSha: sourceSha },
    headSha,
  );

  if (history.commitShas.length > 100)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Proposal history exceeds 100 generated commits; explicit recovery is required.",
    );

  const deadline = Date.now() + 300_000;
  let snapshotBytes = 0;
  let completedHead: string | null | undefined;

  const findCompletedHead = async (): Promise<string | null> => {
    if (completedHead !== undefined) return completedHead;
    completedHead = null;
    if (expectedBaseline.kind !== "tag") return completedHead;
    const landing = await readLocalProposalTree(repository, expectedBaseline.commitSha);
    for (const candidateSha of history.commitShas) {
      if (Date.now() >= deadline)
        throw new ReleaseApprovalError(
          "resource-limit",
          "Proposal history verification exceeded five minutes; no exclusion is usable.",
        );
      if (candidateSha === headSha) continue;
      const candidate = await readLocalProposalTree(repository, candidateSha);
      const source = candidate.parents[0];
      if (!source || candidate.treeSha !== landing.treeSha) continue;
      const squash = landing.parents.length === 1 && landing.parents[0] === source;
      const merge =
        landing.parents.length === 2 &&
        landing.parents[0] === source &&
        landing.parents[1] === candidateSha;
      if (!squash && !merge) continue;
      if (completedHead !== null)
        throw new ReleaseApprovalError(
          "identity-mismatch",
          "Multiple proposal heads match the tagged release landing.",
        );
      completedHead = candidateSha;
    }
    return completedHead;
  };

  for (const commitSha of history.commitShas) {
    if (Date.now() >= deadline)
      throw new ReleaseApprovalError(
        "resource-limit",
        "Proposal history verification exceeded five minutes; no exclusion is usable.",
      );

    // The caller has already checked the current head; older parents need the same scrutiny.
    if (commitSha === headSha) continue;

    const head = await readLocalProposalTree(repository, commitSha);
    const marker = capturedIdentity(head.message);
    const files = await readProposalContents(repository, head, config.selfUpgrade === true);
    const snapshotJSON = files[".release-log/inputs.json"];

    if (snapshotJSON === null)
      throw new ReleaseApprovalError(
        "content-mismatch",
        "A prior proposal head is missing its captured inputs; do not exclude its history.",
      );

    snapshotBytes += Buffer.byteLength(snapshotJSON, "utf8");

    if (snapshotBytes > 16 * 1024 * 1024)
      throw new ReleaseApprovalError(
        "resource-limit",
        "Prior proposal snapshots exceed the 16 MiB audit budget.",
      );

    const source = await readLocalProposalTree(repository, marker.sourceSha);
    const { snapshot, prepared, description } = await reconstructProposal(
      snapshotJSON,
      capturedVerificationConfiguration(snapshotJSON, config),
      marker.version,
      await readProposalContents(repository, source, config.selfUpgrade === true),
      botUserId,
      marker.previousHeadSha,
      marker.producerSha,
      marker.bodyFormat,
    );
    const capturedBaseline = snapshot.input.range.baseline;
    const range = await inspectPendingRelease(
      repository,
      capturedBaseline.kind === "tag"
        ? { kind: "tag", name: capturedBaseline.name }
        : capturedBaseline,
      marker.sourceSha,
    );

    if (JSON.stringify(capturedBaseline) !== JSON.stringify(expectedBaseline)) {
      const completed = await findCompletedHead();
      if (completed === null)
        throw new ReleaseApprovalError(
          "identity-mismatch",
          "A prior proposal belongs to a different baseline without a matching tagged landing.",
        );
      await inspectPendingRelease(repository, { kind: "bootstrap", commitSha }, completed);
    }

    if (
      snapshot.normalized.sourceCommitSha !== marker.sourceSha ||
      JSON.stringify(range.baseline) !== JSON.stringify(capturedBaseline) ||
      JSON.stringify(range.commitShas.toSorted()) !==
        JSON.stringify(snapshot.input.range.commitShas.toSorted())
    )
      throw new ReleaseApprovalError(
        "identity-mismatch",
        "A prior proposal snapshot has inconsistent source, baseline or Git membership.",
      );

    await inspectPendingRelease(
      repository,
      { kind: "bootstrap", commitSha: marker.sourceSha },
      sourceSha,
    );

    if (
      commitSha === completedHead &&
      `v${prepared.plan.nextVersion}` !==
        (expectedBaseline.kind === "tag" ? expectedBaseline.name : "")
    )
      throw new ReleaseApprovalError(
        "identity-mismatch",
        "The completed proposal version does not match its tagged landing.",
      );
    const parents =
      marker.previousHeadSha && marker.previousHeadSha !== marker.sourceSha
        ? [marker.sourceSha, marker.previousHeadSha]
        : [marker.sourceSha];

    if (
      head.message !== description.message ||
      JSON.stringify(head.parents) !== JSON.stringify(parents)
    )
      throw new ReleaseApprovalError(
        "identity-mismatch",
        "A prior proposal commit does not match its generated identity and parents.",
      );

    verifyGeneratedTree(source, head, prepared.files);

    if (prepared.files.some((file) => files[file.path] !== file.after))
      throw new ReleaseApprovalError(
        "content-mismatch",
        "A prior proposal contains edited generated outputs; do not exclude it.",
      );
  }

  if (Date.now() >= deadline)
    throw new ReleaseApprovalError(
      "resource-limit",
      "Proposal history verification exceeded five minutes; no exclusion is usable.",
    );

  return history.commitShas;
}
