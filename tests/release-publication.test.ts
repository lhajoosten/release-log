import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { renderChangelog } from "../src/changelog.ts";
import type { GitHubRead } from "../src/github.ts";
import { verifyReleaseApproval } from "../src/release-approval.ts";
import type { ReleaseApproval } from "../src/release-approval.ts";
import {
  inspectReleasePublication,
  parsePublicationPolicy,
  parsePublicationReceipt,
  ReleasePublicationError,
} from "../src/release-publication.ts";
import type { PublicationPolicy, PublicationReceipt } from "../src/release-publication.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { botId, fixture, json } from "./proposal-fixture.ts";

const approvalPolicy = { schemaVersion: 1 as const, botUserId: botId, approverUserIds: [7] };
const publicationPolicy: PublicationPolicy = {
  schemaVersion: 1,
  assets: ["release-log.tgz"],
  images: ["ghcr.io/example/project"],
};
const assetSHA = "a".repeat(64);

async function publication(
  context: TestContext,
  mergeKind: "merge" | "squash" = "merge",
  bootstrap = false,
) {
  const f = await fixture(
    context,
    "both",
    "feat(api): export rows",
    bootstrap ? { bootstrap: true, adoption: true } : {},
  );
  const proposal = await f.request(true);
  const result = await reconcileReleaseProposal(proposal, f.transport);

  assert.ok(result.headSha && result.pullNumber && result.proposalId);

  const head = result.headSha;
  const source = result.sourceSha;
  const version = bootstrap ? "0.1.0" : "1.3.0";
  const tag = `v${version}`;
  const tree = f.git(["rev-parse", `${head}^{tree}`]).trim();
  const landing = f
    .git(
      ["commit-tree", tree, "-p", source, ...(mergeKind === "merge" ? ["-p", head] : [])],
      mergeKind === "merge" ? "Merge the reviewed release\n" : `chore: prepare v${version}\n`,
    )
    .trim();
  const pull = f.pulls[0];

  assert.ok(pull);

  f.git(["update-ref", "refs/heads/main", landing, source]);
  Object.assign(pull, {
    state: "closed",
    merged_at: "2026-11-09T14:00:00Z",
    merge_commit_sha: landing,
    merged_by: { id: 7, type: "User" },
  });

  const approval: ReleaseApproval = {
    schemaVersion: 1,
    repositoryId: 17,
    pullNumber: result.pullNumber,
    approverUserId: 7,
    sourceSha: source,
    headSha: head,
    landingSha: landing,
    mergeKind,
    baseline: bootstrap
      ? { kind: "bootstrap", commitSha: f.baseline }
      : { kind: "tag", name: "v1.2.3", objectSha: f.baseline, commitSha: f.baseline },
    snapshotId: result.snapshotId,
    proposalId: result.proposalId,
  };
  const verified = await verifyReleaseApproval(
    {
      repository: f.directory,
      configuration: proposal.configuration,
      policy: approvalPolicy,
      approval,
      token: "synthetic-github-secret",
    },
    f.transport,
  );
  const notes = await renderChangelog(proposal.snapshot, proposal.configuration, proposal.version);

  assert.ok(notes);

  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: "sha256:" + "c".repeat(64),
      size: 2,
    },
    layers: [],
  });
  const imageDigest = "sha256:" + createHash("sha256").update(manifest).digest("hex");
  const receipt: PublicationReceipt = {
    schemaVersion: 1,
    approvalVerificationId: verified.verificationId,
    landingSha: landing,
    assets: [{ name: "release-log.tgz", sha256: assetSHA, size: 1024 }],
    images: [{ name: "ghcr.io/example/project", digest: imageDigest }],
  };
  const remote: {
    tag: Record<string, unknown> | null;
    release: Record<string, unknown> | null;
    assets: Record<string, unknown>[];
    imageStatus: number;
    manifest: string;
    declaredDigest: string | null;
    nextAssets: boolean;
  } = {
    tag: null,
    release: null,
    assets: [],
    imageStatus: 404,
    manifest,
    declaredDigest: imageDigest,
    nextAssets: false,
  };
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  let intercept: ((url: string) => Response | null) | null = null;
  const transport: GitHubRead = async (url, options) => {
    const headers = new Headers(options.headers);

    calls.push({
      url,
      method: options.method ?? "GET",
      authorization: headers.get("authorization"),
    });

    const replacement = intercept?.(url);

    if (replacement) return replacement;

    if (url.startsWith("https://ghcr.io/")) {
      assert.equal(url, `https://ghcr.io/v2/example/project/manifests/${tag}`);
      assert.equal(headers.get("authorization"), "Bearer synthetic-registry-secret");
      assert.equal(options.redirect, "error");

      return new Response(remote.manifest, {
        status: remote.imageStatus,
        headers:
          remote.declaredDigest === null ? {} : { "docker-content-digest": remote.declaredDigest },
      });
    }

    assert.ok(url.startsWith("https://api.github.com/repos/example/project"));
    assert.equal(headers.get("authorization"), "Bearer synthetic-github-secret");

    const target = new URL(url);
    const path = target.pathname.slice("/repos/example/project".length);

    if (path === `/git/ref/tags/${tag}`)
      return remote.tag === null ? json({}, 404) : json(remote.tag);
    if (path === `/releases/tags/${tag}`)
      return remote.release === null ? json({}, 404) : json(remote.release);
    if (path === "/releases/99/assets")
      return json(
        remote.assets,
        200,
        remote.nextAssets ? { link: '<https://attacker.invalid/not-followed>; rel="next"' } : {},
      );

    return f.transport(url, options);
  };

  function tagPresent() {
    remote.tag = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: landing } };
  }

  function releasePresent(draft = false) {
    tagPresent();
    remote.release = {
      id: 99,
      tag_name: tag,
      name: tag,
      body: notes,
      draft,
      prerelease: false,
      target_commitish: "main",
    };
  }

  function assetsPresent() {
    remote.assets = [
      {
        id: 10,
        name: "release-log.tgz",
        size: 1024,
        state: "uploaded",
        digest: `sha256:${assetSHA}`,
      },
    ];
  }

  return {
    f,
    pull,
    head,
    source,
    landing,
    version,
    tag,
    receipt,
    remote,
    calls,
    transport,
    tagPresent,
    releasePresent,
    assetsPresent,
    intercept(callback: typeof intercept) {
      intercept = callback;
    },
    request: {
      repository: f.directory,
      configuration: proposal.configuration,
      approvalPolicy,
      approval,
      publicationPolicy,
      receipt,
      token: "synthetic-github-secret",
      registryToken: "synthetic-registry-secret",
    },
  };
}

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

