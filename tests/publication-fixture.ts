import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { renderChangelog } from "../src/changelog.ts";
import type { GitHubRead } from "../src/github.ts";
import { verifyReleaseApproval } from "../src/release-approval.ts";
import type { ReleaseApproval } from "../src/release-approval.ts";
import type { PublicationPolicy, PublicationReceipt } from "../src/release-publication.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { botId, fixture, json, object, text } from "./proposal-fixture.ts";

const approvalPolicy = { schemaVersion: 1 as const, botUserId: botId, approverUserIds: [7] };
export const publicationPolicy: PublicationPolicy = {
  schemaVersion: 1,
  assets: ["release-log.tgz"],
  images: ["ghcr.io/example/project"],
};
const assetSHA = "a".repeat(64);

export async function publication(
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

    return remote.release;
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

export async function publisher(
  context: TestContext,
  mergeKind: "merge" | "squash" = "merge",
  bootstrap = false,
) {
  const state = await publication(context, mergeKind, bootstrap);
  const bytes = Buffer.from("trusted packaged CLI bytes\n");
  const assetDirectory = join(state.f.directory, "artifacts");
  const asset = {
    name: "release-log.tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };

  await mkdir(assetDirectory);
  await writeFile(join(assetDirectory, asset.name), bytes);

  state.remote.imageStatus = 200;

  const writes: { url: string; method: string; body: unknown }[] = [];
  let intercept: ((url: string, after: boolean) => Response | null) | null = null;
  const transport: GitHubRead = async (url, options) => {
    if (options.method === "GET" || options.method === undefined)
      return state.transport(url, options);

    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer synthetic-github-secret",
    );
    assert.equal(options.redirect, "error");
    writes.push({ url, method: options.method, body: options.body });

    const before = intercept?.(url, false);

    if (before) return before;

    let response: Response;

    if (url === "https://api.github.com/repos/example/project/git/refs") {
      assert.equal(options.method, "POST");
      assert.equal(typeof options.body, "string");
      assert.deepEqual(JSON.parse(text(options.body)), {
        ref: `refs/tags/${state.tag}`,
        sha: state.landing,
      });
      assert.equal(state.remote.tag, null);
      state.tagPresent();
      response = json(state.remote.tag, 201);
    } else if (url === "https://api.github.com/repos/example/project/releases") {
      const body = object(JSON.parse(text(options.body)));

      assert.equal(options.method, "POST");
      assert.equal(state.remote.release, null);
      assert.equal(body.target_commitish, state.landing);
      assert.equal(body.draft, true);
      assert.equal(body.prerelease, false);
      assert.equal(body.generate_release_notes, false);
      assert.equal(body.make_latest, "false");
      const created = state.releasePresent(true);

      assert.equal(body.body, created.body);
      Object.assign(created, { upload_url: "https://attacker.invalid/never-use" });
      response = json(created, 201);
    } else if (
      url ===
      "https://uploads.github.com/repos/example/project/releases/99/assets?name=release-log.tgz"
    ) {
      assert.equal(options.method, "POST");
      assert.equal(new Headers(options.headers).get("content-type"), "application/octet-stream");
      assert.ok(options.body instanceof Uint8Array);
      assert.deepEqual(Buffer.from(options.body), bytes);
      assert.ok(!state.remote.assets.some((entry) => entry.name === asset.name));
      const uploaded = {
        id: 10,
        name: asset.name,
        size: asset.size,
        digest: `sha256:${asset.sha256}`,
        state: "uploaded",
      };

      state.remote.assets.push(uploaded);
      response = json(uploaded, 201);
    } else if (url === "https://api.github.com/repos/example/project/releases/99") {
      assert.equal(options.method, "PATCH");
      assert.deepEqual(JSON.parse(text(options.body)), { draft: false, make_latest: "false" });
      assert.ok(state.remote.release && state.remote.release.draft === true);
      assert.equal(state.remote.assets.length, 1);
      state.remote.release.draft = false;
      response = json(state.remote.release);
    } else {
      assert.fail(`Unexpected publication write: ${url}`);
    }

    return intercept?.(url, true) ?? response;
  };

  return {
    ...state,
    bytes,
    asset,
    writes,
    transport,
    request: { ...state.request, receipt: { ...state.receipt, assets: [asset] }, assetDirectory },
    onWrite(callback: typeof intercept) {
      intercept = callback;
    },
  };
}
