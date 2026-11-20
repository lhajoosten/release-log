import { proposalObject } from "../github-proposals.ts";
import { requestGitHubJson } from "../github.ts";
import type { GitHubRead } from "../github.ts";
import { fail, ReleasePublicationError } from "./error.ts";
import type { PublicationAction, PublicationInspection } from "./types.ts";

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

export async function writeGitHubPublicationAction({
  action,
  inspection,
  assets,
  repository,
  token,
  notes,
  transport,
  signal,
}: {
  readonly action: PublicationAction;
  readonly inspection: PublicationInspection;
  readonly assets: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  readonly repository: string;
  readonly token: string;
  readonly notes: string;
  readonly transport: GitHubRead;
  readonly signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const apiURL = `https://api.github.com/repos/${repository}`;
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
          `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(action.name)}`,
          token,
          bytes,
          transport,
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
            token,
            {
              method: action.kind === "publish-release" ? "PATCH" : "POST",
              body,
            },
            transport,
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

  return response;
}
