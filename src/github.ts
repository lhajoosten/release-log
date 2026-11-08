export type GitHubRead = (url: string, options: RequestInit) => Promise<Response>;

export class GitHubReadError extends Error {}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new GitHubReadError("GitHub returned an empty response; retry the metadata check.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new GitHubReadError(
          "GitHub metadata response exceeds the 4 MiB safety limit; reduce PR metadata and retry.",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GitHubReadError) throw error;
    throw new GitHubReadError(
      "GitHub response was interrupted or timed out; retry the metadata check.",
    );
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GitHubReadError("GitHub returned malformed JSON; retry the metadata check.");
  }
}

export async function readGitHubJson(
  url: string,
  token: string,
  read: GitHubRead = fetch,
  signal?: AbortSignal,
): Promise<{ data: unknown; next: boolean }> {
  const target = new URL(url);
  if (
    target.origin !== "https://api.github.com" ||
    !target.pathname.startsWith("/repos/") ||
    target.username ||
    target.password
  ) {
    throw new GitHubReadError("GitHub reads require a GitHub.com repository API URL.");
  }
  let response: Response;
  try {
    response = await read(url, {
      method: "GET",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "release-log-pr-readiness",
      },
    });
  } catch {
    throw new GitHubReadError(
      "GitHub read failed or timed out. Check connectivity and retry; redirects are not followed.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([403, 429].includes(response.status)) {
      throw new GitHubReadError(
        `GitHub read rejected (HTTP ${response.status}). Check read permissions or rate limits and retry after the limit resets.`,
      );
    }
    throw new GitHubReadError(
      `GitHub read failed (HTTP ${response.status}). Check repository/PR read access and retry; no metadata was accepted.`,
    );
  }
  return {
    data: await readJson(response),
    next: /rel="next"/u.test(response.headers.get("link") ?? ""),
  };
}
