import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  inspectReleasePublication,
  parsePublicationPolicy,
  parsePublicationReceipt,
  ReleasePublicationError,
} from "../src/release-publication.ts";
import { publication, publicationPolicy } from "./publication-fixture.ts";

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
