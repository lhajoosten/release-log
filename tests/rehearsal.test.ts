import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { parseEvidence, verifyEvidence } from "../scripts/verify-rehearsal.ts";

const candidate = "a".repeat(40),
  previous = "b".repeat(40),
  landing = "c".repeat(40),
  imageDigest = "sha256:" + "d".repeat(64),
  repo = "acme/test";
const evidence = {
  repository: repo,
  candidate,
  previous,
  releasePr: 1,
  oldPr: 2,
  newPr: 3,
  afterPr: 5,
  newTriggerPr: 4,
  newHead: "3".repeat(40),
  landing,
  version: "v1.2.3",
  imageDigest,
  runs: {
    publication: 11,
    retry: 12,
    oldReplay: 13,
    newProposal: 14,
    pinPreview: 17,
    freshCheck: 15,
    alteredCheck: 16,
  },
  observed: {
    interruptedDigest: imageDigest,
    retriedDigest: imageDigest,
    releaseBeforeRetry: "absent",
    releaseAfterRetry: "present",
    failedPromotionBefore: previous,
    failedPromotionAfter: previous,
    rollbackTarget: previous,
    oldProposalReplay: "passed",
    newProducer: candidate,
    rollbackWithOpenProposal: "passed",
  },
};
const ref = (id: number) => String(id).repeat(40);
const contents = (producer: string) => ({
  encoding: "base64",
  content: Buffer.from(
    JSON.stringify({
      producer,
      repository: repo,
      branch: "main",
      version: "1.2.3",
      source: landing,
    }),
  ).toString("base64"),
});
const pull = (id: number) => ({
  number: id,
  merged: true,
  merge_commit_sha: landing,
  body: "notes",
  base: { ref: "main", repo: { full_name: repo } },
  head: { ref: "release/next", sha: ref(id), repo: { full_name: repo } },
  user: { type: "Bot" },
});
const records = new Map<string, unknown>([
  ["pulls/1", pull(1)],
  ["pulls/2", pull(2)],
  ["pulls/3", pull(3)],
  ["pulls/4", pull(4)],
  ["pulls/5", { ...pull(5), merge_commit_sha: "e".repeat(40) }],
  [`compare/${landing}...${"e".repeat(40)}`, { status: "ahead" }],
  ["pulls/3/commits?per_page=100", [{ sha: ref(3) }]],
  [`contents/.rolling-release/review.json?ref=${ref(1)}`, contents(candidate)],
  [`contents/.rolling-release/review.json?ref=${ref(2)}`, contents(previous)],
  [`contents/.rolling-release/review.json?ref=${ref(3)}`, contents(candidate)],
  ["git/ref/tags/v1.2.3", { object: { type: "commit", sha: landing } }],
  [
    "releases/tags/v1.2.3",
    { tag_name: "v1.2.3", name: "v1.2.3", body: "notes", draft: false, prerelease: false },
  ],
  ...(
    [
      [11, "failure", 1, "pull_request_target", "release / publish / publish"],
      [12, "success", 1, "workflow_dispatch", "release / publish / publish"],
      [13, "success", 2, "pull_request_target", "release / publish / publish"],
      [14, "success", 4, "pull_request_target", "release / propose / propose"],
      [15, "success", 3, "pull_request", "proposal-check / proposal"],
      [16, "failure", 3, "pull_request", "proposal-check / proposal"],
    ] as const
  ).flatMap(([id, conclusion, pr, event, name]) => [
    [
      `actions/runs/${id}`,
      {
        id,
        status: "completed",
        conclusion,
        event,
        head_sha: event === "workflow_dispatch" ? "e".repeat(40) : ref(pr),
        head_branch: event === "workflow_dispatch" ? "main" : "release/next",
        display_title: `release:${pr}`,
        path: ".github/workflows/rolling-release.yaml",
        pull_requests: [],
        referenced_workflows: [
          {
            sha: candidate,
            path: `lhajoosten/rolling-release/.github/workflows/${event === "pull_request" ? "release-quality" : "release-cycle"}.yaml@consumer-rehearsal-v1`,
          },
        ],
      },
    ] as const,
    [
      `actions/runs/${id}/jobs?per_page=100`,
      { total_count: 1, jobs: [{ name, conclusion }] },
    ] as const,
  ]),
]);
const caller = (
  await readFile(new URL("../examples/release-cycle.yaml", import.meta.url), "utf8")
).replaceAll("@consumer-v1", "@consumer-rehearsal-v1");
records.set(`contents/.github/workflows/rolling-release.yaml?ref=${landing}`, {
  encoding: "base64",
  content: Buffer.from(caller).toString("base64"),
});
const pinHead = "f".repeat(40);
records.set("actions/runs/17", {
  id: 17,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: pinHead,
  display_title: "release:preview",
  referenced_workflows: [
    {
      sha: candidate,
      path: `lhajoosten/rolling-release/.github/workflows/release-cycle.yaml@${candidate}`,
    },
  ],
});
records.set("actions/runs/17/jobs?per_page=100", {
  total_count: 1,
  jobs: [{ name: "release / propose / propose", conclusion: "success" }],
});
records.set(`contents/.github/workflows/rolling-release.yaml?ref=${pinHead}`, {
  encoding: "base64",
  content: Buffer.from(
    (await readFile(new URL("../examples/release-cycle.yaml", import.meta.url), "utf8")).replaceAll(
      "@consumer-v1",
      `@${candidate}`,
    ),
  ).toString("base64"),
});
records.set(`contents/.github/workflows/rolling-release.yaml?ref=${"e".repeat(40)}`, {
  encoding: "base64",
  content: Buffer.from(caller).toString("base64"),
});
const get = async (path: string) => records.get(path);
void test("valid rehearsal evidence is bound to GitHub state and registry digest", async () => {
  await verifyEvidence(evidence, repo, candidate, get, imageDigest);
  await assert.rejects(
    verifyEvidence(evidence, repo, candidate, get, "sha256:" + "e".repeat(64)),
    /digest/u,
  );
  await assert.rejects(
    verifyEvidence({ ...evidence, landing: "e".repeat(40) }, repo, candidate, get, imageDigest),
    /landing/u,
  );
  await assert.rejects(verifyEvidence(evidence, repo, previous, get, imageDigest), /identity/u);
  await assert.rejects(
    verifyEvidence(
      evidence,
      repo,
      candidate,
      async (path) =>
        path.startsWith("contents/.github/workflows/")
          ? { encoding: "base64", content: Buffer.from("altered caller").toString("base64") }
          : get(path),
      imageDigest,
    ),
    /caller/u,
  );
  await assert.rejects(
    verifyEvidence(
      evidence,
      repo,
      candidate,
      async (path) =>
        path === "actions/runs/12"
          ? {
              id: 12,
              status: "completed",
              conclusion: "success",
              pull_requests: [],
              referenced_workflows: [],
            }
          : get(path),
      imageDigest,
    ),
    /run identity/u,
  );
});
void test("incomplete or conflicting historical observations cannot satisfy the full gate", () => {
  assert.throws(
    () =>
      parseEvidence(
        {
          ...evidence,
          observed: { ...evidence.observed, retriedDigest: "sha256:" + "e".repeat(64) },
        },
        repo,
        candidate,
      ),
    /observations/u,
  );
  assert.throws(
    () => parseEvidence({ ...evidence, runs: { ...evidence.runs, retry: 11 } }, repo, candidate),
    /distinct/u,
  );
});
