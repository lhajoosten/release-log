export type GitHubRead = (url: string, options: RequestInit) => Promise<Response>;

export class GitHubReadError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

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

export function readGitHubJson(
  url: string,
  token: string,
  read: GitHubRead = fetch,
  signal?: AbortSignal,
): Promise<{ data: unknown; next: boolean }> {
  return requestGitHubJson(url, token, { method: "GET" }, read, signal);
}

export async function requestGitHubJson(
  url: string,
  token: string,
  request: { readonly method: "GET" | "POST" | "PATCH"; readonly body?: unknown },
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
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined && Buffer.byteLength(body, "utf8") > 16 * 1024 * 1024)
    throw new GitHubReadError("GitHub request exceeds the 16 MiB safety limit.");
  let response: Response;
  try {
    response = await read(url, {
      method: request.method,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/vnd.github+json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "release-log-pr-readiness",
      },
    });
  } catch {
    throw new GitHubReadError(
      request.method === "GET"
        ? "GitHub read failed or timed out. Check connectivity and retry; redirects are not followed."
        : "GitHub write failed or timed out; reconcile remote branch/PR state before retrying. Redirects are not followed.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([403, 429].includes(response.status)) {
      throw new GitHubReadError(
        `GitHub ${request.method === "GET" ? "read" : "write"} rejected (HTTP ${response.status}). Check ${request.method === "GET" ? "read" : "write"} permissions or rate limits and retry after the limit resets.`,
        response.status,
      );
    }
    throw new GitHubReadError(
      request.method === "GET"
        ? `GitHub read failed (HTTP ${response.status}). Check repository/PR read access and retry; no metadata was accepted.`
        : `GitHub write failed (HTTP ${response.status}); reconcile remote branch/PR state before retrying.`,
      response.status,
    );
  }
  let data: unknown;
  try {
    data = await readJson(response);
  } catch (error) {
    if (request.method === "GET") throw error;
    throw new GitHubReadError(
      "GitHub write returned incomplete or invalid evidence; reconcile remote branch/PR state before retrying.",
      response.status,
      { cause: error },
    );
  }
  return { data, next: /rel="next"/u.test(response.headers.get("link") ?? "") };
}
