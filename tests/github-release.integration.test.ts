import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { reconcileReleaseTag } from "../src/release-tag.ts";
import { selectReleaseCycle } from "../src/release-cycle.ts";
import { reconcileGitHubLatest, taggedReleaseNotes } from "../src/github-release.ts";
import { updateChangelog } from "../src/changelog.ts";
import { fixture, json, object, text } from "./proposal-fixture.ts";
import { GitHubProposalRepository } from "../src/github-proposals.ts";
import { fixtureConfiguration } from "./release-fixture.ts";

async function state(context: TestContext, mergeKind: "merge" | "squash" = "merge") {
  const f = await fixture(context);
  const base = await f.request(true);
  const captured = await replayReleaseSnapshot(base.snapshot, base.configuration);
  const configuration = parseReleaseInputConfiguration({
    ...base.configuration,
    githubRelease: true,
  });
  const snapshot = await serializeReleaseSnapshot(
    await captureReleaseSnapshot(captured.input, configuration),
  );
  const created = await reconcileReleaseProposal({ ...base, configuration, snapshot }, f.transport);
  assert.ok(created.headSha && created.pullNumber);
  const landing = f
    .git(
      [
        "commit-tree",
        f.git(["rev-parse", `${created.headSha}^{tree}`]).trim(),
        "-p",
        created.sourceSha,
        ...(mergeKind === "merge" ? ["-p", created.headSha] : []),
      ],
      "chore: merge release\n",
    )
    .trim();
  f.git(["update-ref", "refs/heads/main", landing]);
  const pull = f.pulls[0];
  assert.ok(pull);
  Object.assign(pull, {
    state: "closed",
    merged_at: "2026-11-16T12:00:00Z",
    merge_commit_sha: landing,
    merged_by: { id: 7, type: "User" },
  });
  let release: Record<string, unknown> | null = null;
  let latest: Record<string, unknown> | null = null;
  let failure = 0;
  let loseResponse = false;
  let intercept: ((method: string, path: string) => void | Promise<void>) | undefined;
  const transport = async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname.slice("/repos/example/project".length);
    const method = options.method ?? "GET";
    await intercept?.(method, path);
    if (path.startsWith("/releases")) {
      const body =
        typeof options.body === "string" ? object(JSON.parse(options.body) as unknown) : null;
      f.calls.push({ method, path, body });
      if (method === "GET") {
        if (failure) return json({}, failure);
        const found = path === "/releases/latest" ? latest : release;
        return found ? json(found) : json({}, 404);
      }
      assert.equal(path, "/releases");
      assert.equal(method, "POST");
      assert.ok(body);
      // Tag creation precedes publication; target_commitish cannot create a new tag.
      assert.equal(f.ref("tags/v1.3.0"), landing);
      if (failure) return json({}, failure);
      release = { id: 100, ...body };
      if (body.make_latest === "true") latest = release;
      if (loseResponse) return json({}, 500);
      return json(release, 201);
    }
    const response = await f.transport(url, options);
    if (!response.ok) return response;
    if (path.startsWith("/git/ref/tags/") || (method === "POST" && path === "/git/refs")) {
      const value = object(await response.json());
      return json(
        { ...value, object: { ...object(value.object), type: "commit" } },
        response.status,
      );
    }
    return response;
  };
  const request = {
    configuration,
    automation: base.automation,
    token: base.token,
    pullNumber: created.pullNumber,
    landingSha: landing,
  };
  return {
    f,
    created,
    landing,
    request,
    transport,
    release(value: Record<string, unknown> | null) {
      release = value;
    },
    latest(value: Record<string, unknown> | null) {
      latest = value;
    },
    failure(value: number) {
      failure = value;
    },
    loseResponse() {
      loseResponse = true;
    },
    intercept(value: typeof intercept) {
      intercept = value;
    },
  };
}

