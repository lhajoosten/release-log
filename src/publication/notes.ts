import { renderChangelog } from "../changelog.ts";
import { inspectGitTree, readGitBlob } from "../git.ts";
import type { ReleaseApproval } from "../approval/record.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { fail } from "./error.ts";

export async function publicationNotes(
  repository: string,
  configuration: ReleaseInputConfiguration,
  approval: ReleaseApproval,
): Promise<string> {
  const tree = await inspectGitTree(repository, approval.landingSha);
  const captured = tree.entries.get(".release-log/inputs.json");

  if (!captured || captured.type !== "blob" || !["100644", "100755"].includes(captured.mode))
    return fail(
      "incomplete-evidence",
      "The approved landing is missing its ordinary captured-input file.",
    );

  const notes = await renderChangelog(
    await readGitBlob(repository, captured.sha),
    configuration,
    approval.baseline.kind === "tag"
      ? { kind: "released", currentVersion: approval.baseline.name.slice(1) }
      : { kind: "bootstrap", initialVersion: "0.1.0" },
  );

  if (notes === null)
    return fail("conflict", "A no-release plan cannot enter publication reconciliation.");

  return notes;
}
