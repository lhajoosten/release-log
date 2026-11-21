import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { publishGitHubRelease, ReleasePublicationError } from "../src/release-publication.ts";
import { publisher } from "./publication-fixture.ts";

void test("GitHub publication defaults to read-only dry-run and validates exact local assets", async (context) => {
  const state = await publisher(context);
  const result = await publishGitHubRelease(state.request, state.transport);

  assert.equal(result.mode, "dry-run");
  assert.equal(result.inspection.complete, false);
  assert.deepEqual(result.performed, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(
    result.inspection.actions.map((action) => action.kind),
    ["create-tag", "create-draft-release", "upload-asset", "publish-release"],
  );
});

void describe("GitHub publication writes and recovery", { concurrency: 4 }, () => {
  for (const mergeKind of ["merge", "squash"] as const)
    for (const bootstrap of [false, true]) {
      void test(`${mergeKind}/${bootstrap ? "bootstrap" : "released"}: GitHub publication executes exact approved outputs once`, async (context) => {
        const state = await publisher(context, mergeKind, bootstrap);
        const result = await publishGitHubRelease(
          { ...state.request, write: true },
          state.transport,
        );

        assert.equal(result.mode, "write");
        assert.equal(result.inspection.complete, true);
        assert.equal(result.inspection.landingSha, state.landing);
        assert.deepEqual(
          result.performed.map((action) => action.kind),
          ["create-tag", "create-draft-release", "upload-asset", "publish-release"],
        );
        assert.equal(state.writes.length, 4);
        assert.ok(
          state.writes.every(
            (write) => !write.url.includes("attacker.invalid") && !write.url.includes("ghcr.io"),
          ),
        );
        assert.ok(!JSON.stringify(result).includes("synthetic-github-secret"));
        assert.ok(!JSON.stringify(result).includes("synthetic-registry-secret"));

        const retried = await publishGitHubRelease(
          { ...state.request, write: true },
          state.transport,
        );

        assert.equal(retried.inspection.complete, true);
        assert.deepEqual(retried.performed, []);
        assert.equal(state.writes.length, 4);
      });
    }

  for (const phase of ["git/refs", "/releases", "/assets?", "/releases/99"]) {
    void test(`an uncertain ${phase} write stops; a fresh retry reuses the confirmed remote result`, async (context) => {
      const state = await publisher(context);
      let failed = false;

      state.onWrite((url, after) => {
        const matches =
          phase === "/releases" || phase === "/releases/99"
            ? url.endsWith(phase)
            : url.includes(phase);

        if (after && matches && !failed) {
          failed = true;
          throw new Error("synthetic-github-secret must not be exposed");
        }

        return null;
      });

      await assert.rejects(
        publishGitHubRelease({ ...state.request, write: true }, state.transport),
        (error: unknown) =>
          error instanceof ReleasePublicationError &&
          error.code === "write-failed" &&
          /inspect remote state/u.test(error.message) &&
          !error.message.includes("synthetic-github-secret"),
      );
      assert.equal(failed, true);

      const count = state.writes.length;
      const result = await publishGitHubRelease({ ...state.request, write: true }, state.transport);

      assert.equal(result.inspection.complete, true);
      assert.equal(count + result.performed.length, 4);
      assert.equal(state.writes.length, 4);
    });
  }

  for (const status of [301, 401, 403, 422, 429, 500]) {
    void test(`asset upload HTTP ${status} stops before publishing and preserves recovery state`, async (context) => {
      const state = await publisher(context);

      state.onWrite((url, after) =>
        !after && url.startsWith("https://uploads.github.com/")
          ? new Response("synthetic-github-secret", {
              status,
              headers: { location: "https://attacker.invalid/never-follow" },
            })
          : null,
      );

      await assert.rejects(
        publishGitHubRelease({ ...state.request, write: true }, state.transport),
        (error: unknown) =>
          error instanceof ReleasePublicationError &&
          error.code === "write-failed" &&
          !error.message.includes("synthetic-github-secret"),
      );
      assert.equal(state.remote.release?.draft, true);
      assert.equal(state.remote.assets.length, 0);
      assert.ok(!state.writes.some((write) => write.method === "PATCH"));
      assert.equal(
        state.writes.filter((write) => write.url.startsWith("https://uploads.github.com/")).length,
        1,
      );
    });
  }
});
