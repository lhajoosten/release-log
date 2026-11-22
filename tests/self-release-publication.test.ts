import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateLandingPin } from "../src/config/repository.ts";
import { publishInternalCandidate } from "../scripts/self-release-publication.ts";
import type { PublicationOperations, ReleaseImage } from "../scripts/self-release-publication.ts";
import { waitForMainPushQuality } from "../src/tool-upgrade.ts";
import type { PublicationClaim } from "../scripts/self-release-state.ts";

const candidate: CandidateLandingPin = {
  pullNumber: 125,
  botUserId: 4,
  landingSha: "a".repeat(40),
  headSha: "b".repeat(40),
  changelogDigest: "c".repeat(64),
  proposalId: "d".repeat(64),
  version: "0.5.3",
};
const image = { digest: `sha256:${"e".repeat(64)}`, configDigest: `sha256:${"f".repeat(64)}` };

function harness() {
  let current: ReleaseImage | null = null;
  let claim: PublicationClaim | null = null;
  let tag = false;
  let release = false;
  let latest = false;
  const writes: string[] = [];
  const checks: string[] = [];
  const options = {
    blocked: false,
    failAfter: "",
    superseded: false,
    quality: "success",
    qualitySha: candidate.landingSha,
  };
  const qualityChecks: string[] = [];
  function record(action: string) {
    writes.push(action);
    if (options.failAfter === action) throw new Error(`Interrupted after ${action}`);
  }
  const operations: PublicationOperations = {
    readImage: async () => current,
    checkQuality: (sha) =>
      waitForMainPushQuality(
        {
          request: async (path) => {
            qualityChecks.push(path);
            const runs =
              options.quality === "missing"
                ? []
                : [
                    {
                      run_number: 1,
                      head_sha: options.qualitySha,
                      head_branch: "main",
                      event: "push",
                      path: ".github/workflows/quality.yml",
                      repository: { id: 1449550207 },
                      status: options.quality === "in_progress" ? "in_progress" : "completed",
                      conclusion: options.quality === "in_progress" ? null : options.quality,
                    },
                  ];
            return { next: false, data: { total_count: runs.length, workflow_runs: runs } };
          },
        },
        sha,
      ),
    stage: async () => {
      checks.push("build and scan exact landing");
      if (options.blocked) throw new Error("Vulnerability gate failed");
    },
    publishImage: async (beforePush) => {
      if (current) {
        checks.push("pull and freshly scan retained digest");
        if (options.blocked) throw new Error("Vulnerability gate failed");
        return current;
      }
      await beforePush(image.configDigest);
      current = image;
      record("image");
      return current;
    },
    claim: async (next) => {
      claim = next;
      record(next.complete ? "complete" : next.manifestDigest ? "manifest" : "claim");
    },
    checkActive: async () => {
      if (options.superseded && !current) throw new Error("Stale reviewed candidate");
    },
    checkGitHub: async () => tag && release,
    publishGitHub: async (beforeWrite) => {
      assert.equal(current, image);
      if (!tag) {
        await beforeWrite();
        tag = true;
        record("tag");
      }
      if (!release) {
        await beforeWrite();
        release = true;
        record("release");
      }
    },
    repairAliases: async (retained) => {
      assert.equal(current, retained);
      assert.equal(tag && release && claim?.complete, true);
      if (!latest) {
        latest = true;
        record("aliases");
      }
    },
  };
  return {
    options,
    writes,
    checks,
    qualityChecks,
    run: () => publishInternalCandidate(candidate, claim, operations),
    setImage(value: ReleaseImage) {
      current = value;
    },
  };
}

void test("a blocked candidate remains internal and automatically publishes the image that passes a fresh gate", async () => {
  const h = harness();
  h.options.blocked = true;
  await assert.rejects(h.run(), /gate failed/u);
  assert.deepEqual(h.writes, []);
  h.options.blocked = false;
  assert.deepEqual(await h.run(), { outcome: "published", image });
  assert.deepEqual(h.writes, [
    "claim",
    "image",
    "manifest",
    "tag",
    "release",
    "complete",
    "aliases",
  ]);
  assert.deepEqual(await h.run(), { outcome: "unchanged", image });
  assert.equal(h.writes.length, 7);
  assert.equal(h.checks.length, 2);
});

void test("first public writes require successful Quality on the exact landing", async () => {
  const h = harness();
  h.options.quality = "missing";
  assert.deepEqual(await h.run(), { outcome: "quality-pending" });
  h.options.quality = "in_progress";
  assert.deepEqual(await h.run(), { outcome: "quality-pending" });
  h.options.quality = "failure";
  assert.deepEqual(await h.run(), { outcome: "quality-failed" });

  h.options.quality = "success";
  h.options.qualitySha = candidate.headSha;
  await assert.rejects(h.run(), /Quality run provenance/u);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.checks, []);

  h.options.qualitySha = candidate.landingSha;
  assert.deepEqual(await h.run(), { outcome: "published", image });
  assert.deepEqual(h.writes, [
    "claim",
    "image",
    "manifest",
    "tag",
    "release",
    "complete",
    "aliases",
  ]);
  assert.ok(
    h.qualityChecks.every((path) =>
      path.split("?")[1]?.includes("head_sha=" + candidate.landingSha),
    ),
  );
});

void test("an interrupted publication resumes from the verified image and journal", async () => {
  const h = harness();
  h.options.failAfter = "image";
  await assert.rejects(h.run(), /Interrupted/u);
  h.options.failAfter = "";
  h.options.quality = "failure";
  assert.deepEqual(await h.run(), { outcome: "published", image });
  assert.equal(h.qualityChecks.length, 1);
});

for (const failure of ["claim", "image", "manifest", "tag", "release", "complete", "aliases"])
  void test(`recovers an uncertain ${failure} write without replacing immutable outputs`, async () => {
    const h = harness();
    h.options.failAfter = failure;
    await assert.rejects(h.run(), /Interrupted/u);
    h.options.failAfter = "";
    assert.deepEqual((await h.run()).image, image);
    for (const action of ["image", "tag", "release", "aliases"])
      assert.equal(h.writes.filter((write) => write === action).length, 1);
    if (["image", "manifest", "tag", "release"].includes(failure))
      assert.ok(h.checks.includes("pull and freshly scan retained digest"));
  });

void test("stale candidates and conflicting retained images stop before stable writes", async () => {
  const stale = harness();
  stale.options.superseded = true;
  await assert.rejects(stale.run(), /Stale/u);
  assert.deepEqual(stale.writes, []);

  const conflict = harness();
  conflict.options.failAfter = "image";
  await assert.rejects(conflict.run(), /Interrupted/u);
  conflict.setImage({ ...image, configDigest: `sha256:${"1".repeat(64)}` });
  await assert.rejects(conflict.run(), /journaled scan evidence/u);
  assert.deepEqual(conflict.writes, ["claim", "image"]);
});

void test("a newly blocked retained image holds remaining publication writes", async () => {
  const h = harness();
  h.options.failAfter = "image";
  await assert.rejects(h.run(), /Interrupted/u);
  h.options.failAfter = "";
  h.options.blocked = true;
  await assert.rejects(h.run(), /gate failed/u);
  assert.deepEqual(h.writes, ["claim", "image"]);
});
