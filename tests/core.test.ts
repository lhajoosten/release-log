import assert from "node:assert/strict";
import { test } from "node:test";
import { planRelease, renderRelease } from "../src/release/core.ts";

const changes = [
  { number: 41, title: "feat(export): add CSV export", author: "alice", requiredAction: null },
  { number: 42, title: "feat(export): add column selection", author: "bob", requiredAction: null },
  {
    number: 43,
    title: "fix: retain export settings",
    author: "carol",
    requiredAction: "Restart the export worker.",
  },
];
const input = { repository: "acme/widget", previousVersion: "1.2.3", changes };

void test("golden release is deterministic and includes credits and tag comparison", () => {
  const result = planRelease({ ...input, changes: changes.toReversed() });
  assert.deepEqual(result, {
    kind: "release",
    version: "1.3.0",
    markdown: `## v1.3.0\n\n### ✨ Features\n\n- add CSV export ([#41](https://github.com/acme/widget/pull/41)) by [@alice](https://github.com/alice)\n- add column selection ([#42](https://github.com/acme/widget/pull/42)) by [@bob](https://github.com/bob)\n\n### 🐛 Fixes\n\n- retain export settings ([#43](https://github.com/acme/widget/pull/43)) by [@carol](https://github.com/carol)\n\n### 🛠️ Required actions\n\n- Restart the export worker. ([#43](https://github.com/acme/widget/pull/43))\n\n[Full changelog v1.2.3...v1.3.0](https://github.com/acme/widget/compare/v1.2.3...v1.3.0)\n`,
  });
});

void test("maintenance waits and breaking versions follow stable and pre-1.0 rules", () => {
  const only = [{ ...changes[0]!, title: "docs: explain exports" }];
  assert.deepEqual(planRelease({ ...input, changes: only }), { kind: "pending" });
  const breaking = [{ ...only[0]!, title: "docs!: remove exports" }];
  assert.equal(planRelease({ ...input, changes: breaking }).kind, "release");
  const prerelease = planRelease({ ...input, previousVersion: "0.4.7", changes: breaking });
  assert.equal(prerelease.kind === "release" && prerelease.version, "0.5.0");
});

void test("rejects invalid identities and escapes untrusted content", () => {
  assert.throws(() => planRelease({ ...input, repository: "../evil" }));
  assert.throws(() => planRelease({ ...input, changes: [changes[0]!, changes[0]!] }));
  const output = renderRelease({
    ...input,
    version: "1.3.0",
    changes: [{ ...changes[0]!, title: "feat: <script> [link](x)", requiredAction: "<img>" }],
  });
  assert.ok(!output.includes("<script>"));
  assert.ok(!output.includes("[link](x)"));
  assert.ok(output.includes("&#60;img&#62;"));
});

void test("credits a captured GitHub App bot without injecting Markdown", () => {
  const output = renderRelease({
    ...input,
    version: "1.3.0",
    changes: [{ ...changes[0]!, author: "dependabot[bot]" }],
  });
  assert.ok(output.includes("[@dependabot&#91;bot&#93;](https://github.com/dependabot%5Bbot%5D)"));
});
