import assert from "node:assert/strict";
import { test } from "node:test";

import { inspectReleasePublication } from "../src/release-publication.ts";
import { json } from "./proposal-fixture.ts";
import { publication, publicationPolicy } from "./publication-fixture.ts";

for (const mergeKind of ["merge", "squash"] as const)
  for (const bootstrap of [false, true]) {
    void test(`${mergeKind}/${bootstrap ? "bootstrap" : "released"}: inspect missing publication state without writes or a completion claim`, async (context) => {
      const state = await publication(context, mergeKind, bootstrap);
      const before = state.f.git(["status", "--porcelain"]);
      const inspected = await inspectReleasePublication(state.request, state.transport);

      assert.equal(inspected.mode, "read-only");
      assert.equal(inspected.complete, false);
      assert.equal(inspected.version, state.version);
      assert.equal(inspected.landingSha, state.landing);
      assert.deepEqual(
        inspected.actions.map((action) => action.kind),
        ["create-tag", "create-draft-release", "upload-asset", "publish-image", "publish-release"],
      );
      assert.ok(
        inspected.actions.some(
          (action) => action.kind === "create-tag" && action.commitSha === state.landing,
        ),
      );
      assert.deepEqual(await inspectReleasePublication(state.request, state.transport), inspected);
      assert.equal(state.f.git(["status", "--porcelain"]), before);
      assert.ok(state.calls.every((call) => call.method === "GET"));
      assert.ok(!JSON.stringify(inspected).includes("synthetic-github-secret"));
      assert.ok(!JSON.stringify(inspected).includes("synthetic-registry-secret"));
    });
  }

void test("reconciliation resumes only the missing outputs after each publication phase", async (context) => {
  const state = await publication(context);

  state.tagPresent();

  let inspected = await inspectReleasePublication(state.request, state.transport);

  assert.deepEqual(
    inspected.actions.map((action) => action.kind),
    ["create-draft-release", "upload-asset", "publish-image", "publish-release"],
  );
  assert.equal(inspected.complete, false);

  state.releasePresent(true);
  state.assetsPresent();

  inspected = await inspectReleasePublication(state.request, state.transport);

  assert.deepEqual(
    inspected.actions.map((action) => action.kind),
    ["publish-image", "publish-release"],
  );

  state.remote.imageStatus = 200;

  inspected = await inspectReleasePublication(state.request, state.transport);

  assert.deepEqual(inspected.actions, [{ kind: "publish-release", releaseId: 99 }]);
  assert.equal(inspected.complete, false);

  state.releasePresent(false);

  inspected = await inspectReleasePublication(state.request, state.transport);

  assert.equal(inspected.complete, true);
  assert.deepEqual(inspected.actions, []);
  assert.deepEqual(inspected.state.release?.assetIds, [{ name: "release-log.tgz", id: 10 }]);
});

void test("a published release with missing artifacts is still incomplete", async (context) => {
  const state = await publication(context);

  state.releasePresent(false);

  const inspected = await inspectReleasePublication(state.request, state.transport);

  assert.equal(inspected.complete, false);
  assert.deepEqual(
    inspected.actions.map((action) => action.kind),
    ["upload-asset", "publish-image"],
  );
});

void test("configured asset-only publication requires no registry token or registry request", async (context) => {
  const state = await publication(context);
  const { registryToken, ...request } = state.request;

  assert.ok(registryToken);

  const inspected = await inspectReleasePublication(
    {
      ...request,
      publicationPolicy: { ...publicationPolicy, images: [] },
      receipt: { ...state.receipt, images: [] },
    },
    state.transport,
  );

  assert.equal(inspected.complete, false);
  assert.ok(!inspected.actions.some((action) => action.kind === "publish-image"));
  assert.ok(!state.calls.some((call) => call.url.startsWith("https://ghcr.io/")));
});

