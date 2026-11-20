import assert from "node:assert/strict";
import { test } from "node:test";

import { planPublicationActions } from "../src/publication/plan.ts";
import type { PublicationReceipt, PublicationState } from "../src/publication/types.ts";

void test("publication planning orders missing actions and retains trusted artifact evidence", () => {
  const image = { name: "ghcr.io/example/app", digest: `sha256:${"d".repeat(64)}` };
  const receipt: PublicationReceipt = {
    schemaVersion: 1,
    approvalVerificationId: "a".repeat(64),
    landingSha: "b".repeat(40),
    assets: [{ name: "release.tgz", sha256: "c".repeat(64), size: 42 }],
    images: [image],
  };
  const state: PublicationState = {
    tag: null,
    release: null,
    images: [{ name: "ghcr.io/example/app", digest: null }],
  };
  const intent = { tag: "v1.0.0", landingSha: receipt.landingSha, notes: "abc" };

  assert.deepEqual(planPublicationActions(state, receipt, intent), [
    { kind: "create-tag", tag: intent.tag, commitSha: receipt.landingSha },
    {
      kind: "create-draft-release",
      tag: intent.tag,
      notesSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
    { kind: "upload-asset", ...receipt.assets[0] },
    { kind: "publish-image", ...receipt.images[0], tag: intent.tag },
    { kind: "publish-release", releaseId: null },
  ]);

  assert.deepEqual(
    planPublicationActions(
      {
        tag: { objectSha: receipt.landingSha, commitSha: receipt.landingSha },
        release: { id: 7, draft: true, assetIds: [{ name: "release.tgz", id: 9 }] },
        images: [{ name: "ghcr.io/example/app", digest: image.digest }],
      },
      receipt,
      intent,
    ),
    [{ kind: "publish-release", releaseId: 7 }],
  );
});
