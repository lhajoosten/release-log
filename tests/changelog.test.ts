import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderChangelog, updateChangelog, ChangelogError } from "../src/changelog.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const version = { kind: "released", currentVersion: "1.2.3" } as const;
const golden = [
  "## v1.3.0",
  "",
  "### Features",
  "",
  "- **a**: Export selected rows&#46; ([#2](https://github.com/example/project/pull/2))",
  "  - Impact: Keep the selection&#46;",
  "- **z** [internal]: Cache results&#46; ([#1](https://github.com/example/project/pull/1))",
  "  - Impact: Keep the selection&#46;",
  "",
  "### Documentation",
  "",
  "- **api**: Explain keys&#46; ([#3](https://github.com/example/project/pull/3))",
  "  - Impact: Keep the selection&#46;",
  "",
].join("\n");

async function rendered() {
  const { serialized } = await releaseFixture([
    { title: "feat(z): cache results", audience: "internal", summary: "Cache results." },
    { title: "feat(a): export rows", summary: "Export selected rows." },
    { title: "docs(api): explain keys", summary: "Explain keys." },
  ]);
  const text = await renderChangelog(serialized, fixtureConfiguration, version);
  assert.ok(text);
  return { serialized, text };
}

void test("mixed groups/scopes and internal entries match the hand-written golden byte for byte", async () => {
  const { serialized, text } = await rendered();
  assert.equal(text, golden);
  assert.equal(await renderChangelog(serialized, fixtureConfiguration, version), golden);
});

void test("every accepted type has the policy-defined group ordering and equal scopes use numeric PR order", async () => {
  const types = [
    "chore",
    "style",
    "test",
    "ci",
    "build",
    "docs",
    "refactor",
    "revert",
    "perf",
    "fix",
    "feat",
  ];
  const { serialized } = await releaseFixture(
    types
      .map((type) => ({ title: `${type}(api): preserve rows` }))
      .concat([{ title: "feat(api): retain keys" }]),
  );
  const text = await renderChangelog(serialized, fixtureConfiguration, version);
  assert.ok(text);
  assert.deepEqual(text.match(/^### .+$/gmu), [
    "### Features",
    "### Fixes",
    "### Performance",
    "### Reverts",
    "### Refactoring",
    "### Documentation",
    "### Build",
    "### Continuous integration",
    "### Tests",
    "### Style",
    "### Maintenance",
  ]);
  assert.ok(text.indexOf("[#11]") < text.indexOf("[#12]"));
  assert.equal((text.match(/\(\[#/gu) ?? []).length, 12);
});

void test("breaking evidence, actions, and untrusted text remain visible without becoming Markdown or HTML structure", async () => {
  const hostile =
    '<script>alert("x")</script>\n\n## forged\n[click](javascript:evil) ![track](https://evil.invalid) `run` &copy; <!-- release-log:pending:end -->';
  const { serialized } = await releaseFixture([
    {
      title: "feat(api)!: remove keys",
      summary: hostile,
      impact: hostile,
      action: hostile,
      message: "feat!: remove keys\n\nBREAKING CHANGE: use <new> keys",
    },
  ]);
  const text = await renderChangelog(serialized, fixtureConfiguration, version);
  assert.ok(text);
  assert.ok(text.startsWith("## v2.0.0\n"));
  assert.ok(text.includes("**Breaking change:**"));
  assert.ok(text.includes("use &#60;new&#62; keys"));
  assert.ok(text.includes("**Required action:**"));
  assert.ok(!text.includes("<script>"));
  assert.ok(!text.includes("<!-- release-log:"));
  const tree = fromMarkdown(text);
  const seen: { html: number; images: number; links: string[]; headings: number } = {
    html: 0,
    images: 0,
    links: [],
    headings: 0,
  };
  function visit(node: unknown): void {
    if (typeof node !== "object" || node === null) return;
    if ("type" in node) {
      if (node.type === "html") seen.html++;
      if (node.type === "image") seen.images++;
      if (node.type === "heading") seen.headings++;
      if (node.type === "link" && "url" in node && typeof node.url === "string")
        seen.links.push(node.url);
    }
    if ("children" in node && Array.isArray(node.children)) node.children.forEach(visit);
  }
  visit(tree);
  assert.deepEqual(seen, {
    html: 0,
    images: 0,
    links: ["https://github.com/example/project/pull/1"],
    headings: 2,
  });
});

void test("bootstrap renders the initial version and no-release plans produce no section", async () => {
  const bootstrap = await releaseFixture([{ title: "fix(api): retain keys" }], null);
  assert.ok(
    (
      await renderChangelog(bootstrap.serialized, fixtureConfiguration, {
        kind: "bootstrap",
        initialVersion: "0.1.0",
      })
    )?.startsWith("## v0.1.0\n"),
  );
  for (const changes of [[], [{ title: "docs(api): explain keys" }]]) {
    const { serialized } = await releaseFixture(changes);
    assert.equal(await renderChangelog(serialized, fixtureConfiguration, version), null);
  }
});

void test("pending updates are idempotent and preserve released sections and human preamble byte for byte", async () => {
  const { text } = await rendered();
  const preamble = "# Changelog\r\n\r\nHuman introduction.\r\n\r\n";
  const released = "## v1.2.3\r\n\r\nDo not rewrite **this**.\r\n";
  const first = updateChangelog(preamble + released, text);
  assert.ok(first.startsWith(preamble));
  assert.ok(first.endsWith(released));
  assert.equal(updateChangelog(first, text), first);
  const changed = text.replace("v1.3.0", "v1.4.0");
  const second = updateChangelog(first, changed);
  assert.ok(second.startsWith(preamble));
  assert.ok(second.endsWith(released));
  assert.ok(!second.includes("## v1.3.0"));
  assert.equal((second.match(/pending:v1/gu) ?? []).length, 1);
  assert.equal(updateChangelog(second, changed), second);
});

void test("new changelogs and no-release updates have explicit behavior", async () => {
  const { text } = await rendered();
  assert.ok(updateChangelog("", text).startsWith("# Changelog\n\n<!-- release-log:pending:v1"));
  assert.equal(updateChangelog("", null), "");
  assert.equal(updateChangelog("# Notes\n\nHuman text.\n", null), "# Notes\n\nHuman text.\n");
  assert.throws(() => updateChangelog(updateChangelog("", text), null), /new plan has no release/u);
});

void test("human edits, malformed markers, duplicates, fenced/nested markers, and unknown marker versions fail closed", async () => {
  const { text } = await rendered();
  const valid = updateChangelog("", text);
  const open = valid.slice(valid.indexOf("<!--"), valid.indexOf(" -->") + 4);
  for (const existing of [
    valid.replace("Cache results", "Human edit"),
    valid + valid,
    valid.replace("pending:v1", "pending:v2"),
    valid.replace("<!-- release-log:pending:end -->", ""),
    `\`\`\`md\n${valid}\n\`\`\`\n`,
    `> ${open}\n> \n> ${text}\n> <!-- release-log:pending:end -->\n`,
    "<!-- release-log:unknown -->\n",
    "<!-- release-log:pending:end -->\n" + open,
  ])
    assert.throws(() => updateChangelog(existing, text), ChangelogError);
  assert.throws(() => updateChangelog("", "arbitrary text\n"), ChangelogError);
  assert.throws(() => updateChangelog("x".repeat(16 * 1024 * 1024 + 1), text), /16 MiB/u);
});
