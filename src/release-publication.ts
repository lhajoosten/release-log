import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { renderChangelog } from "./changelog.ts";
import { inspectGitTree, readGitBlob } from "./git.ts";
import { GitHubProposalRepository, proposalObject, proposalSha } from "./github-proposals.ts";
import { GitHubReadError, requestGitHubJson } from "./github.ts";
import type { GitHubRead } from "./github.ts";
import {
  parseReleaseApproval,
  parseReleaseApprovalPolicy,
  verifyReleaseApproval,
} from "./release-approval.ts";
import type { ReleaseApproval, ReleaseApprovalPolicy } from "./release-approval.ts";
import { parseReleaseInputConfiguration } from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";

export class ReleasePublicationError extends Error {
  readonly code:
    | "invalid-input"
    | "conflict"
    | "incomplete-evidence"
    | "resource-limit"
    | "read-failed"
    | "write-failed";

  constructor(code: ReleasePublicationError["code"], message: string) {
    super(message);
    this.name = "ReleasePublicationError";
    this.code = code;
  }
}

export interface PublicationPolicy {
  readonly schemaVersion: 1;
  readonly assets: readonly string[];
  readonly images: readonly string[];
}

export interface PublicationReceipt {
  readonly schemaVersion: 1;
  readonly approvalVerificationId: string;
  readonly landingSha: string;
  readonly assets: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly images: readonly { readonly name: string; readonly digest: string }[];
}

export type PublicationAction =
  | { readonly kind: "create-tag"; readonly tag: string; readonly commitSha: string }
  | { readonly kind: "create-draft-release"; readonly tag: string; readonly notesSha256: string }
  | {
      readonly kind: "upload-asset";
      readonly name: string;
      readonly sha256: string;
      readonly size: number;
    }
  | {
      readonly kind: "publish-image";
      readonly name: string;
      readonly tag: string;
      readonly digest: string;
    }
  | { readonly kind: "publish-release"; readonly releaseId: number | null };

interface PublicationState {
  readonly tag: { readonly objectSha: string; readonly commitSha: string } | null;
  readonly release: {
    readonly id: number;
    readonly draft: boolean;
    readonly assetIds: readonly { readonly name: string; readonly id: number }[];
  } | null;
  readonly images: readonly { readonly name: string; readonly digest: string | null }[];
}

export interface PublicationInspection {
  readonly schemaVersion: 1;
  readonly mode: "read-only";
  readonly repository: string;
  readonly landingSha: string;
  readonly version: string;
  readonly tag: string;
  readonly approvalVerificationId: string;
  readonly publicationPolicyId: string;
  readonly receiptId: string;
  readonly state: PublicationState;
  readonly actions: readonly PublicationAction[];
  readonly complete: boolean;
  readonly inspectionId: string;
}

function fail(code: ReleasePublicationError["code"], message: string): never {
  throw new ReleasePublicationError(code, message);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return fail(
      "invalid-input",
      "Publication policy/receipt must contain exactly their supported schema fields.",
    );

  return Object.fromEntries(Object.entries(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    return fail(
      "invalid-input",
      "Publication receipts require complete lowercase SHA-256 digests.",
    );

  return value;
}

function assetName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value))
    return fail(
      "invalid-input",
      "Release asset names must be explicit bounded filenames without paths.",
    );

  return value;
}

function imageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/u.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    return fail(
      "invalid-input",
      "Publication image destinations require explicit lowercase ghcr.io owner/repository names.",
    );

  return value;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 100)
    return fail(
      "invalid-input",
      "Publication artifacts must be bounded arrays of at most 100 entries.",
    );

  return value;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    fail("invalid-input", "Publication policy/receipt has duplicate artifact names.");
}

export function parsePublicationPolicy(value: unknown): PublicationPolicy {
  const item = record(value, ["schemaVersion", "assets", "images"]);
  const assets = list(item.assets).map(assetName).toSorted();
  const images = list(item.images).map(imageName).toSorted();

  if (
    item.schemaVersion !== 1 ||
    assets.length + images.length === 0 ||
    assets.length + images.length > 100
  )
    return fail(
      "invalid-input",
      "Publication policy requires schema 1 and 1–100 explicitly configured artifacts.",
    );

  unique(assets);
  unique(images);

  return { schemaVersion: 1, assets, images };
}

export function parsePublicationReceipt(value: unknown): PublicationReceipt {
  const item = record(value, [
    "schemaVersion",
    "approvalVerificationId",
    "landingSha",
    "assets",
    "images",
  ]);

  if (item.schemaVersion !== 1)
    return fail("invalid-input", "Unsupported publication receipt schema.");

  const assets = list(item.assets)
    .map((entry) => {
      const file = record(entry, ["name", "sha256", "size"]);

      if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size <= 0)
        return fail("invalid-input", "Publication asset sizes must be positive safe integers.");

      return { name: assetName(file.name), sha256: sha256(file.sha256), size: file.size };
    })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const images = list(item.images)
    .map((entry) => {
      const image = record(entry, ["name", "digest"]);

      if (typeof image.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image.digest))
        return fail(
          "invalid-input",
          "Publication image receipts require immutable sha256 digests.",
        );

      return { name: imageName(image.name), digest: image.digest };
    })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  if (assets.length + images.length === 0 || assets.length + images.length > 100)
    return fail("invalid-input", "Publication receipts require 1–100 artifacts.");

  unique(assets.map((file) => file.name));
  unique(images.map((image) => image.name));

  return {
    schemaVersion: 1,
    approvalVerificationId: sha256(item.approvalVerificationId),
    landingSha: proposalSha(item.landingSha),
    assets,
    images,
  };
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

