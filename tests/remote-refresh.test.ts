import assert from "node:assert/strict";
import test from "node:test";
import { Remote } from "../src/controller/remote.ts";

const source = "a".repeat(40),
  previous = "b".repeat(40),
  next = "c".repeat(40);
const repository = "acme/widget",
  branch = "release/v1";
const pull = (head: string, title = "Old title", body = "Old body") => ({
  number: 7,
  state: "open",
  title,
  body,
  user: { type: "Bot", login: "release[bot]" },
  head: { sha: head, ref: branch, repo: { full_name: repository } },
  base: { ref: "main", repo: { full_name: repository } },
});

class Fixture extends Remote {
  reads: unknown[] = [];
  patched = false;
  head = previous;
  constructor() {
    super(repository, "synthetic", "release[bot]");
  }
  override async request(path: string, method: "GET" | "POST" | "PATCH" = "GET"): Promise<unknown> {
    if (path === "git/ref/heads/main") return { object: { sha: source } };
    if (path === "git/ref/heads/" + branch) return { object: { sha: this.head } };
    if (path.startsWith("pulls?")) return [pull(previous)];
    if (path === "git/commits/" + source) return { tree: { sha: source } };
    if (path === "git/trees") return { sha: source };
    if (path === "git/commits") return { sha: next };
    if (path === "git/refs/heads/" + branch) {
      this.head = next;
      return {};
    }
    if (path === "pulls/7" && method === "PATCH") {
      this.patched = true;
      return {};
    }
    if (path === "pulls/7") {
      assert.ok(this.reads.length, "unexpected pull read");
      return this.reads.shift();
    }
    throw new Error("Unexpected request " + path);
  }
  refresh() {
    return this.writeProposal({
      branch,
      source,
      previous,
      number: 7,
      title: "New title",
      body: "New body",
      expectedTitle: "Old title",
      expectedBody: "Old body",
      files: new Map(),
    });
  }
}

void test("refresh waits for the exact pull request to reflect the ref and text writes", async () => {
  const fixture = new Fixture();
  fixture.reads = [
    pull(previous),
    pull(next),
    pull(next),
    pull(next),
    pull(next, "New title", "New body"),
  ];
  await fixture.refresh();
  assert.equal(fixture.patched, true);
  assert.equal(fixture.reads.length, 0);
});

void test("refresh rejects concurrent edits, unowned pulls and unrelated heads", async (t) => {
  for (const [name, changed] of [
    ["edited text", pull(next, "Human edit")],
    ["unowned pull", { ...pull(next), user: { type: "User", login: "someone" } }],
    ["unrelated head", pull("d".repeat(40))],
  ] as const) {
    await t.test(name, async () => {
      const fixture = new Fixture();
      fixture.reads = [changed];
      await assert.rejects(fixture.refresh(), /edited during refresh/u);
      assert.equal(fixture.patched, false);
    });
  }
});

void test("metadata recovery checks refs and text, then confirms the saved text", async () => {
  const fixture = new Fixture();
  fixture.reads = [pull(previous), pull(previous), pull(previous, "New title", "New body")];
  let rechecked = false;
  await fixture.updateProposalText({
    branch,
    source,
    head: previous,
    number: 7,
    expectedTitle: "Old title",
    expectedBody: "Old body",
    title: "New title",
    body: "New body",
    recheck: async () => {
      rechecked = true;
    },
  });
  assert.equal(rechecked, true);
  assert.equal(fixture.patched, true);
  assert.equal(fixture.reads.length, 0);
});

void test("metadata recovery refuses a text edit during its recheck", async () => {
  const fixture = new Fixture();
  fixture.reads = [pull(previous, "Human edit")];
  await assert.rejects(
    fixture.updateProposalText({
      branch,
      source,
      head: previous,
      number: 7,
      expectedTitle: "Old title",
      expectedBody: "Old body",
      title: "New title",
      body: "New body",
    }),
    /edited during refresh/u,
  );
  assert.equal(fixture.patched, false);
});

void test("metadata recovery checks refs after its baseline recheck", async () => {
  const fixture = new Fixture();
  await assert.rejects(
    fixture.updateProposalText({
      branch,
      source,
      head: previous,
      number: 7,
      expectedTitle: "Old title",
      expectedBody: "Old body",
      title: "New title",
      body: "New body",
      recheck: async () => {
        fixture.head = "d".repeat(40);
      },
    }),
    /Main or the proposal changed/u,
  );
  assert.equal(fixture.patched, false);
});
