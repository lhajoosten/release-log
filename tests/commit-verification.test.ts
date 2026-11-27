import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedAppCommit } from "../src/controller/commit-verification.ts";

const head = "a".repeat(40);
const bot = "rolling-release-log[bot]";
const repository = "owner/repo";
const evidence = () => ({
  sha: head,
  author: { login: bot, type: "Bot" },
  committer: { login: "web-flow", id: 19864447, type: "User" },
  commit: { verification: { verified: true, reason: "valid" } },
});
const signature = () => ({
  data: {
    repository: {
      nameWithOwner: repository,
      object: {
        oid: head,
        signature: { isValid: true, wasSignedByGitHub: true, signer: { login: "web-flow" } },
      },
    },
  },
});
const verify = (commit: unknown, signed: unknown = signature()) =>
  verifiedAppCommit(commit, head, bot, async () => signed, repository);

void test("accepts the GitHub App API commit and directly signed bot commits", async () => {
  assert.equal(await verify(evidence()), true);
  const direct = evidence();
  direct.committer = { login: bot, id: 42, type: "Bot" };
  assert.equal(await verify(direct, null), true);
});

void test("rejects altered commit identity, signer, signature or object", async () => {
  for (const change of [
    (c: ReturnType<typeof evidence>) => {
      c.sha = "b".repeat(40);
    },
    (c: ReturnType<typeof evidence>) => {
      c.author.login = "other[bot]";
    },
    (c: ReturnType<typeof evidence>) => {
      c.author.type = "User";
    },
    (c: ReturnType<typeof evidence>) => {
      c.committer.id = 1;
    },
    (c: ReturnType<typeof evidence>) => {
      c.committer.login = "other";
    },
    (c: ReturnType<typeof evidence>) => {
      c.commit.verification.verified = false;
    },
  ]) {
    const item = evidence();
    change(item);
    assert.equal(await verify(item), false);
  }
  for (const change of [
    (s: ReturnType<typeof signature>) => {
      s.data.repository.nameWithOwner = "other/repo";
    },
    (s: ReturnType<typeof signature>) => {
      s.data.repository.object.oid = "b".repeat(40);
    },
    (s: ReturnType<typeof signature>) => {
      s.data.repository.object.signature.isValid = false;
    },
    (s: ReturnType<typeof signature>) => {
      s.data.repository.object.signature.wasSignedByGitHub = false;
    },
    (s: ReturnType<typeof signature>) => {
      s.data.repository.object.signature.signer.login = "other";
    },
  ]) {
    const item = signature();
    change(item);
    assert.equal(await verify(evidence(), item), false);
  }
  assert.equal(await verify(evidence(), { errors: [{}], ...signature() }), false);
});
