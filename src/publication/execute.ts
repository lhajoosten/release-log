import type { GitHubRead } from "../github.ts";
import { parseReleaseApproval, parseReleaseApprovalPolicy } from "../release-approval.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import { publicationAssets } from "./assets.ts";
import { fail } from "./error.ts";
import { writeGitHubPublicationAction } from "./github-write.ts";
import { inspectReleasePublication } from "./inspect.ts";
import type { PublicationRequest } from "./inspect.ts";
import { publicationNotes } from "./notes.ts";
import { parsePublicationPolicy, parsePublicationReceipt } from "./schema.ts";
import type { PublicationAction, PublicationInspection } from "./types.ts";

export interface GitHubPublicationRequest extends PublicationRequest {
  readonly assetDirectory: string;
  readonly write?: boolean;
}

export interface GitHubPublicationExecution {
  readonly schemaVersion: 1;
  readonly mode: "dry-run" | "write";
  readonly performed: readonly PublicationAction[];
  readonly inspection: PublicationInspection;
}

function publicationProgress(
  before: PublicationInspection,
  after: PublicationInspection,
  action: PublicationAction,
  response: Record<string, unknown>,
): void {
  const oldRelease = before.state.release;
  const newRelease = after.state.release;

  if (
    before.approvalVerificationId !== after.approvalVerificationId ||
    before.receiptId !== after.receiptId ||
    before.publicationPolicyId !== after.publicationPolicyId ||
    (before.state.tag !== null &&
      JSON.stringify(before.state.tag) !== JSON.stringify(after.state.tag)) ||
    JSON.stringify(before.state.images) !== JSON.stringify(after.state.images) ||
    (oldRelease !== null &&
      (newRelease === null ||
        newRelease.id !== oldRelease.id ||
        (!oldRelease.draft && newRelease.draft) ||
        oldRelease.assetIds.some(
          (asset) =>
            !newRelease.assetIds.some(
              (entry) => entry.name === asset.name && entry.id === asset.id,
            ),
        )))
  )
    return fail(
      "conflict",
      "Previously verified publication state changed during execution; stop and reconcile without overwriting it.",
    );

  const progressed =
    action.kind === "create-tag"
      ? after.state.tag?.objectSha === action.commitSha
      : action.kind === "create-draft-release"
        ? newRelease !== null && newRelease.id === response.id && newRelease.draft
        : action.kind === "upload-asset"
          ? newRelease?.assetIds.some(
              (asset) => asset.name === action.name && asset.id === response.id,
            )
          : action.kind === "publish-release"
            ? newRelease !== null && newRelease.id === action.releaseId && !newRelease.draft
            : false;

  if (!progressed)
    return fail(
      "write-failed",
      "The publication write was not confirmed by fresh remote evidence; inspect remote state before retrying.",
    );
}

export async function publishGitHubRelease(
  request: GitHubPublicationRequest,
  transport: GitHubRead = fetch,
): Promise<GitHubPublicationExecution> {
  if (request.write !== undefined && typeof request.write !== "boolean")
    return fail("invalid-input", "Publication requires an explicit boolean write option.");
  if (typeof request.assetDirectory !== "string" || !request.assetDirectory.trim())
    return fail("invalid-input", "Configure the local publication asset directory explicitly.");

  const write = request.write === true;
  const input: PublicationRequest = {
    repository: request.repository,
    configuration: parseReleaseInputConfiguration(request.configuration),
    approvalPolicy: parseReleaseApprovalPolicy(request.approvalPolicy),
    approval: parseReleaseApproval(request.approval),
    publicationPolicy: parsePublicationPolicy(request.publicationPolicy),
    receipt: parsePublicationReceipt(request.receipt),
    token: request.token,
    ...(request.registryToken === undefined ? {} : { registryToken: request.registryToken }),
  };
  const assets = await publicationAssets(request.assetDirectory, input.receipt);
  const signal = AbortSignal.timeout(900_000);
  const deadline = Date.now() + 900_000;
  let requests = 0;
  const bounded: GitHubRead = async (url, options) => {
    if (++requests > 2000 || Date.now() >= deadline)
      return fail(
        "resource-limit",
        "Publication execution exceeded 2000 requests or fifteen minutes; inspect remote state before retrying.",
      );

    return transport(url, {
      ...options,
      signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
    });
  };
  const notes = await publicationNotes(input.repository, input.configuration, input.approval);
  let inspection = await inspectReleasePublication(input, bounded);
  const performed: PublicationAction[] = [];
  const result = (): GitHubPublicationExecution => ({
    schemaVersion: 1,
    mode: write ? "write" : "dry-run",
    performed,
    inspection,
  });

  if (!write) return result();

  for (let step = 0; step < input.receipt.assets.length + 4; step++) {
    if (inspection.complete) return result();
    if (inspection.actions.some((action) => action.kind === "publish-image"))
      return fail(
        "conflict",
        "Configured image roots are missing; publish them through the separately authorized image job before GitHub publication. No image push is performed here.",
      );

    const action = inspection.actions[0];

    if (!action)
      return fail("incomplete-evidence", "Incomplete publication has no verifiable next action.");

    const response = await writeGitHubPublicationAction({
      action,
      inspection,
      assets,
      repository: input.configuration.repository,
      token: input.token,
      notes,
      transport: bounded,
      signal,
    });

    performed.push(action);

    const after = await inspectReleasePublication(input, bounded);

    publicationProgress(inspection, after, action, response);
    inspection = after;
  }

  return fail(
    "resource-limit",
    "Publication exceeded its bounded mutation steps; inspect remote state before retrying.",
  );
}
