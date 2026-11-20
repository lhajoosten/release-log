import { createHash } from "node:crypto";
import { GitHubProposalRepository, proposalObject, proposalSha } from "../github-proposals.ts";
import { GitHubReadError } from "../github.ts";
import type { GitHubRead } from "../github.ts";
import {
  parseReleaseApproval,
  parseReleaseApprovalPolicy,
  verifyReleaseApproval,
} from "../release-approval.ts";
import type { ReleaseApproval, ReleaseApprovalPolicy } from "../release-approval.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";
import type { ReleaseInputConfiguration } from "../config/repository.ts";
import { fail } from "./error.ts";
import { publicationNotes } from "./notes.ts";
import { planPublicationActions } from "./plan.ts";
import { registryImage } from "./registry.ts";
import { parsePublicationPolicy, parsePublicationReceipt } from "./schema.ts";
import type {
  PublicationInspection,
  PublicationPolicy,
  PublicationReceipt,
  PublicationState,
} from "./types.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function optional(
  api: GitHubProposalRepository,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return proposalObject((await api.request(path)).data);
  } catch (error) {
    if (error instanceof GitHubReadError && error.status === 404) return null;
    throw error;
  }
}

async function publishedTag(
  api: GitHubProposalRepository,
  name: string,
  landingSha: string,
): Promise<PublicationState["tag"]> {
  const raw = await optional(api, `/git/ref/tags/${encodeURIComponent(name)}`);

  if (raw === null) return null;

  const ref = proposalObject(raw);

  if (ref.ref !== `refs/tags/${name}`)
    return fail("incomplete-evidence", "GitHub returned a different publication tag.");

  let target = proposalObject(ref.object);
  const objectSha = proposalSha(target.sha);
  const seen = new Set<string>();

  while (target.type === "tag") {
    const current = proposalSha(target.sha);

    if (seen.has(current) || seen.size >= 10)
      return fail(
        "incomplete-evidence",
        "Publication tag annotations are cyclic or exceed ten levels.",
      );

    seen.add(current);

    const annotation = proposalObject((await api.request(`/git/tags/${current}`)).data);

    if (annotation.sha !== current)
      return fail("incomplete-evidence", "Tag annotation identity is inconsistent.");

    target = proposalObject(annotation.object);
  }

  if (target.type !== "commit" || proposalSha(target.sha) !== landingSha)
    return fail(
      "conflict",
      "The publication tag already points to another commit or object; never move it.",
    );

  return { objectSha, commitSha: landingSha };
}

export interface PublicationRequest {
  readonly repository: string;
  readonly configuration: ReleaseInputConfiguration;
  readonly approvalPolicy: ReleaseApprovalPolicy;
  readonly approval: ReleaseApproval;
  readonly publicationPolicy: PublicationPolicy;
  readonly receipt: PublicationReceipt;
  readonly token: string;
  readonly registryToken?: string;
}