for (const mergeKind of ["merge", "squash"] as const) {
  void test(`${mergeKind}: tagging publishes the verified changelog as latest and retries preserve it`, async (context) => {
    const s = await state(context, mergeKind);
    const dry = await reconcileReleaseTag(s.request, s.transport);
    assert.equal(dry.outcome, "would-create");
    assert.equal(dry.release?.outcome, "would-create");
    assert.equal(s.f.ref("tags/v1.3.0"), null);
    assert.ok(
      s.f.calls.filter((c) => c.path.startsWith("/releases")).every((c) => c.method === "GET"),
    );
    const result = await reconcileReleaseTag({ ...s.request, write: true }, s.transport);
    assert.equal(result.outcome, "created");
    assert.equal(result.release?.outcome, "created");
    assert.equal(s.f.ref("tags/v1.3.0"), s.landing);
    const call = s.f.calls.find((c) => c.path === "/releases" && c.method === "POST");
    assert.ok(call?.body);
    assert.equal(call.body.tag_name, "v1.3.0");
    assert.equal(call.body.target_commitish, s.landing);
    assert.equal(call.body.make_latest, "true");
    assert.equal(call.body.draft, false);
    assert.equal(call.body.prerelease, false);
    assert.equal(call.body.generate_release_notes, false);
    assert.match(text(call.body.body), /^## v1\.3\.0\n/u);
    assert.ok(text(call.body.body).includes("Preserve selected rows&#46;"));
    assert.ok(!text(call.body.body).includes("release-log:pending"));
    const before = s.f.calls.length;
    const retry = await reconcileReleaseTag({ ...s.request, write: true }, s.transport);
    assert.equal(retry.outcome, "unchanged");
    assert.equal(retry.release?.outcome, "unchanged");
    assert.ok(s.f.calls.slice(before).every((c) => c.method === "GET"));
    const cycle = await selectReleaseCycle(
      {
        configuration: s.request.configuration,
        automation: s.request.automation,
        token: s.request.token,
        sourceSha: s.landing,
      },
      s.transport,
    );
    assert.equal(cycle.outcome, "selected");
  });
}

void test("an existing manually published release keeps its notes, name and latest selection", async (context) => {
  const s = await state(context);
  s.release({
    id: 37,
    tag_name: "v1.3.0",
    name: "Human release title",
    body: "Human-written notes",
    draft: false,
    prerelease: false,
  });
  const result = await reconcileReleaseTag({ ...s.request, write: true }, s.transport);
  assert.equal(result.release?.outcome, "unchanged");
  assert.ok(!s.f.calls.some((c) => c.method !== "GET" && c.path.startsWith("/releases")));
});

void test("a missing release after a tag-only partial run blocks the next cycle and is recoverable", async (context) => {
  const s = await state(context);
  s.f.git(["tag", "v1.3.0", s.landing]);
  await assert.rejects(
    selectReleaseCycle(
      {
        configuration: s.request.configuration,
        automation: s.request.automation,
        token: s.request.token,
        sourceSha: s.landing,
      },
      s.transport,
    ),
    { code: "github-release-pending" },
  );
  const result = await reconcileReleaseTag({ ...s.request, write: true }, s.transport);
  assert.equal(result.outcome, "unchanged");
  assert.equal(result.release?.outcome, "created");
});

void test("a delayed older tag never replaces a newer latest release", async (context) => {
  const s = await state(context);
  s.latest({ id: 38, tag_name: "v1.4.0", draft: false, prerelease: false });
  await reconcileReleaseTag({ ...s.request, write: true }, s.transport);
  assert.equal(
    s.f.calls.find((c) => c.path === "/releases" && c.method === "POST")?.body?.make_latest,
    "false",
  );
});

for (const conflict of [
  { draft: true, prerelease: false },
  { draft: false, prerelease: true },
  { draft: false, prerelease: false, tag_name: "v9.0.0" },
]) {
  void test(`conflicting release ${JSON.stringify(conflict)} is preserved`, async (context) => {
    const s = await state(context);
    s.release({ id: 39, tag_name: "v1.3.0", ...conflict });
    await assert.rejects(
      reconcileReleaseTag({ ...s.request, write: true }, s.transport),
      /conflicts/u,
    );
    assert.ok(!s.f.calls.some((c) => c.method !== "GET" && c.path.startsWith("/releases")));
  });
}

for (const failure of [403, 429, 500]) {
  void test(`release lookup HTTP ${failure} leaves the exact tag available for recovery`, async (context) => {
    const s = await state(context);
    s.failure(failure);
    await assert.rejects(reconcileReleaseTag({ ...s.request, write: true }, s.transport));
    assert.equal(s.f.ref("tags/v1.3.0"), s.landing);
    assert.ok(!s.f.calls.some((c) => c.method !== "GET" && c.path.startsWith("/releases")));
    s.failure(0);
    assert.equal(
      (await reconcileReleaseTag({ ...s.request, write: true }, s.transport)).release?.outcome,
      "created",
    );
  });
}

void test("an uncertain create response is recovered by reusing the published release without a second POST", async (context) => {
  const s = await state(context);
  s.loseResponse();
  await assert.rejects(reconcileReleaseTag({ ...s.request, write: true }, s.transport));
  assert.equal(
    (await reconcileReleaseTag({ ...s.request, write: true }, s.transport)).release?.outcome,
    "unchanged",
  );
  assert.equal(s.f.calls.filter((c) => c.path === "/releases" && c.method === "POST").length, 1);
});

void test("tag changes during release lookup prevent publication", async (context) => {
  const s = await state(context);
  let reads = 0;
  s.intercept((method, path) => {
    if (method === "GET" && path === "/releases/tags/v1.3.0" && ++reads === 1)
      s.f.git(["update-ref", "refs/tags/v1.3.0", s.created.sourceSha]);
  });
  await assert.rejects(
    reconcileReleaseTag({ ...s.request, write: true }, s.transport),
    /changed before/u,
  );
  assert.ok(!s.f.calls.some((c) => c.method !== "GET" && c.path.startsWith("/releases")));
});

void test("only the verified section becomes release notes, with history and edited markers rejected", () => {
  const section = "## v1.3.0\n\n### Features\n\n- Reviewed change.\n";
  const changelog = updateChangelog("# Changelog\n\n## v1.2.3\n\nHistorical prose.\n", section);
  assert.equal(taggedReleaseNotes(changelog, "1.3.0"), section);
  for (const value of [
    changelog.replace("Reviewed change.", "Edited prose."),
    changelog.replace("pending:end", "pending:bad"),
    "# Changelog\n\n" + section,
  ])
    assert.throws(() => taggedReleaseNotes(value, "1.3.0"));
  assert.throws(() => taggedReleaseNotes(changelog, "1.2.3"));
});

void test("self-publication repairs GitHub latest independently and retains a newer release", async () => {
  const notes = "## v1.3.0\n\nVerified notes.\n";
  const version = {
    id: 100,
    tag_name: "v1.3.0",
    name: "v1.3.0",
    body: notes,
    draft: false,
    prerelease: false,
  };
  const newer = { ...version, id: 101, tag_name: "v1.4.0", name: "v1.4.0" };
  let latest: typeof version | null = null;
  let writes = 0;
  const api = new GitHubProposalRepository(
    fixtureConfiguration,
    42,
    "synthetic-token",
    async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/releases/latest")) return latest ? json(latest) : json({}, 404);
      if (path.endsWith("/releases/tags/v1.3.0")) return json(version);
      assert.equal(options.method, "PATCH");
      assert.ok(path.endsWith("/releases/100"));
      assert.equal(options.body, '{"make_latest":"true"}');
      writes++;
      latest = version;
      return json(version);
    },
  );
  const run = (beforeWrite: () => Promise<void> = async () => {}) =>
    reconcileGitHubLatest(api, version.tag_name, notes, beforeWrite);
  assert.equal(await run(), "updated");
  assert.equal(await run(), "unchanged");
  latest = null;
  assert.equal(
    await run(async () => {
      latest = newer;
    }),
    "retained-newer",
  );
  assert.equal(await run(), "retained-newer");
  latest = { ...version, id: 99 };
  await assert.rejects(run(), /conflicts/u);
  assert.equal(writes, 1);
});
