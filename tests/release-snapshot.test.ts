import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  captureReleaseSnapshot,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
  ReleaseSnapshotError,
} from "../src/release-snapshot.ts";
import type { ReleaseInputConfiguration } from "../src/release-snapshot.ts";

const execute = promisify(execFile);
const base = "0".repeat(40);
const first = "a".repeat(40);
const second = "b".repeat(40);
const config: ReleaseInputConfiguration = {
  schemaVersion: 1,
  repository: "example/project",
  repositoryId: 17,
  releaseBranch: "main",
  releasePolicy: "release-policy-v1",
};

function context(audience = "users", action = "null") {
  return [
    "```release-log",
    "version: 1",
    `audience: ${audience}`,
    "summary: Export selected rows.",
    "impact: Keep the selection.",
    `required_action: ${action}`,
    "```",
  ].join("\n");
}

function entry(number = 101, commitSha = first, parent = base) {
  return {
    number,
    id: number + 1000,
    title: "feat(api): add exports",
    body: context(),
    updatedAt: "2026-11-08T10:00:00Z",
    mergedAt: "2026-11-08T09:00:00Z",
    mergeCommitSha: commitSha,
    commitCount: 1,
    headSha: commitSha,
    headRef: "feature",
    headRepositoryId: 23,
    baseRepositoryId: 17,
    authorId: 7,
    authorType: "User",
    url: `https://github.com/example/project/pull/${number}`,
    landingKind: "linear" as const,
    originalCommits: [{ sha: commitSha, message: "feat: add exports\n", parentShas: [parent] }],
    landedCommits: [{ sha: commitSha, message: "feat: add exports\n", parentShas: [parent] }],
  };
}

