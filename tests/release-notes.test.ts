import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderReleaseNotes } from "../src/release-notes.ts";
import { captureReleaseSnapshot, serializeReleaseSnapshot } from "../src/release-snapshot.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const released = { kind: "released", currentVersion: "1.2.3" } as const;
const initial = { kind: "bootstrap", initialVersion: "0.1.0" } as const;

const digest = (notes: string) => createHash("sha256").update(notes).digest("hex");

void test("notes use planned groups and preserve warnings and actions across audiences", async () => {
  const fixture = await releaseFixture([
    {
      title: "feat(rows): export selected rows",
      summary: "Export selected rows.",
      impact: "Download just the selected rows.",
    },
    {
      title: "fix(rows): resume downloads",
      summary: "Resume interrupted exports.",
      impact: "Downloads continue from the last checkpoint.",
    },
    {
      title: "chore(cache)!: drop legacy directory",
      message:
        "chore!: change cache directory\n\nBREAKING CHANGE: The legacy cache directory is ignored.",
      audience: "internal",
      action: "Move the cache before upgrading.",
      summary: "Private cache redesign.",
    },
    {
      title: "docs(cli): describe output",
      summary: "Document the output.",
      impact: "See which formats are available.",
    },
    {
      title: "chore(worker): update worker",
      audience: "internal",
      action: "Restart workers after upgrading.",
      summary: "Private worker redesign.",
    },
    {
      title: "fix(auth)!: remove legacy authentication",
      summary: "Unused summary.",
      action: "Unused action.",
    },
  ]);
  const config = { ...fixtureConfiguration, contextPolicy: "optional" as const };
  const snapshot = await captureReleaseSnapshot(
    {
      ...fixture.snapshot.input,
      pullRequests: fixture.snapshot.input.pullRequests.map((pull) =>
        pull.number === 6 ? { ...pull, body: "Raw PR description must stay private." } : pull,
      ),
    },
    config,
  );
  const notes = await renderReleaseNotes(
    await serializeReleaseSnapshot(snapshot),
    config,
    released,
  );
  assert.equal(
    notes,
    `# Release notes for v2.0.0

> Draft for maintainer review.

Snapshot ID: ${snapshot.snapshotId}
Contract: release-notes-v1

## Breaking changes

- The legacy cache directory is ignored. drop legacy directory. ([#3](https://github.com/example/project/pull/3))
- remove legacy authentication. ([#6](https://github.com/example/project/pull/6))

## Required actions

- Move the cache before upgrading. ([#3](https://github.com/example/project/pull/3))
- Restart workers after upgrading. ([#5](https://github.com/example/project/pull/5))
- Migration instructions are missing. Review the linked source. ([#6](https://github.com/example/project/pull/6))

## Improvements

- Export selected rows. Download just the selected rows. ([#1](https://github.com/example/project/pull/1))

## Fixes

- Resume interrupted exports. Downloads continue from the last checkpoint. ([#2](https://github.com/example/project/pull/2))

## Other changes

- Document the output. See which formats are available. ([#4](https://github.com/example/project/pull/4))

## Needs review

- remove legacy authentication. Audience and impact are unknown because release context is missing. ([#6](https://github.com/example/project/pull/6))
`,
  );
});

