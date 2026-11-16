import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { backfillChangelog, writeBackfilledChangelog } from "../src/changelog-backfill.ts";
import { updateChangelog } from "../src/changelog.ts";
import { fixtureConfiguration } from "./release-fixture.ts";
import type { GitHubRead } from "../src/github.ts";

const execute = promisify(execFile);
async function fixture(context: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "release-log-backfill-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    execute(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        ...args,
      ],
      {
        cwd: path,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          GIT_AUTHOR_DATE: "2026-01-01T22:30:00-03:00",
          GIT_COMMITTER_DATE: "2026-01-01T22:30:00-03:00",
        },
      },
    );
  await git("init", "--initial-branch=main");
  await git("commit", "--allow-empty", "-m", "chore: initial state");
  await git("tag", "v0.1.0");
  await git("commit", "--allow-empty", "-m", "feat: add keys");
  await git("tag", "v0.2.0");
  return { path, git };
}
const existing = [
  "# Changelog",
  "",
  "Preamble with original prose.  ",
  "",
  "## v0.2.0",
  "",
  "### Features",
  "",
  "- **api**: Keep authored prose. ([#2](https://github.com/example/project/pull/2))",
  "",
  "```md",
  "### Features",
  "- [#999](https://github.com/example/project/pull/999)",
  "```",
  "",
  "## v0.1.0",
  "",
  "### Fixes",
  "",
  "- Retain original detail. ([#1](https://github.com/example/project/pull/1))",
  "",
].join("\n");

void test("backfill uses verified release tags and present-day author evidence, preserves prose, and is idempotent", async (context) => {
  const { path } = await fixture(context);
  const requests: string[] = [];
  const read: GitHubRead = async (url) => {
    requests.push(url);
    const number = Number(url.split("/").at(-1));
    return Response.json({ number, user: number === 1 ? null : { login: "dependabot[bot]" } });
  };
  const after = await backfillChangelog(
    existing,
    fixtureConfiguration,
    path,
    "synthetic-token",
    read,
  );
  assert.ok(after.includes("### ✨ Features"));
  assert.ok(after.includes("### 🐛 Fixes"));
  assert.ok(
    after.includes(
      "Keep authored prose. ([#2](https://github.com/example/project/pull/2)) by [&#64;dependabot&#91;bot&#93;](https://github.com/dependabot%5Bbot%5D)",
    ),
  );
  assert.ok(
    after.includes(
      "```md\n### Features\n- [#999](https://github.com/example/project/pull/999)\n```",
    ),
  );
  assert.ok(after.startsWith("# Changelog\n\nPreamble with original prose.  \n"));
  assert.ok(
    after.includes(
      "Full changelog: [v0.1.0…v0.2.0](https://github.com/example/project/compare/v0.1.0...v0.2.0)",
    ),
  );
  assert.equal((after.match(/Full changelog:/gu) ?? []).length, 1);
  assert.ok(!after.includes("Inputs captured"));
  assert.deepEqual(
    requests.map((url) => url.split("/").at(-1)),
    ["2", "1"],
  );
  assert.equal(
    await backfillChangelog(after, fixtureConfiguration, path, "synthetic-token", read),
    after,
  );
  await writeFile(join(path, "CHANGELOG.md"), existing);
  await writeBackfilledChangelog(path, existing, after);
  assert.equal(await readFile(join(path, "CHANGELOG.md"), "utf8"), after);
  await assert.rejects(writeBackfilledChangelog(path, existing, after), /changed during backfill/u);
});

const unavailableAuthor: GitHubRead = async (url) =>
  Response.json({ number: Number(url.split("/").at(-1)), user: null });
const malformedAuthor: GitHubRead = async () => Response.json({ number: 2, user: { login: 42 } });

void test("backfill visibly separates internal maintenance from new and existing comparison links", async (context) => {
  const { path } = await fixture(context);
  for (const footer of [
    "",
    "Full changelog: [v0.1.0…v0.2.0](https://github.com/example/project/compare/v0.1.0...v0.2.0)\n\n",
  ]) {
    const input = existing.replace(
      "## v0.1.0",
      `<details>\n<summary>Internal maintenance</summary>\n\n- Keep tooling.\n\n</details>\n\n${footer}## v0.1.0`,
    );
    const after = await backfillChangelog(
      input,
      fixtureConfiguration,
      path,
      "synthetic-token",
      unavailableAuthor,
    );
    assert.ok(after.includes("</details>\n\n<br>\n\nFull changelog:"));
    assert.equal(
      await backfillChangelog(
        after,
        fixtureConfiguration,
        path,
        "synthetic-token",
        unavailableAuthor,
      ),
      after,
    );
  }
});