function input() {
  return {
    repository: "example/project",
    releaseBranch: "main",
    range: {
      baseline: { kind: "bootstrap" as const, commitSha: base },
      sourceCommitSha: first,
      baselineIsAncestor: true as const,
      commitShas: [first],
    },
    pullRequests: [entry()],
  };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function decoded(value: string): Record<string, unknown> {
  const result: unknown = JSON.parse(value);
  return object(result);
}

function firstPull(value: Record<string, unknown>): Record<string, unknown> {
  const evidence = object(value.input);
  assert.ok(Array.isArray(evidence.pullRequests));
  const rows: unknown[] = evidence.pullRequests;
  const pull = object(rows[0]);
  rows[0] = pull;
  evidence.pullRequests = rows;
  value.input = evidence;
  return pull;
}

function hasCode(code: ReleaseSnapshotError["code"]) {
  return (error: unknown) => error instanceof ReleaseSnapshotError && error.code === code;
}

void test("capture matches a hand-written normalized golden and retains raw association evidence", async () => {
  const source = input();
  const snapshot = await captureReleaseSnapshot(source, config);
  const golden: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-inputs-v1.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(snapshot.normalized, golden);
  assert.deepEqual(snapshot.input, source);
  assert.equal(snapshot.schemaVersion, 1);
  const expectedConfigurationId = createHash("sha256")
    .update(
      '{"releaseBranch":"main","releasePolicy":"release-policy-v1","repository":"example/project","repositoryId":17,"schemaVersion":1}',
    )
    .digest("hex");
  assert.equal(snapshot.configurationId, expectedConfigurationId);
  assert.match(snapshot.snapshotId, /^[a-f0-9]{64}$/u);
  assert.match(snapshot.tool.normalizerId, /^[a-f0-9]{64}$/u);
});

void test("serialization/replay round-trip is byte-stable and revalidates normalized data", async () => {
  const snapshot = await captureReleaseSnapshot(input(), config);
  const encoded = await serializeReleaseSnapshot(snapshot);
  const replayed = await replayReleaseSnapshot(encoded, config);
  assert.deepEqual(replayed, snapshot);
  assert.equal(await serializeReleaseSnapshot(replayed), encoded);
  assert.ok(encoded.endsWith("\n"));
  assert.equal(encoded.split("\n").length, 2);
});

void test("later source metadata edits neither mutate an existing snapshot nor trigger a replay refresh", async () => {
  const source = input();
  const snapshot = await captureReleaseSnapshot(source, config);
  const before = await serializeReleaseSnapshot(snapshot);
  const pull = source.pullRequests[0];
  assert.ok(pull);
  pull.body = context("internal");
  pull.title = "fix(api): retain keys";
  pull.originalCommits[0]?.parentShas.push("c".repeat(40));
  assert.equal(await serializeReleaseSnapshot(snapshot), before);
  const replayed = await replayReleaseSnapshot(before, config);
  assert.equal(replayed.normalized.pullRequests[0]?.context.audience, "users");
  assert.equal(replayed.normalized.pullRequests[0]?.title.type, "feat");
  const refreshed = await captureReleaseSnapshot(
    {
      ...source,
      pullRequests: [
        { ...pull, originalCommits: snapshot.input.pullRequests[0]?.originalCommits ?? [] },
      ],
    },
    config,
  );
  assert.notEqual(refreshed.snapshotId, snapshot.snapshotId);
});

void test("PR and landed-commit array order does not affect canonical snapshot identity", async () => {
  const source = input();
  source.pullRequests.push(entry(3, second, first));
  source.range.sourceCommitSha = second;
  source.range.commitShas.push(second);
  const initial = await captureReleaseSnapshot(source, config);
  source.pullRequests.reverse();
  source.range.commitShas.reverse();
  assert.equal(
    await serializeReleaseSnapshot(await captureReleaseSnapshot(source, config)),
    await serializeReleaseSnapshot(initial),
  );
  assert.deepEqual(
    initial.normalized.pullRequests.map((pull) => pull.number),
    [3, 101],
  );
});

for (const [name, update, code] of [
  [
    "missing context",
    (pull: ReturnType<typeof entry>) => {
      pull.body = "";
    },
    "block-missing",
  ],
  [
    "duplicate context",
    (pull: ReturnType<typeof entry>) => {
      pull.body = context() + "\n" + context();
    },
    "block-duplicate",
  ],
  [
    "unscoped title",
    (pull: ReturnType<typeof entry>) => {
      pull.title = "feat: add exports";
    },
    "scope-empty",
  ],
  [
    "scoped authored commit",
    (pull: ReturnType<typeof entry>) => {
      const original = pull.originalCommits[0];
      assert.ok(original);
      original.message = "feat(api): add exports";
    },
    "scope-empty",
  ],
  [
    "breaking commit conflict",
    (pull: ReturnType<typeof entry>) => {
      const original = pull.originalCommits[0];
      assert.ok(original);
      original.message = "feat!: remove old exports";
    },
    "breaking-conflict",
  ],
  [
    "breaking action missing",
    (pull: ReturnType<typeof entry>) => {
      pull.title = "feat(api)!: remove old exports";
    },
    "breaking-action-required",
  ],
] as const) {
  void test(`capture rejects ${name} without returning a usable snapshot`, async () => {
    const source = input();
    const pull = source.pullRequests[0];
    assert.ok(pull);
    update(pull);
    await assert.rejects(captureReleaseSnapshot(source, config), (error: unknown) => {
      assert.ok(error instanceof ReleaseSnapshotError);
      assert.equal(error.code, "metadata-invalid");
      assert.ok(error.issues.some((issue) => issue.code === code));
      return true;
    });
  });
}

void test("breaking evidence, internal context, and warnings survive normalization and replay", async () => {
  const source = input();
  const pull = source.pullRequests[0];
  assert.ok(pull);
  pull.title = "feat(api)!: remove old exports";
  pull.body = context("internal", "Use the new export command.");
  const commit = pull.originalCommits[0];
  assert.ok(commit);
  commit.message =
    "feat: remove old exports\nBody without a blank line.\n\nBREAKING CHANGE: use the new command";
  const snapshot = await captureReleaseSnapshot(source, config);
  const normalized = snapshot.normalized.pullRequests[0];
  assert.ok(normalized);
  assert.equal(normalized.context.audience, "internal");
  assert.equal(normalized.context.requiredAction, "Use the new export command.");
  assert.ok(normalized.breakingChanges.includes("use the new command"));
  assert.ok(normalized.validation.warnings.some((issue) => issue.code === "body-leading-blank"));
  assert.deepEqual(
    (await replayReleaseSnapshot(await serializeReleaseSnapshot(snapshot), config)).normalized,
    snapshot.normalized,
  );
});

void test("structural merge messages stay raw evidence instead of being parsed as product entries", async () => {
  const source = input();
  const normal = source.pullRequests[0];
  assert.ok(normal);
  const merge = {
    sha: second,
    parentShas: [base, first],
    message: "Merge pull request #101 from contributor/feature\n",
  };
  const merged = {
    ...normal,
    mergeCommitSha: second,
    landingKind: "merge" as const,
    landedCommits: [...normal.landedCommits, merge],
  };
  const snapshot = await captureReleaseSnapshot(
    {
      ...source,
      range: { ...source.range, sourceCommitSha: second, commitShas: [second, first] },
      pullRequests: [merged],
    },
    config,
  );
  assert.ok(
    snapshot.input.pullRequests[0]?.landedCommits.some(
      (commit) => commit.message === merge.message,
    ),
  );
  assert.equal(
    snapshot.normalized.pullRequests[0]?.commits.some((commit) => commit.sha === second),
    false,
  );
});

void test("rewritten landed commits retain separate original IDs and raw messages", async () => {
  const source = input();
  const pull = source.pullRequests[0];
  assert.ok(pull);
  pull.headSha = second;
  const original = pull.originalCommits[0];
  assert.ok(original);
  original.sha = second;
  const snapshot = await captureReleaseSnapshot(source, config);
  assert.deepEqual(
    snapshot.normalized.pullRequests[0]?.commits.map((commit) => [commit.source, commit.sha]),
    [
      ["original", second],
      ["landed", first],
    ],
  );
});

void test("empty ranges and tagged baselines round-trip without Git or credentials", async () => {
  const source = input();
  const empty = {
    ...source,
    range: { ...source.range, sourceCommitSha: base, commitShas: [] },
    pullRequests: [],
  };
  assert.deepEqual((await captureReleaseSnapshot(empty, config)).normalized.pullRequests, []);
  const tagged = {
    ...source,
    range: {
      ...source.range,
      baseline: {
        kind: "tag" as const,
        name: "v1.2.3",
        objectSha: "c".repeat(40),
        commitSha: base,
      },
    },
  };
  assert.deepEqual(
    (
      await replayReleaseSnapshot(
        await serializeReleaseSnapshot(await captureReleaseSnapshot(tagged, config)),
        config,
      )
    ).input.range.baseline,
    tagged.range.baseline,
  );
});

void test("replay does not touch GitHub even when network access would throw", async () => {
  const encoded = await serializeReleaseSnapshot(await captureReleaseSnapshot(input(), config));
  const moduleUrl = new URL("../src/release-snapshot.ts", import.meta.url).href;
  const script = `
    globalThis.fetch = () => { throw new Error("Network access is forbidden during replay"); };
    const { replayReleaseSnapshot } = await import(${JSON.stringify(moduleUrl)});
    const result = await replayReleaseSnapshot(${JSON.stringify(encoded)}, ${JSON.stringify(config)});
    console.log(result.snapshotId);
  `;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 10_000,
    encoding: "utf8",
  });
  assert.equal(stdout.trim(), decoded(encoded).snapshotId);
});