void test("historical gaps, usable context and warnings retain the real PR or commit reference", async () => {
  const fixture = await releaseFixture(
    [
      { title: "feat(api): add export", summary: "Export rows.", impact: "Download a copy." },
      { title: "fix(api): fix export", summary: "Discard this malformed context." },
      {
        title: "chore(cache): migrate cache",
        audience: "internal",
        summary: "Private historical cache.",
        action: "Move the historical cache.",
      },
    ],
    null,
    ["fix!: change defaults\n\nBREAKING CHANGE: Specify the startup mode."],
  );
  const config = {
    ...fixtureConfiguration,
    schemaVersion: 2 as const,
    bootstrap: {
      baselineSha: fixture.snapshot.input.range.baseline.commitSha,
      onboardingSha: fixture.snapshot.input.range.sourceCommitSha,
    },
  };
  const snapshot = await captureReleaseSnapshot(
    {
      ...fixture.snapshot.input,
      pullRequests: fixture.snapshot.input.pullRequests.map((pull) => ({
        ...pull,
        title: "Historical pull request",
        body:
          pull.number === 2 ? pull.body.replace("audience: users", "audience: invalid") : pull.body,
      })),
    },
    config,
  );
  const notes = await renderReleaseNotes(await serializeReleaseSnapshot(snapshot), config, initial);
  assert.ok(notes);
  assert.match(notes, /## Other changes\n\n- Export rows\. Download a copy\. \(\[#1\]/u);
  assert.match(notes, /## Needs review\n\n- Metadata review: .*\[#1\]/u);
  assert.match(notes, /context is unusable\. Metadata review: .*\[#2\]/u);
  assert.match(notes, /Metadata review: .*\[#3\]/u);
  assert.match(notes, /Move the historical cache\. .*\[#3\]/u);
  assert.match(notes, /Specify the startup mode\. .*\/commit\/0{39}1\)/u);
  assert.doesNotMatch(notes, /Discard this malformed context|Private historical cache/u);

  const bootstrap = await renderReleaseNotes(fixture.serialized, fixtureConfiguration, initial);
  assert.match(bootstrap ?? "", /context is missing\. .*\/commit\/0{39}1\)/u);
});

void test("authored Markdown stays literal and only generated source links are active", async () => {
  const hostile = "<img src=x> ![image](https://bad.example) [click](https://bad.example)";
  const fixture = await releaseFixture([
    {
      title: "feat(ui)!: change the reader",
      summary: hostile,
      impact: "## Forged heading\nSnapshot ID: forged &lt; www.bad.example",
      action: "[^trap] <https://bad.example> `command`",
      message: "feat!: change the reader\n\nBREAKING CHANGE: <!-- hidden -->",
    },
  ]);
  const notes = await renderReleaseNotes(fixture.serialized, fixtureConfiguration, released);
  assert.ok(notes);
  const tree = JSON.stringify(fromMarkdown(notes), (key, value: unknown) =>
    key === "position" ? undefined : value,
  );
  assert.doesNotMatch(tree, /"type":"(?:html|image|definition|linkReference|inlineCode)"/u);
  assert.equal(tree.match(/"type":"link"/gu)?.length, 3);
  assert.equal(tree.match(/"url":"https:\/\/github\.com\/example\/project\/pull\/1"/gu)?.length, 3);
  assert.ok(tree.includes(hostile));
  assert.ok(tree.includes("## Forged heading Snapshot ID: forged &lt; www.bad.example"));
  assert.equal(notes.match(/^Snapshot ID:/gmu)?.length, 1);
});

void test("draft bytes repeat and change when review evidence or the saved file changes", async () => {
  const fixture = await releaseFixture([{ title: "fix(api): restore exports" }]);
  const config = { ...fixtureConfiguration, changelog: { verbosity: "one-liner" as const } };
  const capture = async (capturedAt: string) =>
    serializeReleaseSnapshot(
      await captureReleaseSnapshot(fixture.snapshot.input, config, capturedAt),
    );
  const first = await capture("2026-11-16T20:34:56.789Z");
  const second = await capture("2026-11-16T20:34:57.789Z");
  const draft = await renderReleaseNotes(first, config, released);
  const refreshed = await renderReleaseNotes(second, config, released);
  assert.ok(draft && refreshed);
  assert.equal(await renderReleaseNotes(first, config, released), draft);
  assert.match(draft, /Preserve selected rows\. Keep the selection\./u);
  assert.notEqual(refreshed, draft);
  assert.equal(
    refreshed.replace(/^Snapshot ID: .*$/mu, ""),
    draft.replace(/^Snapshot ID: .*$/mu, ""),
  );
  assert.notEqual(digest(refreshed), digest(draft));
  assert.notEqual(digest(draft + "\n"), digest(draft));
});

void test("notes distinguish a no-release plan from a release with no visible entries", async () => {
  const maintenance = await releaseFixture([
    { title: "chore(api): maintain implementation", audience: "internal" },
  ]);
  const internalFix = await releaseFixture([
    { title: "fix(api): maintain implementation", audience: "internal" },
  ]);
  assert.equal(
    await renderReleaseNotes(maintenance.serialized, fixtureConfiguration, released),
    null,
  );
  const notes = await renderReleaseNotes(internalFix.serialized, fixtureConfiguration, released);
  assert.match(notes ?? "", /\n\nNo user-facing changes or required actions were recorded\.\n$/u);
  assert.doesNotMatch(notes ?? "", /\/pull\/|^## /mu);
});