void test("registry transport and interrupted-body failures do not expose secrets or accept partial state", async (context) => {
  const state = await publication(context);

  for (const interruptedBody of [false, true]) {
    state.intercept((url) => {
      if (!url.startsWith("https://ghcr.io/")) return null;
      if (!interruptedBody) throw new Error("synthetic-registry-secret");

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"schemaVersion":2'));
            controller.error(new Error("synthetic-registry-secret"));
          },
        }),
      );
    });

    await assert.rejects(
      inspectReleasePublication(state.request, state.transport),
      (error: unknown) =>
        error instanceof ReleasePublicationError &&
        error.code === "read-failed" &&
        !error.message.includes("synthetic-registry-secret"),
    );
  }
});

for (const status of [206, 301, 401, 403, 429, 500]) {
  void test(`GHCR HTTP ${status} is an actionable failure, not a missing image or leaked credential`, async (context) => {
    const state = await publication(context);

    state.remote.imageStatus = status;
    state.remote.manifest = "synthetic-registry-secret must not appear";

    await assert.rejects(
      inspectReleasePublication(state.request, state.transport),
      (error: unknown) =>
        error instanceof ReleasePublicationError &&
        error.code === "read-failed" &&
        !error.message.includes("synthetic-registry-secret"),
    );
  });
}

void test("registry digest disagreement, unsupported media and oversized bodies cannot complete an image", async (context) => {
  const state = await publication(context);

  state.remote.imageStatus = 200;
  state.remote.declaredDigest = "sha256:" + "0".repeat(64);

  await assert.rejects(
    inspectReleasePublication(state.request, state.transport),
    /inconsistent manifest/u,
  );

  state.remote.declaredDigest = null;
  state.remote.manifest = JSON.stringify({ schemaVersion: 2, mediaType: "text/plain" });

  await assert.rejects(inspectReleasePublication(state.request, state.transport), /unsupported/u);

  state.remote.manifest = "a".repeat(4 * 1024 * 1024 + 1);

  await assert.rejects(inspectReleasePublication(state.request, state.transport), /4 MiB/u);
});