for (const [name, change, expected] of [
  [
    "unknown snapshot version",
    (value: Record<string, unknown>) => {
      value.schemaVersion = 2;
    },
    "schema-invalid",
  ],
  [
    "unknown envelope field",
    (value: Record<string, unknown>) => {
      value.token = "synthetic-secret";
    },
    "schema-invalid",
  ],
  [
    "unknown source field",
    (value: Record<string, unknown>) => {
      value.input = { ...object(value.input), token: "synthetic-secret" };
    },
    "schema-invalid",
  ],
  [
    "unknown PR field",
    (value: Record<string, unknown>) => {
      firstPull(value).credentials = "synthetic-secret";
    },
    "schema-invalid",
  ],
  [
    "wrong normalizer",
    (value: Record<string, unknown>) => {
      value.tool = { ...object(value.tool), normalizerId: "0".repeat(64) };
    },
    "normalizer-mismatch",
  ],
  [
    "wrong tool version",
    (value: Record<string, unknown>) => {
      value.tool = { ...object(value.tool), version: "99.0.0" };
    },
    "normalizer-mismatch",
  ],
  [
    "wrong configuration digest",
    (value: Record<string, unknown>) => {
      value.configurationId = "0".repeat(64);
    },
    "configuration-mismatch",
  ],
  [
    "wrong snapshot digest",
    (value: Record<string, unknown>) => {
      value.snapshotId = "0".repeat(64);
    },
    "integrity-mismatch",
  ],
  [
    "forged normalized success",
    (value: Record<string, unknown>) => {
      value.normalized = { valid: true };
    },
    "integrity-mismatch",
  ],
  [
    "changed raw body",
    (value: Record<string, unknown>) => {
      firstPull(value).body = context("internal");
    },
    "integrity-mismatch",
  ],
  [
    "invalid captured context",
    (value: Record<string, unknown>) => {
      firstPull(value).body = "";
    },
    "metadata-invalid",
  ],
  [
    "repository ID mismatch",
    (value: Record<string, unknown>) => {
      firstPull(value).baseRepositoryId = 99;
    },
    "schema-invalid",
  ],
  [
    "untrusted URL",
    (value: Record<string, unknown>) => {
      firstPull(value).url = "https://attacker.invalid/private";
    },
    "schema-invalid",
  ],
  [
    "unknown landing kind",
    (value: Record<string, unknown>) => {
      firstPull(value).landingKind = "guess";
    },
    "schema-invalid",
  ],
] as const) {
  void test(`replay rejects ${name}`, async () => {
    const encoded = await serializeReleaseSnapshot(await captureReleaseSnapshot(input(), config));
    const value = decoded(encoded);
    change(value);
    await assert.rejects(replayReleaseSnapshot(JSON.stringify(value), config), hasCode(expected));
  });
}

