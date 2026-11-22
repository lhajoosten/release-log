import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { GitHubRead } from "../src/github.ts";
import { verifyReleaseApproval } from "../src/release-approval.ts";
import { publishGitHubRelease, ReleasePublicationError } from "../src/release-publication.ts";
import { json } from "./proposal-fixture.ts";
import { publicationPolicy, publisher } from "./publication-fixture.ts";
import { readinessFixture } from "./readiness-fixture.ts";

void test("a denied tag write has no side effects or automatic retry", async (context) => {
  const state = await publisher(context);

  state.onWrite((_url, after) =>
    !after ? json({ message: "synthetic-github-secret" }, 403) : null,
  );

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    (error: unknown) =>
      error instanceof ReleasePublicationError &&
      error.code === "write-failed" &&
      /permissions/u.test(error.message) &&
      !error.message.includes("synthetic-github-secret"),
  );
  assert.equal(state.writes.length, 1);
  assert.equal(state.remote.tag, null);
  assert.equal(state.remote.release, null);
});

void test("upload success with a different digest is uncertain and leaves the draft unpublished", async (context) => {
  const state = await publisher(context);

  state.onWrite((url, after) =>
    after && url.startsWith("https://uploads.github.com/")
      ? json({ ...state.remote.assets[0], digest: "sha256:" + "0".repeat(64) }, 201)
      : null,
  );

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /inconsistent identity\/bytes/u,
  );
  assert.equal(state.remote.release?.draft, true);
  assert.ok(!state.writes.some((write) => write.method === "PATCH"));
});

void test("an image disappearing after tag creation stops subsequent GitHub writes", async (context) => {
  const state = await publisher(context);

  state.onWrite((_url, after) => {
    if (after) state.remote.imageStatus = 404;
    return null;
  });

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /state changed during execution/u,
  );
  assert.equal(state.writes.length, 1);
  assert.equal(state.remote.release, null);
});

void test("later ordinary main commits never change the publication target", async (context) => {
  const state = await publisher(context);

  await state.f.advance("fix(api): retain a later change");

  const result = await publishGitHubRelease({ ...state.request, write: true }, state.transport);

  assert.equal(result.inspection.landingSha, state.landing);
  assert.notEqual(result.inspection.landingSha, state.f.ref("heads/main"));
  assert.equal(result.inspection.complete, true);
});

void test("concurrent asset replacement at publication is detected, not reported as completion", async (context) => {
  const state = await publisher(context);

  state.onWrite((url, after) => {
    if (after && url.endsWith("/releases/99")) {
      const asset = state.remote.assets[0];

      assert.ok(asset);
      asset.id = 20;
    }

    return null;
  });

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /state changed during execution/u,
  );
  assert.equal(state.writes.length, 4);
  assert.equal(state.remote.release?.draft, false);
});

void test("caller input changes after preflight do not retarget an executing publication", async (context) => {
  const state = await publisher(context);
  const request = { ...state.request, write: true };
  let changed = false;
  const transport: GitHubRead = async (url, options) => {
    if (!changed) {
      changed = true;
      request.repository = "/not-the-approved-repository";
      request.receipt = { ...request.receipt, landingSha: state.source };
    }

    return state.transport(url, options);
  };
  const result = await publishGitHubRelease(request, transport);

  assert.equal(result.inspection.complete, true);
  assert.equal(result.inspection.landingSha, state.landing);
});

void test("strict approval-policy checks are enforced before the publication executor can write", async (context) => {
  const state = await publisher(context);
  const gate = readinessFixture(state.head, state.request.approval.pullNumber, state.transport);
  const verified = await verifyReleaseApproval(
    {
      repository: state.request.repository,
      configuration: state.request.configuration,
      policy: gate.policy,
      approval: state.request.approval,
      token: state.request.token,
    },
    gate.transport,
  );
  const check = gate.checkRuns[0];

  assert.ok(check);
  check.conclusion = "failure";

  await assert.rejects(
    publishGitHubRelease(
      {
        ...state.request,
        approvalPolicy: gate.policy,
        receipt: { ...state.request.receipt, approvalVerificationId: verified.verificationId },
        write: true,
      },
      gate.transport,
    ),
    /trusted App/u,
  );
  assert.deepEqual(state.writes, []);
});

