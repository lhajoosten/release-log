import { setTimeout } from "node:timers/promises";
import type { GitHubRead } from "./github.ts";

export function retryGitHubReads(read: GitHubRead = fetch): GitHubRead {
  return async (url, options) => {
    if (options.method !== "GET") return read(url, options);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await read(url, options);
        if (![500, 502, 503, 504].includes(response.status)) return response;
        await response.body?.cancel();
      } catch (error) {
        if (options.signal?.aborted) throw error;
      }
      await setTimeout(250 * (attempt + 1), undefined, { signal: options.signal ?? undefined });
    }
    return read(url, options);
  };
}