void test("replay rejects forged normalized results even with a recomputed envelope checksum", async () => {
  const value = decoded(
    await serializeReleaseSnapshot(await captureReleaseSnapshot(input(), config)),
  );
  value.normalized = { valid: true };
  const { snapshotId: _snapshotId, ...payload } = value;
  value.snapshotId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await assert.rejects(
    replayReleaseSnapshot(JSON.stringify(value), config),
    hasCode("integrity-mismatch"),
  );
});

void test("replay requires the expected configuration, not just the snapshot's own claim", async () => {
  const encoded = await serializeReleaseSnapshot(await captureReleaseSnapshot(input(), config));
  await assert.rejects(
    replayReleaseSnapshot(encoded, { ...config, releaseBranch: "other" }),
    hasCode("configuration-mismatch"),
  );
  await assert.rejects(
    replayReleaseSnapshot(encoded, { ...config, repositoryId: 99 }),
    hasCode("configuration-mismatch"),
  );
});

void test("capture rejects duplicate ownership, missing membership, wrong head, and unverified automation", async () => {
  const source = input();
  const pull = source.pullRequests[0];
  assert.ok(pull);
  const secondOwner = {
    ...pull,
    number: 102,
    id: 1102,
    url: "https://github.com/example/project/pull/102",
  };
  await assert.rejects(
    captureReleaseSnapshot({ ...source, pullRequests: [pull, secondOwner] }, config),
    hasCode("schema-invalid"),
  );
  await assert.rejects(
    captureReleaseSnapshot({ ...source, pullRequests: [] }, config),
    hasCode("schema-invalid"),
  );
  await assert.rejects(
    captureReleaseSnapshot({ ...source, pullRequests: [{ ...pull, headSha: second }] }, config),
    hasCode("schema-invalid"),
  );
  await assert.rejects(
    captureReleaseSnapshot(
      {
        ...source,
        pullRequests: [
          { ...pull, authorType: "Bot", headRepositoryId: 17, headRef: "release-log/main" },
        ],
      },
      config,
    ),
    hasCode("schema-invalid"),
  );
});