void test("missing configured image roots block every GitHub write", async (context) => {
  const state = await publisher(context);

  state.remote.imageStatus = 404;

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /image roots are missing/u,
  );
  assert.deepEqual(state.writes, []);
});

void test("asset-only publication does not require or forward a registry credential", async (context) => {
  const state = await publisher(context);
  const { registryToken, ...request } = state.request;

  assert.ok(registryToken);

  const result = await publishGitHubRelease(
    {
      ...request,
      publicationPolicy: { ...publicationPolicy, images: [] },
      receipt: { ...request.receipt, images: [] },
      write: true,
    },
    state.transport,
  );

  assert.equal(result.inspection.complete, true);
  assert.ok(!state.calls.some((call) => call.url.startsWith("https://ghcr.io/")));
});

void test("incorrect, missing, linked and oversized local assets fail before remote writes", async (context) => {
  const state = await publisher(context);
  const path = join(state.request.assetDirectory, state.asset.name);

  await writeFile(
    path,
    "incorrect bytes of the same size".slice(0, state.bytes.length).padEnd(state.bytes.length),
  );
  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /trusted build digest/u,
  );
  await assert.rejects(
    publishGitHubRelease(
      { ...state.request, assetDirectory: join(state.f.directory, "missing"), write: true },
      state.transport,
    ),
    /Cannot read ordinary/u,
  );

  const links = join(state.f.directory, "links");

  await mkdir(links);
  await symlink(path, join(links, state.asset.name));
  await assert.rejects(
    publishGitHubRelease({ ...state.request, assetDirectory: links, write: true }, state.transport),
    /ordinary files/u,
  );

  const directoryLink = join(state.f.directory, "directory-link");

  await symlink(state.request.assetDirectory, directoryLink);
  await assert.rejects(
    publishGitHubRelease(
      { ...state.request, assetDirectory: directoryLink, write: true },
      state.transport,
    ),
    /ordinary directory/u,
  );
  await assert.rejects(
    publishGitHubRelease(
      {
        ...state.request,
        receipt: {
          ...state.request.receipt,
          assets: [{ ...state.asset, size: 64 * 1024 * 1024 + 1 }],
        },
        write: true,
      },
      state.transport,
    ),
    /64 MiB/u,
  );
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.calls, []);
});

void test("upload uses the verified in-memory bytes even if the local file changes later", async (context) => {
  const state = await publisher(context);
  const path = join(state.request.assetDirectory, state.asset.name);
  let changed = false;
  const transport: GitHubRead = async (url, options) => {
    if (!changed) {
      changed = true;
      await writeFile(path, "edited after preflight");
    }

    return state.transport(url, options);
  };
  const result = await publishGitHubRelease({ ...state.request, write: true }, transport);

  assert.equal(result.inspection.complete, true);
  assert.equal(await readFile(path, "utf8"), "edited after preflight");
});

void test("an approval edit after a successful write prevents all subsequent writes", async (context) => {
  const state = await publisher(context);

  state.onWrite((_url, after) => {
    if (after) state.pull.body = "Human edit after tag creation";
    return null;
  });

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /metadata|proposal|context/u,
  );
  assert.equal(state.writes.length, 1);
  assert.equal(state.remote.release, null);
});

void test("a reported write without visible progress is not retried in the same execution", async (context) => {
  const state = await publisher(context);

  state.onWrite((url, after) => {
    if (after && url.endsWith("/git/refs")) state.remote.tag = null;
    return null;
  });

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /not confirmed/u,
  );
  assert.equal(state.writes.length, 1);
});

void test("malformed upload success is uncertain and cannot publish a draft", async (context) => {
  const state = await publisher(context);

  state.onWrite((url, after) =>
    after && url.startsWith("https://uploads.github.com/")
      ? new Response("{invalid", { status: 201 })
      : null,
  );

  await assert.rejects(
    publishGitHubRelease({ ...state.request, write: true }, state.transport),
    /incomplete evidence/u,
  );
  assert.equal(state.remote.release?.draft, true);
  assert.equal(state.remote.assets.length, 1);
  assert.ok(!state.writes.some((write) => write.method === "PATCH"));

  state.onWrite(null);

  const result = await publishGitHubRelease({ ...state.request, write: true }, state.transport);

  assert.deepEqual(
    result.performed.map((action) => action.kind),
    ["publish-release"],
  );
});