void test("later main changes do not retarget publication or require tags at a newer HEAD", async (context) => {
  const state = await publication(context);

  state.releasePresent(false);
  state.assetsPresent();
  state.remote.imageStatus = 200;

  const before = await inspectReleasePublication(state.request, state.transport);

  await state.f.advance("fix(api): retain a later ordinary change");

  const after = await inspectReleasePublication(state.request, state.transport);

  assert.deepEqual(after, before);
  assert.equal(after.landingSha, state.landing);
  assert.notEqual(after.landingSha, state.f.ref("heads/main"));
});

void test("annotated tags are peeled and matching immutable targets are reused", async (context) => {
  const state = await publication(context);
  const annotation = "d".repeat(40);

  state.remote.tag = { ref: `refs/tags/${state.tag}`, object: { type: "tag", sha: annotation } };
  state.intercept((url) =>
    url.endsWith(`/git/tags/${annotation}`)
      ? json({ sha: annotation, object: { type: "commit", sha: state.landing } })
      : null,
  );

  const inspected = await inspectReleasePublication(state.request, state.transport);

  assert.deepEqual(inspected.state.tag, { objectSha: annotation, commitSha: state.landing });
  assert.ok(!inspected.actions.some((action) => action.kind === "create-tag"));
});

void test("a wrong tag target, inconsistent release or changed notes fail without proposing an overwrite", async (context) => {
  const state = await publication(context);

  state.remote.tag = {
    ref: `refs/tags/${state.tag}`,
    object: { type: "commit", sha: state.source },
  };

  await assert.rejects(inspectReleasePublication(state.request, state.transport), /never move it/u);

  state.releasePresent(false);

  assert.ok(state.remote.release);

  state.remote.release.body = "Human-edited release notes";

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /do not overwrite/u,
  );

  state.remote.tag = null;

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /without its expected tag/u,
  );
});

for (const tampering of ["digest", "size", "state", "name"] as const) {
  void test(`asset ${tampering} mismatches cannot be treated as successful publication`, async (context) => {
    const state = await publication(context);

    state.releasePresent(false);
    state.assetsPresent();

    const asset = state.remote.assets[0];

    assert.ok(asset);

    asset[tampering] =
      tampering === "digest"
        ? "sha256:" + "0".repeat(64)
        : tampering === "size"
          ? 999
          : tampering === "state"
            ? "starter"
            : "unapproved.txt";

    await assert.rejects(
      inspectReleasePublication(state.request, state.transport),
      /reconcile rather than overwrite/u,
    );
    assert.ok(state.calls.every((call) => call.method === "GET"));
  });
}

void test("malformed successful responses are not interpreted as absent state", async (context) => {
  const state = await publication(context);

  state.intercept((url) => (url.includes(`/releases/tags/${state.tag}`) ? json(null) : null));

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /incomplete proposal evidence/u,
  );
});

void test("asset pagination, duplicate identities and metadata races fail closed", async (context) => {
  const state = await publication(context);

  state.releasePresent(false);
  state.assetsPresent();
  state.remote.nextAssets = true;

  await assert.rejects(inspectReleasePublication(state.request, state.transport), /pagination/u);

  state.remote.nextAssets = false;
  state.remote.assets.push({ ...state.remote.assets[0] });

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /reconcile rather than overwrite/u,
  );

  state.remote.assets.pop();

  let reads = 0;

  state.intercept((url) => {
    if (url.includes(`/releases/tags/${state.tag}`) && ++reads === 2) state.releasePresent(true);

    return null;
  });

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /changed during inspection/u,
  );
});

void test("approval is freshly rechecked after the final publication-state read", async (context) => {
  const state = await publication(context);
  let imageReads = 0;

  state.intercept((url) => {
    if (url.startsWith("https://ghcr.io/") && ++imageReads === 2)
      state.pull.body = "Edited after the publication observations";

    return null;
  });

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /metadata|proposal|context/u,
  );
  assert.equal(imageReads, 2);
  assert.ok(state.calls.every((call) => call.method === "GET"));
});