void test("the same commit cannot have contradictory original and landed parents", async () => {
  const source = input();
  const original = source.pullRequests[0]?.originalCommits[0];
  assert.ok(original);
  original.parentShas = [second];
  await assert.rejects(captureReleaseSnapshot(source, config), hasCode("schema-invalid"));
});

void test("replay accepts the exact UTF-8 byte limit but rejects one extra byte", async () => {
  const encoded = await serializeReleaseSnapshot(await captureReleaseSnapshot(input(), config));
  const bounded = encoded + " ".repeat(16 * 1024 * 1024 - Buffer.byteLength(encoded, "utf8"));
  assert.equal(
    await serializeReleaseSnapshot(await replayReleaseSnapshot(bounded, config)),
    encoded,
  );
  await assert.rejects(replayReleaseSnapshot(bounded + "\n", config), hasCode("resource-limit"));
});

void test("capture rejects unreachable graph nodes and cycles instead of trusting an ancestry flag", async () => {
  const source = input();
  const disconnected = entry(102, second, base);
  const altered = {
    ...source,
    range: { ...source.range, commitShas: [first, second] },
    pullRequests: [...source.pullRequests, disconnected],
  };
  await assert.rejects(captureReleaseSnapshot(altered, config), hasCode("schema-invalid"));
  const cyclic = entry(101, first, first);
  await assert.rejects(
    captureReleaseSnapshot({ ...source, pullRequests: [cyclic] }, config),
    hasCode("schema-invalid"),
  );
});

void test("malformed JSON, byte limits, nesting, nodes, and text limits fail explicitly", async () => {
  await assert.rejects(
    replayReleaseSnapshot("{private malformed content", config),
    hasCode("schema-invalid"),
  );
  await assert.rejects(
    replayReleaseSnapshot("😀".repeat(4 * 1024 * 1024 + 1), config),
    hasCode("resource-limit"),
  );
  await assert.rejects(
    replayReleaseSnapshot("[".repeat(34) + "null" + "]".repeat(34), config),
    hasCode("resource-limit"),
  );
  await assert.rejects(
    replayReleaseSnapshot(JSON.stringify(Array(100_001).fill(null)), config),
    hasCode("resource-limit"),
  );
  const source = input();
  const pull = source.pullRequests[0];
  assert.ok(pull);
  pull.body = "x".repeat(1024 * 1024 + 1);
  await assert.rejects(captureReleaseSnapshot(source, config), hasCode("resource-limit"));
});

void test("non-JSON objects and cyclic data are rejected without silently dropping fields", async () => {
  const snapshot = await captureReleaseSnapshot(input(), config);
  for (const extra of [undefined, Number.NaN, new Date(), () => "ignored"]) {
    const altered = { ...snapshot, extra };
    await assert.rejects(
      Reflect.apply(serializeReleaseSnapshot, undefined, [altered]),
      hasCode("schema-invalid"),
    );
  }
  const cyclic: Record<string, unknown> = { ...snapshot };
  cyclic.cycle = cyclic;
  await assert.rejects(
    Reflect.apply(serializeReleaseSnapshot, undefined, [cyclic]),
    hasCode("schema-invalid"),
  );
});

void test("returned tool identity is not shared mutable state across snapshots", async () => {
  const snapshot = await captureReleaseSnapshot(input(), config);
  Object.assign(snapshot.tool, { version: "modified" });
  const secondSnapshot = await captureReleaseSnapshot(input(), config);
  assert.notEqual(secondSnapshot.tool.version, "modified");
  await assert.rejects(serializeReleaseSnapshot(snapshot), hasCode("normalizer-mismatch"));
});
