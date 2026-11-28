import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse, parseDocument } from "yaml";

void test("release workflows use a reviewed runtime and immutable external actions", async () => {
  for (const name of [
    "release-propose",
    "release-promote",
    "release-publish",
    "changelog-backfill",
  ]) {
    const source = await readFile(
      new URL(`../.github/workflows/${name}.yaml`, import.meta.url),
      "utf8",
    );
    assert.match(source, /ref: \$\{\{ job\.workflow_sha \}\}/u);
    assert.match(source, /persist-credentials: false/u);
    assert.match(source, /pnpm install --frozen-lockfile --ignore-scripts/u);
    assert.ok(
      source.indexOf("Install and build trusted runtime") <
        source.indexOf("Mint scoped repository token"),
    );
    for (const line of source.matchAll(/^\s+uses:\s+([^\s#]+)/gmu))
      assert.match(line[1] ?? "", /@[a-f0-9]{40}$/u);
    assert.ok(parse(source));
  }
});

void test("manual proposal dispatch uses the read-only preview and backfill requires dispatch", async () => {
  const proposal = await readFile(
    new URL("../.github/workflows/release-propose.yaml", import.meta.url),
    "utf8",
  );
  assert.match(proposal, /if: github\.event_name != 'workflow_dispatch'/u);
  assert.match(proposal, /cli\.js" preview/u);
  const backfill = await readFile(
    new URL("../.github/workflows/changelog-backfill.yaml", import.meta.url),
    "utf8",
  );
  assert.match(backfill, /github\.event_name == 'workflow_dispatch'/u);
});

void test("release events queue without replacing pending runs and use scoped callers", async () => {
  for (const name of [
    "release-propose",
    "release-promote",
    "release-publish",
    "changelog-backfill",
  ]) {
    const source = await readFile(
      new URL(`../.github/workflows/${name}.yaml`, import.meta.url),
      "utf8",
    );
    assert.match(source, /queue: max/u);
    assert.match(source, /\$GITHUB_WORKSPACE\/tool\/dist\/src\/cli\.js/u);
  }
  const caller = await readFile(
    new URL("../.github/workflows/release-cycle-caller.yaml", import.meta.url),
    "utf8",
  );
  assert.match(caller, /needs: publish/u);
  assert.match(caller, /refresh: true/u);
  assert.match(caller, /RELEASE_LOG_WRITE_ENABLED/u);
  assert.match(caller, /permissions:\n\s+contents: read\n\s+pull-requests: read/u);
});

void test("provider-only release and image gates use the exact landing while consumer quality is reusable", async () => {
  const promote = await readFile(
    new URL("../.github/workflows/release-promote.yaml", import.meta.url),
    "utf8",
  );
  assert.match(promote, /head_sha=\$LANDING_SHA/u);
  assert.match(promote, /github\.repository_id == '1449550207'/u);
  const quality = await readFile(
    new URL("../.github/workflows/release-quality.yaml", import.meta.url),
    "utf8",
  );
  assert.match(quality, /workflow_call:/u);
  assert.match(quality, /job\.workflow_sha/u);
  assert.match(quality, /ROLLING_RELEASE_START_SHA/u);
  assert.match(quality, /check-proposal/u);
});

void test("provider PR workflows report all three checks required by main", async () => {
  for (const [file, trigger, names] of [
    ["release-quality.yaml", "pull_request", ["verify", "container"]],
    ["pr-metadata.yml", "pull_request_target", ["metadata"]],
  ] as const) {
    const source = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const workflow = parseDocument(source);
    assert.deepEqual(workflow.errors, []);
    for (const name of names) {
      assert.ok(workflow.hasIn(["jobs", name]), `Missing required job ${name}`);
      assert.equal(workflow.getIn(["jobs", name, "name"]) ?? name, name);
    }
    assert.ok(workflow.hasIn(["on", trigger]), `Missing ${trigger} trigger`);
  }
});

void test("manual retry is selected only on main and refreshes after publication", async () => {
  for (const path of [
    "../.github/workflows/release-cycle-caller.yaml",
    "../examples/release-cycle.yaml",
  ]) {
    const workflow = parseDocument(await readFile(new URL(path, import.meta.url), "utf8"));
    assert.deepEqual(workflow.errors, []);
    assert.ok(workflow.hasIn(["on", "workflow_dispatch", "inputs", "retry-pr"]));
    const propose = String(workflow.getIn(["jobs", "propose", "if"]));
    const promote = String(workflow.getIn(["jobs", "promote", "if"]));
    assert.match(propose, /inputs\.retry-pr == ''/u);
    assert.match(promote, /github\.ref == 'refs\/heads\/main'/u);
    for (const job of ["promote", "publish", "refresh"])
      assert.equal(workflow.getIn(["jobs", job, "with", "retry-pr"]), "${{ inputs.retry-pr }}");
    assert.match(
      String(workflow.getIn(["jobs", "refresh", "if"])),
      /needs\.publish\.result == 'success'/u,
    );
  }
});
