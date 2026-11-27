import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { run } from "../src/cli.ts";
import { object, Remote } from "../src/controller/remote.ts";
import { verifyBackfillLanding } from "../src/controller/cycle.ts";

const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

const response = (v: unknown) =>
  v === undefined ? Response.json({}, { status: 404 }) : Response.json(v);

function objectAssignHead(pull: Record<string, unknown>, sha: string) {
  pull.head = { ...object(pull.head), sha };
}

void test("consumer commands refresh a stacked release, verify its landing, recover publication and backfill independently", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-cycle-"));
  const event = join(root, "event");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = "acme/widget",
    bot = "release-app[bot]";
  const variables = {
    GITHUB_TOKEN: "synthetic",
    GITHUB_REPOSITORY: repository,
    ROLLING_RELEASE_ROOT: root,
    ROLLING_RELEASE_PRODUCER_SHA: "f".repeat(40),
    ROLLING_RELEASE_BOT: bot,
    GITHUB_ACTOR: "fixture",
    GHCR_TOKEN: "synthetic",
    GITHUB_EVENT_PATH: event,
    ROLLING_RELEASE_START_SHA: "",
  };
  for (const [key, value] of Object.entries(variables)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const git = (args: string[], input?: string | Buffer, index?: string) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      input,
      env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["commit", "--allow-empty", "-qm", "Start"]);
  const start = git(["rev-parse", "HEAD"]);
  process.env.ROLLING_RELEASE_START_SHA = start;
  const old = "# Changelog\n\n## v1.2.3\n\n- Previously released text.\n";
  writeFileSync(join(root, "CHANGELOG.md"), old);
  writeFileSync(
    join(root, "Cargo.toml"),
    '[workspace]\nmembers = ["crates/core"]\n[workspace.package]\nversion = "1.2.3"\n',
  );
  mkdirSync(join(root, "crates/core"), { recursive: true });
  writeFileSync(
    join(root, "crates/core/Cargo.toml"),
    '[package]\nname = "widget"\nversion.workspace = true\n',
  );
  writeFileSync(
    join(root, "Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "widget"\nversion = "1.2.3"\n',
  );
  mkdirSync(join(root, "packages", "shared λ"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "widget", version: "1.2.3", workspaces: ["packages/*"] }),
  );
  writeFileSync(
    join(root, "packages", "shared λ", "package.json"),
    JSON.stringify({ name: "shared", version: "1.2.3" }),
  );
  git(["add", "CHANGELOG.md", "Cargo.toml", "Cargo.lock", "crates", "package.json", "packages"]);
  git(["commit", "-qm", "Bootstrap"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["tag", "v1.2.3", base]);
  const refs = new Map<string, string>([
    ["heads/main", base],
    ["tags/v1.2.3", base],
  ]);
  const prs = new Map<number, Record<string, unknown>>();
  const links = new Map<string, number[]>(),
    originals = new Map<number, string>();
  const localRepo = { id: 1, full_name: repository };
  const author = { id: 99, type: "Bot", login: bot };
  function register(
    number: number,
    landing: string,
    original: string,
    title: string,
    login: string,
    headRef: string,
    baseRef: string,
    baseSha: string,
    body = "",
  ) {
    const pull = {
      number,
      id: number + 200,
      state: "closed",
      merged: true,
      merged_at: "2026-01-01",
      updated_at: "2026-01-01",
      merge_commit_sha: landing,
      title,
      body,
      commits: 1,
      user: { id: number, login, type: "User" },
      base: { ref: baseRef, sha: baseSha, repo: localRepo },
      head: { ref: headRef, sha: original, repo: localRepo },
    };
    prs.set(number, pull);
    links.set(landing, [number]);
    originals.set(number, original);
  }
  register(40, base, base, "feat: bootstrap", "alice", "bootstrap", "main", start);
  let main = base;
  function land(
    number: number,
    title: string,
    login: string,
    headRef: string,
    baseRef: string,
    originalBase: string,
    action = "",
  ) {
    writeFileSync(join(root, "feature"), String(number));
    git(["add", "feature"]);
    const tree = git(["write-tree"]);
    const original = git(["commit-tree", tree, "-p", originalBase, "-m", title]);
    const landing = git(["commit-tree", tree, "-p", main, "-m", "squash " + number]);
    register(number, landing, original, title, login, headRef, baseRef, originalBase, action);
    main = landing;
    refs.set("heads/main", main);
    git(["reset", "--hard", main]);
    return original;
  }
  const writes: string[] = [];
  let release: Record<string, unknown> | null = null;
  let commitVerified = true;
  let commitAuthor = author;
  let backfillHead = "";
  let failRelease = true,
    imageVersion = false;
  let landing = "";
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input),
      method = init?.method ?? "GET";
    if (url.hostname === "ghcr.io") {
      if (url.pathname === "/token") return Response.json({ token: "fixture" });
      const config = JSON.stringify({
        os: "linux",
        architecture: "amd64",
        config: {
          Labels: {
            "org.opencontainers.image.source": "https://github.com/" + repository,
            "org.opencontainers.image.revision": landing,
            "org.opencontainers.image.version": "1.3.0",
          },
        },
      });
      const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: hash(config) } });
      if (url.pathname.includes("/blobs/")) return new Response(config);
      if (method === "PUT") {
        imageVersion = true;
        writes.push("image");
        return new Response(null, {
          status: 201,
          headers: { "docker-content-digest": hash(manifest) },
        });
      }
      if (url.pathname.endsWith("/v1.3.0") && !imageVersion)
        return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
      return new Response(manifest, {
        headers: {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": hash(manifest),
        },
      });
    }
    assert.equal(url.hostname, "api.github.com");
    const path = url.pathname.slice(("/repos/" + repository + "/").length);
    const data = typeof init?.body === "string" ? object(JSON.parse(init.body)) : {};
    if (method !== "GET") writes.push(method + " " + path);
    if (path.startsWith("git/ref/")) {
      const value = refs.get(path.slice(8));
      return response(value ? { object: { sha: value, type: "commit" } } : undefined);
    }
    if (path.startsWith("git/commits/")) {
      const sha = path.slice(12);
      return response({ sha, tree: { sha: git(["rev-parse", sha + "^{tree}"]) } });
    }
    if (path === "git/blobs")
      return response({
        sha: git(["hash-object", "-w", "--stdin"], Buffer.from(String(data.content), "base64")),
      });
    if (path === "git/trees") {
      const idx = join(root, ".git", "test-index");
      git(["read-tree", String(data.base_tree)], undefined, idx);
      assert.ok(Array.isArray(data.tree));
      for (const item of data.tree) {
        const row = object(item);
        git(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            String(row.mode),
            String(row.sha),
            String(row.path),
          ],
          undefined,
          idx,
        );
      }
      return response({ sha: git(["write-tree"], undefined, idx) });
    }
    if (path === "git/commits") {
      assert.ok(Array.isArray(data.parents));
      return response({
        sha: git([
          "commit-tree",
          String(data.tree),
          ...data.parents.flatMap((p) => ["-p", String(p)]),
          "-m",
          String(data.message),
        ]),
      });
    }
    if (path === "git/refs" || path.startsWith("git/refs/")) {
      const key = path === "git/refs" ? String(data.ref).slice(5) : path.slice(9);
      if (path === "git/refs" && refs.has(key)) return Response.json({}, { status: 422 });
      refs.set(key, String(data.sha));
      git(["update-ref", "refs/" + key, String(data.sha)]);
      for (const pull of prs.values())
        if (pull.state === "open" && key === "heads/" + String(object(pull.head).ref))
          objectAssignHead(pull, String(data.sha));
      return response({ object: { sha: data.sha } });
    }
    if (path === "pulls" && method === "GET") {
      const state = url.searchParams.get("state"),
        head = url.searchParams.get("head")?.split(":")[1];
      return response(
        [...prs.values()]
          .filter((p) => p.state === state && object(p.head).ref === head)
          .toReversed(),
      );
    }
    if (path === "pulls") {
      const number = 100 + prs.size;
      const pull = {
        number,
        title: data.title,
        body: data.body,
        user: author,
        state: "open",
        merged: false,
        head: { sha: refs.get("heads/" + String(data.head)), ref: data.head, repo: localRepo },
        base: { ref: "main", repo: localRepo },
      };
      prs.set(number, pull);
      return response(pull);
    }
    if (/^pulls\/\d+$/u.test(path)) {
      const pull = prs.get(Number(path.split("/")[1]));
      if (pull && method === "PATCH") Object.assign(pull, data);
      return response(pull);
    }
    if (path.startsWith("pulls/") && path.endsWith("/commits")) {
      const head = originals.get(Number(path.split("/")[1]));
      assert.ok(head);
      return response([
        {
          sha: head,
          commit: { message: git(["show", "-s", "--format=%B", head]) },
          parents: git(["show", "-s", "--format=%P", head])
            .split(" ")
            .filter(Boolean)
            .map((sha) => ({ sha })),
        },
      ]);
    }
    if (path.startsWith("commits/") && path.endsWith("/pulls"))
      return response((links.get(path.split("/")[1] ?? "") ?? []).map((n) => prs.get(n)));
    if (path.startsWith("commits/"))
      return response({
        sha: path.slice(8),
        committer: path.slice(8) === backfillHead ? commitAuthor : author,
        commit: {
          verification: {
            verified: path.slice(8) === backfillHead ? commitVerified : true,
            reason: "valid",
          },
        },
      });
    if (path === "releases" && method === "POST") {
      if (failRelease) {
        failRelease = false;
        return Response.json({}, { status: 503 });
      }
      release = data;
      return response(release);
    }
    if (path.startsWith("releases/tags/")) return response(release ?? undefined);
    throw new Error("Unexpected request " + method + " " + path);
  };
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const trigger = (number: number) =>
    writeFileSync(event, JSON.stringify({ action: "closed", pull_request: { number } }));
  const original = land(41, "feat(export): add CSV export", "alice", "export", "main", base);
  trigger(41);
  await run("preview");
  assert.equal(writes.length, 0);
  await run("propose");
  const pr = [...prs.values()].find((p) => p.state === "open");
  assert.ok(pr);
  const first = object(pr.head).sha;
  land(42, "feat(export): add column selection", "bob", "columns", "export", original);
  const beforeFix = main;
  land(
    43,
    "fix: retain export settings",
    "carol",
    "settings",
    "main",
    beforeFix,
    "Required action: Restart the export worker.",
  );
  trigger(43);
  const savedBody = pr.body;
  pr.body = "A maintainer edit";
  const beforeConflict = writes.length;
  await assert.rejects(run("propose"), /text differs/u);
  assert.equal(writes.length, beforeConflict);
  pr.body = savedBody;
  await run("propose");
  assert.notEqual(object(pr.head).sha, first);
  assert.equal([...prs.values()].filter((p) => p.state === "open").length, 1);
  const head = String(object(pr.head).sha),
    n = writes.length;
  await run("propose");
  assert.equal(writes.length, n);
  const expected = readFileSync(new URL("./fixtures/release-golden.md", import.meta.url), "utf8");
  assert.equal(git(["show", head + ":CHANGELOG.md"]) + "\n", expected);
  assert.match(git(["show", head + ":Cargo.lock"]), /version = "1.3.0"/u);
  landing = git([
    "commit-tree",
    git(["rev-parse", head + "^{tree}"]),
    "-p",
    main,
    "-m",
    "merge release",
  ]);
  Object.assign(pr, {
    merged: true,
    state: "closed",
    merged_at: "2026-01-02",
    merge_commit_sha: landing,
  });
  links.set(landing, [Number(pr.number)]);
  const edited = prs.get(43);
  assert.ok(edited);
  edited.title = "renamed after review";
  edited.body = "Required action:\nRequired action: edited";
  main = landing;
  refs.set("heads/main", main);
  git(["reset", "--hard", main]);
  land(44, "docs: later change", "alice", "docs", "main", main);
  trigger(Number(pr.number));
  const normalLanding = pr.merge_commit_sha;
  pr.merge_commit_sha = main;
  await assert.rejects(run("promote"), /landing differs/u);
  pr.merge_commit_sha = normalLanding;
  refs.set("tags/v1.3.0", base);
  await assert.rejects(run("promote"), /Conflicting tag/u);
  refs.delete("tags/v1.3.0");
  await run("promote");
  assert.equal(refs.get("tags/v1.3.0"), landing);
  await assert.rejects(run("publish"), /503/u);
  assert.equal(imageVersion, true);
  await run("publish");
  assert.equal(writes.filter((w) => w === "image").length, 1);
  assert.equal(object(release).body, pr.body);
  const final = writes.length;
  await run("promote");
  await run("publish");
  assert.equal(writes.length, final);
  trigger(44);
  await run("propose");
  assert.equal(writes.length, final);
  edited.title = "fix: retain export settings";
  edited.body = "Required action: Restart the export worker.";
  await run("backfill");
  const backfill = [...prs.values()].find(
    (p) => p.state === "open" && object(p.head).ref === "release/changelog-backfill",
  );
  assert.ok(backfill);
  const rebuild = String(object(backfill.head).sha);
  backfillHead = rebuild;
  assert.equal(git(["diff", "--name-only", main, rebuild]), "CHANGELOG.md");
  const notes = git(["show", rebuild + ":CHANGELOG.md"]);
  assert.match(notes, /feat|bootstrap/u);
  assert.equal(notes.match(/^## v1.3.0$/gmu)?.length, 1);
  assert.ok(!notes.includes("Previously released text"));
  const end = writes.length;
  await run("backfill");
  assert.equal(writes.length, end);
  land(45, "docs: update guide", "alice", "guide", "main", main);
  const advanced = main;
  const beforeUntrusted = writes.length;
  commitVerified = false;
  await assert.rejects(run("backfill"), /Unverified backfill commit/u);
  commitVerified = true;
  commitAuthor = { ...author, login: "other[bot]" };
  await assert.rejects(run("backfill"), /Unverified backfill commit/u);
  commitAuthor = author;
  assert.equal(writes.length, beforeUntrusted);
  const savedBackfillBody = backfill.body;
  backfill.body = "Maintainer edit";
  const beforeEdit = writes.length;
  await assert.rejects(run("backfill"), /Existing backfill proposal differs/u);
  assert.equal(writes.length, beforeEdit);
  backfill.body = savedBackfillBody;
  await run("backfill");
  const refreshed = String(object(backfill.head).sha);
  assert.notEqual(refreshed, rebuild);
  assert.equal(git(["rev-parse", refreshed + "^1"]), advanced);
  assert.equal(git(["rev-parse", refreshed + "^2"]), rebuild);
  assert.equal(git(["diff", "--name-only", advanced, refreshed]), "CHANGELOG.md");
  const afterRefresh = writes.length;
  await run("backfill");
  assert.equal(writes.length, afterRefresh);
  const backfillLanding = git([
    "commit-tree",
    git(["rev-parse", refreshed + "^{tree}"]),
    "-p",
    advanced,
    "-m",
    "merge backfill",
  ]);
  Object.assign(backfill, { merged: true, state: "closed", merge_commit_sha: backfillLanding });
  refs.set("heads/main", backfillLanding);
  assert.equal(
    await verifyBackfillLanding(root, new Remote(repository, "synthetic", bot), backfill),
    backfillLanding,
  );
  git(["reset", "--hard", backfillLanding]);
  const beforeObsolete = writes.length;
  await run("backfill");
  assert.equal(writes.length, beforeObsolete);
  backfill.state = "open";
  await assert.rejects(run("backfill"), /close the obsolete proposal/u);
  assert.equal(writes.length, beforeObsolete);
});
