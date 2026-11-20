import { createHash } from "node:crypto";
import type { GitHubRead } from "../github.ts";
import { fail, ReleasePublicationError } from "./error.ts";

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

export async function registryImage(
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