function manifestDescriptor(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const item = Object.fromEntries(Object.entries(value));

  return (
    typeof item.mediaType === "string" &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(item.mediaType) &&
    typeof item.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(item.digest) &&
    typeof item.size === "number" &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0
  );
}

function validManifest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const item = Object.fromEntries(Object.entries(value));

  if (item.schemaVersion !== 2) return false;

  if (
    item.mediaType === "application/vnd.oci.image.index.v1+json" ||
    item.mediaType === "application/vnd.docker.distribution.manifest.list.v2+json"
  )
    return (
      Array.isArray(item.manifests) &&
      item.manifests.length > 0 &&
      item.manifests.length <= 1000 &&
      item.manifests.every(manifestDescriptor)
    );

  return (
    (item.mediaType === "application/vnd.oci.image.manifest.v1+json" ||
      item.mediaType === "application/vnd.docker.distribution.manifest.v2+json") &&
    manifestDescriptor(item.config) &&
    Array.isArray(item.layers) &&
    item.layers.length <= 1000 &&
    item.layers.every(manifestDescriptor)
  );
}

async function registryImage(
  name: string,
  tag: string,
  expected: string,
  token: string,
  read: GitHubRead,
  signal: AbortSignal,
): Promise<string | null> {
  let response: Response;

  try {
    response = await read(`https://ghcr.io/v2/${name.slice("ghcr.io/".length)}/manifests/${tag}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
  } catch {
    return fail(
      "read-failed",
      "GHCR manifest read failed or timed out; redirects are not followed.",
    );
  }

  if (response.status !== 200) {
    await response.body?.cancel();

    if (response.status === 404) return null;

    return fail(
      "read-failed",
      `GHCR manifest read rejected (HTTP ${response.status}); verify the separately supplied pull-scoped registry token.`,
    );
  }

  if (!response.body) return fail("incomplete-evidence", "GHCR returned no manifest body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;

      size += part.value.byteLength;

      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        return fail("resource-limit", "GHCR manifest exceeds the 4 MiB read limit.");
      }

      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ReleasePublicationError) throw error;
    return fail(
      "read-failed",
      "GHCR manifest response was interrupted; no publication evidence was accepted.",
    );
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const declared = response.headers.get("docker-content-digest");
  let manifest: unknown;

  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("incomplete-evidence", "GHCR returned malformed manifest JSON.");
  }

  if (!validManifest(manifest) || (declared !== null && declared !== actual))
    return fail(
      "incomplete-evidence",
      "GHCR returned unsupported or inconsistent manifest metadata.",
    );

  if (actual !== expected)
    return fail("conflict", "The versioned image tag has a different digest; do not overwrite it.");

  return actual;
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

async function publicationNotes(
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

  const actions: PublicationAction[] = [];

  if (state.tag === null) actions.push({ kind: "create-tag", tag, commitSha: verified.landingSha });
  if (state.release === null)
    actions.push({ kind: "create-draft-release", tag, notesSha256: digest(notes) });

  for (const asset of receipt.assets)
    if (!state.release?.assetIds.some((existing) => existing.name === asset.name))
      actions.push({ kind: "upload-asset", ...asset });

  for (const image of receipt.images)
    if (state.images.find((existing) => existing.name === image.name)?.digest === null)
      actions.push({ kind: "publish-image", ...image, tag });

  if (state.release === null || state.release.draft)
    actions.push({ kind: "publish-release", releaseId: state.release?.id ?? null });

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

async function publicationAssets(
  directory: string,
  receipt: PublicationReceipt,
): Promise<ReadonlyMap<string, Uint8Array<ArrayBuffer>>> {
  if (
    receipt.assets.some((asset) => asset.size > 64 * 1024 * 1024) ||
    receipt.assets.reduce((total, asset) => total + asset.size, 0) > 128 * 1024 * 1024
  )
    return fail("resource-limit", "Publication assets exceed 64 MiB per file or 128 MiB total.");

  const assets = new Map<string, Uint8Array<ArrayBuffer>>();

  try {
    const root = resolve(directory);

    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
      return fail(
        "invalid-input",
        "Publication assets require an ordinary directory without symlink parents.",
      );

    for (const asset of receipt.assets) {
      const path = join(root, asset.name);

      if (!(await lstat(path)).isFile())
        return fail(
          "invalid-input",
          "Publication assets must be ordinary files, not links or special files.",
        );

      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      try {
        const before = await handle.stat();

        if (!before.isFile() || before.size !== asset.size)
          return fail(
            "conflict",
            "Local publication asset size differs from its trusted build receipt.",
          );

        // Keep the exact verified bytes in memory; never reopen a path for upload.
        const bytes = new Uint8Array(asset.size + 1);
        let offset = 0;

        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);

          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }

        const after = await handle.stat();
        const payload = bytes.subarray(0, asset.size);

        if (
          offset !== asset.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          createHash("sha256").update(payload).digest("hex") !== asset.sha256
        )
          return fail(
            "conflict",
            "Local publication asset changed or differs from its trusted build digest.",
          );

        assets.set(asset.name, payload);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error instanceof ReleasePublicationError) throw error;
    return fail(
      "invalid-input",
      "Cannot read ordinary publication assets; verify the directory and file permissions.",
    );
  }

  return assets;
}

async function uploadPublicationAsset(
  url: string,
  token: string,
  bytes: Uint8Array<ArrayBuffer>,
  transport: GitHubRead,
): Promise<unknown> {
  try {
    const response = await transport(url, {
      method: "POST",
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "release-log-publication",
      },
    });

    if (response.status !== 201 || !response.body) {
      await response.body?.cancel();
      return fail(
        "write-failed",
        `Release asset upload rejected or uncertain (HTTP ${response.status}); inspect remote state before retrying, and check contents write permissions or rate limits.`,
      );
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      for (;;) {
        const part = await reader.read();

        if (part.done) break;
        size += part.value.byteLength;

        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          return fail(
            "write-failed",
            "Release asset upload returned oversized evidence; inspect remote state before retrying.",
          );
        }

        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }

    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ReleasePublicationError) throw error;
    return fail(
      "write-failed",
      "Release asset upload failed, timed out or returned incomplete evidence; inspect remote state before retrying. Redirects are not followed.",
    );
  }
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

  const apiURL = `https://api.github.com/repos/${input.configuration.repository}`;

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

    let response: Record<string, unknown>;

    try {
      if (action.kind === "upload-asset") {
        const release = inspection.state.release;
        const bytes = assets.get(action.name);

        if (!release || !bytes)
          return fail(
            "incomplete-evidence",
            "Release asset upload lacks verified release identity or local bytes.",
          );

        // Never use an upload_url supplied by a remote Release response.
        response = proposalObject(
          await uploadPublicationAsset(
            `https://uploads.github.com/repos/${input.configuration.repository}/releases/${release.id}/assets?name=${encodeURIComponent(action.name)}`,
            input.token,
            bytes,
            bounded,
          ),
        );

        if (
          typeof response.id !== "number" ||
          !Number.isSafeInteger(response.id) ||
          response.id <= 0 ||
          response.name !== action.name ||
          response.size !== action.size ||
          response.state !== "uploaded" ||
          response.digest !== `sha256:${action.sha256}`
        )
          return fail(
            "write-failed",
            "Release asset upload returned inconsistent identity/bytes; inspect remote state before retrying.",
          );
      } else {
        const path =
          action.kind === "create-tag"
            ? "/git/refs"
            : action.kind === "create-draft-release"
              ? "/releases"
              : action.kind === "publish-release" && action.releaseId !== null
                ? `/releases/${action.releaseId}`
                : null;

        if (path === null)
          return fail("incomplete-evidence", "Publication has no supported GitHub write target.");

        const body =
          action.kind === "create-tag"
            ? { ref: `refs/tags/${action.tag}`, sha: action.commitSha }
            : action.kind === "create-draft-release"
              ? {
                  tag_name: inspection.tag,
                  target_commitish: inspection.landingSha,
                  name: inspection.tag,
                  body: notes,
                  draft: true,
                  prerelease: false,
                  generate_release_notes: false,
                  make_latest: "false",
                }
              : { draft: false, make_latest: "false" };

        response = proposalObject(
          (
            await requestGitHubJson(
              apiURL + path,
              input.token,
              {
                method: action.kind === "publish-release" ? "PATCH" : "POST",
                body,
              },
              bounded,
              signal,
            )
          ).data,
        );

        if (action.kind === "create-tag") {
          const target = proposalObject(response.object);

          if (
            response.ref !== `refs/tags/${action.tag}` ||
            target.type !== "commit" ||
            target.sha !== action.commitSha
          )
            return fail(
              "write-failed",
              "Tag creation returned unexpected identity; inspect remote state before retrying.",
            );
        } else if (
          typeof response.id !== "number" ||
          !Number.isSafeInteger(response.id) ||
          response.id <= 0 ||
          response.tag_name !== inspection.tag ||
          response.name !== inspection.tag ||
          response.body !== notes ||
          response.prerelease !== false ||
          response.draft !== (action.kind === "create-draft-release") ||
          (action.kind === "publish-release" && response.id !== action.releaseId)
        )
          return fail(
            "write-failed",
            "Release write returned inconsistent identity/notes/state; inspect remote state before retrying.",
          );
      }
    } catch (error) {
      if (error instanceof ReleasePublicationError) throw error;
      return fail(
        "write-failed",
        "GitHub publication write failed, was rejected or has an uncertain outcome; inspect remote state before retrying. Check contents write permissions/rate limits; redirects are not followed.",
      );
    }

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