void test("backfill enriches a tagged release that still has its committed pending markers", async (context) => {
  const { path, git } = await fixture(context);
  const pending = updateChangelog(existing, "## v0.2.1\n\n### Fixes\n\n- Keep keys.\n");
  await writeFile(join(path, "CHANGELOG.md"), pending);
  await git("add", "CHANGELOG.md");
  await git("commit", "-m", "chore: capture released changelog");
  await git("tag", "v0.2.1");
  const after = await backfillChangelog(
    pending,
    fixtureConfiguration,
    path,
    "synthetic-token",
    unavailableAuthor,
  );
  assert.ok(after.includes("## v0.2.1 (2026-01-02)"));
  assert.ok(after.includes("### 🐛 Fixes"));
  assert.ok(
    after.includes(
      "Date source: tagged commit committer (UTC); snapshot capture time unavailable.",
    ),
  );
  assert.ok(!after.includes("<!-- release-log:pending:"));
  assert.ok(after.includes("/compare/v0.2.0...v0.2.1"));
  assert.equal(
    await backfillChangelog(
      after,
      fixtureConfiguration,
      path,
      "synthetic-token",
      unavailableAuthor,
    ),
    after,
  );
  const conflicting = updateChangelog(existing, "## v0.2.0\n\n### Fixes\n\n- Unreleased keys.\n");
  await assert.rejects(
    backfillChangelog(
      conflicting,
      fixtureConfiguration,
      path,
      "synthetic-token",
      unavailableAuthor,
    ),
    /version tag does not contain/u,
  );
});

void test("backfill leaves owned pending bytes untouched and rejects edited markers", async (context) => {
  const { path } = await fixture(context);
  const pending = updateChangelog(existing, "## v0.3.0\n\n### Features\n\n- Pending proposal.\n");
  const read = unavailableAuthor;
  const after = await backfillChangelog(
    pending,
    fixtureConfiguration,
    path,
    "synthetic-token",
    read,
  );
  const owned = pending.slice(
    pending.indexOf("<!-- release-log:"),
    pending.indexOf("<!-- release-log:pending:end -->") + "<!-- release-log:pending:end -->".length,
  );
  assert.ok(after.includes(owned));
  assert.ok(after.includes("### ✨ Features"));
  await assert.rejects(
    backfillChangelog(
      pending.replace("Pending proposal.", "Edited proposal."),
      fixtureConfiguration,
      path,
      "synthetic-token",
      read,
    ),
    /edited/u,
  );
});

void test("backfill fails closed on missing tags, bad authors, API failure and unsafe output files", async (context) => {
  const { path, git } = await fixture(context);
  const read = malformedAuthor;
  await assert.rejects(
    backfillChangelog(existing, fixtureConfiguration, path, "synthetic-token", read),
    /author evidence/u,
  );
  await assert.rejects(
    backfillChangelog(
      existing,
      fixtureConfiguration,
      path,
      "synthetic-token",
      async () => new Response("", { status: 403 }),
    ),
    /HTTP 403/u,
  );
  await git("tag", "-d", "v0.1.0");
  await assert.rejects(
    backfillChangelog(existing, fixtureConfiguration, path, "synthetic-token", read),
    /Tag not found/u,
  );
  const destination = join(path, "original.md");
  await writeFile(destination, existing);
  await symlink(destination, join(path, "CHANGELOG.md"));
  await assert.rejects(writeBackfilledChangelog(path, existing, "rewritten"), /ordinary file/u);
  assert.equal(await readFile(destination, "utf8"), existing);
});

void test("backfill date precedence preserves recorded dates and uses immutable UTC tag dates", async (context) => {
  const { path } = await fixture(context);
  const lightweight = await backfillChangelog(
    existing,
    fixtureConfiguration,
    path,
    "synthetic-token",
    unavailableAuthor,
  );
  assert.ok(lightweight.includes("## v0.2.0 (2026-01-02)"));
  assert.ok(
    lightweight.includes(
      "Date source: tagged commit committer (UTC); snapshot capture time unavailable.",
    ),
  );
  const dated = existing.replace("## v0.2.0", "## v0.2.0 (2025-12-12)");
  assert.ok(
    (
      await backfillChangelog(
        dated,
        fixtureConfiguration,
        path,
        "synthetic-token",
        unavailableAuthor,
      )
    ).includes("## v0.2.0 (2025-12-12)"),
  );
  const captured = existing.replace(
    "## v0.2.0\n",
    "## v0.2.0\n\nInputs captured at: 2026-03-04T05:06:07.000Z (UTC; not a release date).\n",
  );
  assert.ok(
    (
      await backfillChangelog(
        captured,
        fixtureConfiguration,
        path,
        "synthetic-token",
        unavailableAuthor,
      )
    ).includes("## v0.2.0 (2026-03-04)"),
  );
  await assert.rejects(
    backfillChangelog(
      captured.replace("2026-03-04", "2026-02-30"),
      fixtureConfiguration,
      path,
      "synthetic-token",
      unavailableAuthor,
    ),
    /capture timestamp is invalid/u,
  );
  await execute("git", ["-c", "tag.gpgSign=false", "tag", "-a", "v0.2.1", "-m", "Release"], {
    cwd: path,
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_DATE: "2026-02-03T01:02:03+03:00",
    },
  });
  const annotated = await backfillChangelog(
    "# Changelog\n\n## v0.2.1\n\n### Fixes\n\n- Keep keys.\n",
    fixtureConfiguration,
    path,
    "synthetic-token",
    unavailableAuthor,
  );
  assert.ok(annotated.includes("## v0.2.1 (2026-02-02)"));
  assert.ok(
    annotated.includes("Date source: annotated tag (UTC); snapshot capture time unavailable."),
  );
  assert.equal(
    await backfillChangelog(
      annotated,
      fixtureConfiguration,
      path,
      "synthetic-token",
      unavailableAuthor,
    ),
    annotated,
  );
});