void test("registry manifest structure and UTF-8 must be valid even when the receipt matches its bytes", async (context) => {
  const state = await publication(context);
  const descriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:" + "c".repeat(64),
    size: 200,
  };
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [descriptor],
  };

  state.releasePresent(false);
  state.assetsPresent();
  state.remote.imageStatus = 200;
  state.remote.declaredDigest = null;

  for (const manifest of [
    index,
    { ...index, mediaType: "application/vnd.docker.distribution.manifest.list.v2+json" },
    { ...index, manifests: [] },
    { ...index, manifests: [{ ...descriptor, digest: "latest" }] },
    { ...index, manifests: [{ ...descriptor, size: -1 }] },
    { ...index, manifests: [{ ...descriptor, mediaType: "not a media type" }] },
    { ...index, manifests: Array.from({ length: 1001 }, () => descriptor) },
    { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" },
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: descriptor,
      layers: [{}],
    },
  ]) {
    state.remote.manifest = JSON.stringify(manifest);

    const request = {
      ...state.request,
      receipt: {
        ...state.receipt,
        images: [
          {
            name: "ghcr.io/example/project",
            digest: "sha256:" + createHash("sha256").update(state.remote.manifest).digest("hex"),
          },
        ],
      },
    };

    if (
      manifest === index ||
      manifest.mediaType === "application/vnd.docker.distribution.manifest.list.v2+json"
    )
      assert.equal((await inspectReleasePublication(request, state.transport)).complete, true);
    else
      await assert.rejects(
        inspectReleasePublication(request, state.transport),
        /unsupported or inconsistent/u,
      );
  }

  const invalid = Buffer.concat([
    Buffer.from('{"value":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);

  state.intercept((url) => (url.startsWith("https://ghcr.io/") ? new Response(invalid) : null));

  await assert.rejects(
    inspectReleasePublication(
      {
        ...state.request,
        receipt: {
          ...state.receipt,
          images: [
            {
              name: "ghcr.io/example/project",
              digest: "sha256:" + createHash("sha256").update(invalid).digest("hex"),
            },
          ],
        },
      },
      state.transport,
    ),
    /malformed manifest JSON/u,
  );
});

void test("policy/receipt binding and separate registry credentials are required before reads", async (context) => {
  const state = await publication(context);
  const { registryToken, ...withoutRegistry } = state.request;

  assert.ok(registryToken);

  await assert.rejects(
    inspectReleasePublication(withoutRegistry, state.transport),
    /separate pull-scoped/u,
  );
  await assert.rejects(
    inspectReleasePublication(
      { ...state.request, receipt: { ...state.receipt, assets: [] } },
      state.transport,
    ),
    /every configured artifact/u,
  );
  await assert.rejects(
    inspectReleasePublication(
      { ...state.request, receipt: { ...state.receipt, landingSha: state.source } },
      state.transport,
    ),
    /exact approved landing/u,
  );

  assert.equal(state.calls.length, 0);

  await assert.rejects(
    inspectReleasePublication(
      { ...state.request, receipt: { ...state.receipt, approvalVerificationId: "0".repeat(64) } },
      state.transport,
    ),
    /freshly verified approval/u,
  );
});

void test("publication schema rejects unknown destinations, empty policies and incomplete receipts", () => {
  for (const value of [
    null,
    {},
    { ...publicationPolicy, schemaVersion: "1" },
    { ...publicationPolicy, assets: [], images: [] },
    { ...publicationPolicy, assets: ["../secret"] },
    { ...publicationPolicy, images: ["https://attacker.invalid/image"] },
    { ...publicationPolicy, images: ["ghcr.io/a/../b"] },
    { ...publicationPolicy, assets: ["one.tgz", "one.tgz"] },
    { ...publicationPolicy, publish: true },
  ])
    assert.throws(() => parsePublicationPolicy(value), ReleasePublicationError);

  const receipt = {
    schemaVersion: 1,
    approvalVerificationId: "a".repeat(64),
    landingSha: "b".repeat(40),
    assets: [{ name: "tool.tgz", sha256: "c".repeat(64), size: 100 }],
    images: [],
  };

  for (const value of [
    null,
    {},
    { ...receipt, schemaVersion: 2 },
    { ...receipt, assets: [], images: [] },
    { ...receipt, approvalVerificationId: "short" },
    { ...receipt, assets: [{ ...receipt.assets[0], size: 0 }] },
    { ...receipt, images: [{ name: "ghcr.io/a/b", digest: "latest" }] },
    { ...receipt, complete: true },
  ])
    assert.throws(() => parsePublicationReceipt(value));

  assert.deepEqual(parsePublicationPolicy(publicationPolicy), publicationPolicy);
  assert.deepEqual(parsePublicationReceipt(receipt), receipt);
});