export async function inspectReleasePublication(
  request: PublicationRequest,
  transport: GitHubRead = fetch,
): Promise<PublicationInspection> {
  const config = parseReleaseInputConfiguration(request.configuration);
  const approvalPolicy = parseReleaseApprovalPolicy(request.approvalPolicy);
  const approval = parseReleaseApproval(request.approval);
  const publicationPolicy = parsePublicationPolicy(request.publicationPolicy);
  const receipt = parsePublicationReceipt(request.receipt);
  const registryToken = request.registryToken;
  const repository = request.repository;
  const token = request.token;

  if (
    JSON.stringify(publicationPolicy.assets) !==
      JSON.stringify(receipt.assets.map((asset) => asset.name)) ||
    JSON.stringify(publicationPolicy.images) !==
      JSON.stringify(receipt.images.map((image) => image.name)) ||
    receipt.landingSha !== approval.landingSha
  )
    return fail(
      "invalid-input",
      "Trusted build receipt must cover every configured artifact at the exact approved landing.",
    );

  if (publicationPolicy.images.length && !registryToken?.trim())
    return fail(
      "invalid-input",
      "Configured images require a separate pull-scoped GHCR registry bearer token; GitHub credentials are not forwarded.",
    );

  const signal = AbortSignal.timeout(300_000);
  const deadline = Date.now() + 300_000;
  let requests = 0;
  const read: GitHubRead = async (url, options) => {
    if (++requests > 500 || Date.now() >= deadline)
      return fail("resource-limit", "Publication inspection exceeded 500 reads or five minutes.");

    return transport(url, {
      ...options,
      signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
    });
  };
  const verified = await verifyReleaseApproval(
    { repository, configuration: config, policy: approvalPolicy, approval, token },
    read,
  );

  if (receipt.approvalVerificationId !== verified.verificationId)
    return fail(
      "conflict",
      "The build receipt is not bound to the freshly verified approval identity.",
    );

  const notes = await publicationNotes(repository, config, approval);

  const tag = `v${verified.version}`;
  const api = new GitHubProposalRepository(config, approvalPolicy.botUserId, token, read);
  const inspect = async (): Promise<PublicationState> => {
    const tagState = await publishedTag(api, tag, verified.landingSha);
    const raw = await optional(api, `/releases/tags/${encodeURIComponent(tag)}`);
    let release: PublicationState["release"] = null;

    if (raw !== null) {
      const item = proposalObject(raw);

      if (tagState === null)
        return fail(
          "conflict",
          "A Release exists without its expected tag; reconcile inconsistent remote state first.",
        );
      if (
        typeof item.id !== "number" ||
        !Number.isSafeInteger(item.id) ||
        item.id <= 0 ||
        item.tag_name !== tag ||
        item.name !== tag ||
        item.body !== notes ||
        typeof item.draft !== "boolean" ||
        item.prerelease !== false
      )
        return fail(
          "conflict",
          "Existing Release identity, notes or stable-release state differs from the approved outputs; do not overwrite it.",
        );

      const assets: { name: string; id: number }[] = [];

      for (let page = 1; page <= 10; page++) {
        const response = await api.request(`/releases/${item.id}/assets?per_page=100&page=${page}`);

        if (
          !Array.isArray(response.data) ||
          response.data.length > 100 ||
          (response.next && response.data.length !== 100)
        )
          return fail(
            "incomplete-evidence",
            "Release asset pagination is incomplete or inconsistent.",
          );

        for (const entry of response.data) {
          const asset = proposalObject(entry);
          const expected = receipt.assets.find((file) => file.name === asset.name);

          if (
            !expected ||
            assets.some(
              (previous) => previous.name === expected.name || previous.id === asset.id,
            ) ||
            typeof asset.id !== "number" ||
            !Number.isSafeInteger(asset.id) ||
            asset.id <= 0 ||
            asset.state !== "uploaded" ||
            asset.size !== expected.size ||
            asset.digest !== `sha256:${expected.sha256}`
          )
            return fail(
              "conflict",
              "An existing Release asset is unexpected, incomplete or has a different size/digest; reconcile rather than overwrite it.",
            );

          assets.push({ name: expected.name, id: asset.id });
        }

        if (!response.next) break;
        if (page === 10)
          return fail("resource-limit", "Release asset listing exceeds ten complete pages.");
      }

      release = {
        id: item.id,
        draft: item.draft,
        assetIds: assets.toSorted((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        ),
      };
    }

    const images: { name: string; digest: string | null }[] = [];

    for (const image of receipt.images) {
      if (!registryToken)
        return fail("invalid-input", "A registry bearer token is required for image inspection.");

      images.push({
        name: image.name,
        digest: await registryImage(image.name, tag, image.digest, registryToken, read, signal),
      });
    }

    return { tag: tagState, release, images };
  };
  const state = await inspect();
  const repeated = await inspect();

  if (JSON.stringify(state) !== JSON.stringify(repeated))
    return fail(
      "conflict",
      "Publication state changed during inspection; reconcile again before any mutation.",
    );

  const fresh = await verifyReleaseApproval(
    { repository, configuration: config, policy: approvalPolicy, approval, token },
    read,
  );

  if (fresh.verificationId !== verified.verificationId)
    return fail(
      "conflict",
      "Approval changed during publication inspection; obtain fresh evidence.",
    );

  const actions = planPublicationActions(state, receipt, {
    tag,
    landingSha: verified.landingSha,
    notes,
  });

  const result = {
    schemaVersion: 1 as const,
    mode: "read-only" as const,
    repository: config.repository,
    landingSha: verified.landingSha,
    version: verified.version,
    tag,
    approvalVerificationId: verified.verificationId,
    publicationPolicyId: digest(JSON.stringify(publicationPolicy)),
    receiptId: digest(JSON.stringify(receipt)),
    state,
    actions,
    complete: actions.length === 0,
  };

  return { ...result, inspectionId: digest(JSON.stringify(result)) };
}
