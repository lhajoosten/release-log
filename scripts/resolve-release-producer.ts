import { releaseEventNumber } from "../src/controller/event.ts";
import { githubCommitSignature, verifiedAppCommit } from "../src/controller/commit-verification.ts";
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fullSha = /^[a-f0-9]{40}$/u;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid GitHub evidence.");
  return Object.fromEntries(Object.entries(value));
}

/** Both the workflow revision and selected producer must be protected-provider ancestors. */
export async function selectProducer(repository: string, workflow: string, producer: unknown) {
  if (!fullSha.test(workflow) || typeof producer !== "string" || !fullSha.test(producer))
    throw new Error("The reviewed producer and executing workflow must be full commit SHAs.");
  const git = async (...args: string[]) => execute("git", ["-C", repository, ...args]);
  try {
    const checkedOut = (await git("rev-parse", "HEAD")).stdout.trim();
    if (checkedOut !== workflow) throw new Error("Workflow checkout mismatch.");
    await git("merge-base", "--is-ancestor", workflow, "refs/remotes/origin/main");
    await git("merge-base", "--is-ancestor", producer, workflow);
  } catch {
    throw new Error(
      "The reviewed producer is unavailable or outside protected provider history; restore it and rerun the original event.",
    );
  }
  return producer;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const bot = process.env.ROLLING_RELEASE_BOT ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const workflow = process.env.RELEASE_WORKFLOW_SHA ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) || !bot || !token)
    throw new Error("Repository, bot and read token are required.");
  const event = object(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")));
  const number = process.env.ROLLING_RELEASE_RETRY_PR
    ? releaseEventNumber(event)
    : object(event.pull_request).number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("Expected a pull request event.");
  async function get(path: string) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub evidence read failed (${response.status}).`);
    return object(await response.json());
  }
  const pull = await get(`pulls/${number}`);
  const head = object(pull.head);
  const base = object(pull.base);
  const author = object(pull.user);
  const headSha = head.sha;
  if (
    pull.number !== number ||
    (process.env.ROLLING_RELEASE_RETRY_PR && (pull.merged !== true || pull.state !== "closed")) ||
    author.login !== bot ||
    author.type !== "Bot" ||
    head.ref !== "release/next" ||
    object(head.repo).full_name !== repo ||
    base.ref !== "main" ||
    object(base.repo).full_name !== repo ||
    typeof headSha !== "string" ||
    !fullSha.test(headSha)
  )
    throw new Error("Expected a bot-owned release proposal in this repository.");
  const commit = await get(`commits/${headSha}`);
  if (
    !(await verifiedAppCommit(
      commit,
      headSha,
      bot,
      () => githubCommitSignature(repo, headSha, token),
      repo,
    ))
  )
    throw new Error("The proposal head lacks verified bot ownership.");
  const file = await get(`contents/.rolling-release/review.json?ref=${headSha}`);
  if (
    file.encoding !== "base64" ||
    typeof file.content !== "string" ||
    file.content.length > 200000
  )
    throw new Error("The reviewed producer record is unavailable or invalid.");
  const review = object(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
  const producer = await selectProducer(
    process.env.RELEASE_PROVIDER_PATH ?? "tool",
    workflow,
    review.producer,
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output destination.");
  const landing =
    typeof pull.merge_commit_sha === "string" && fullSha.test(pull.merge_commit_sha)
      ? pull.merge_commit_sha
      : "";
  if (process.env.ROLLING_RELEASE_RETRY_PR && !landing) throw new Error("Missing release landing.");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `sha=${producer}\nhead=${headSha}\nlanding=${landing}\n`,
  );
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Producer selection failed.");
    process.exitCode = 1;
  });
