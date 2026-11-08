import { readFile, stat } from "node:fs/promises";

import {
  checkGitHubPullRequest,
  pullRequestFromEvent,
  PullRequestCheckError,
} from "../src/github-pr-readiness.ts";

try {
  if (
    process.env.GITHUB_EVENT_NAME !== "pull_request_target" ||
    process.env.GITHUB_API_URL !== "https://api.github.com"
  ) {
    throw new PullRequestCheckError(
      "Run this metadata-only check from a trusted pull_request_target workflow on GitHub.com.",
    );
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) {
    throw new PullRequestCheckError(
      "Set GITHUB_EVENT_PATH, GITHUB_REPOSITORY, and a read-only GITHUB_TOKEN.",
    );
  }
  if ((await stat(eventPath)).size > 4 * 1024 * 1024) {
    throw new PullRequestCheckError("The PR event exceeds the 4 MiB safety limit.");
  }

  let event: unknown;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    throw new PullRequestCheckError(
      "Could not read the PR event JSON; retry with the current GitHub event file.",
    );
  }

  const pull = pullRequestFromEvent(event, repository);
  const check = await checkGitHubPullRequest({ repository, ...pull, token });
  for (const issue of check.result.warnings) {
    console.log(JSON.stringify({ level: "warning", ...issue }));
  }
  if (!check.result.valid) {
    for (const issue of check.result.errors) {
      console.error(JSON.stringify({ level: "error", ...issue }));
    }
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ valid: true, number: check.number, headSha: check.headSha }));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      valid: false,
      message:
        error instanceof PullRequestCheckError
          ? error.message
          : "PR metadata validation failed unexpectedly; check trusted runner setup and retry.",
    }),
  );
  process.exitCode = 1;
}
