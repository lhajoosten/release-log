import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { inspectCommit, inspectPendingRelease } from "../src/git.ts";
import type { GitCommitEvidence } from "../src/git.ts";
import { captureReleaseSnapshot, serializeReleaseSnapshot } from "../src/release-snapshot.ts";
import type { GitHubRead } from "../src/github.ts";
import { fixtureConfiguration } from "./release-fixture.ts";

export function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
}
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
export const botId = 42;
export const version = { kind: "released", currentVersion: "1.2.3" } as const;

export async function fixture(
  context: TestContext,
  mode: "node" | "python" | "both" = "node",
  title = "feat(api): export rows",
  setup: { bootstrap?: boolean; bootstrapCommit?: boolean; objectFormat?: "sha1" | "sha256" } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "release-proposal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE",
  ])
    delete environment[name];
  function git(args: string[], input?: string, separateIndex = false): string {
    const result = spawnSync("git", ["--no-pager", ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment,
        ...(separateIndex ? { GIT_INDEX_FILE: join(directory, ".git", "proposal-index") } : {}),
      },
      ...(input === undefined ? {} : { input }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  git(["init", "--initial-branch=main", `--object-format=${setup.objectFormat ?? "sha1"}`]);
  git(["config", "user.name", "Fixture Bot"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  const manifestVersion = setup.bootstrap ? "0.0.0" : "1.2.3";
  if (mode !== "python")
    await writeFile(
      join(directory, "package.json"),
      `{ "version": "${manifestVersion}", "private": true }\n`,
    );
  if (mode !== "node")
    await writeFile(
      join(directory, "pyproject.toml"),
      `# preserve\n[project]\nversion = "${manifestVersion}" # preserve\n`,
    );
  await writeFile(join(directory, "unrelated.txt"), "keep me\n");
  git(["add", "."]);
  git(["commit", "-m", "chore: initialize fixture"]);
  const baseline = git(["rev-parse", "HEAD"]).trim();
  git(["tag", "v1.2.3"]);

  const bootstrapCommits: GitCommitEvidence[] = [];

  if (setup.bootstrapCommit) {
    assert.ok(setup.bootstrap);

    git(["commit", "--allow-empty", "-m", "feat: retain historical commit evidence"]);
    bootstrapCommits.push(await inspectCommit(directory, git(["rev-parse", "HEAD"]).trim()));
  }

  const changes: { sha: string; title: string }[] = [];
  async function advance(selectedTitle = title) {
    const index = changes.length + 1;
    await writeFile(join(directory, `change-${index}.txt`), `source change ${index}\n`);
    git(["add", "."]);
    git(["commit", "-m", "chore: preserve authored evidence"]);
    changes.push({ sha: git(["rev-parse", "HEAD"]).trim(), title: selectedTitle });
  }
  await advance();
  async function snapshot() {
    const source = git(["rev-parse", "refs/heads/main"]).trim();
    const range = await inspectPendingRelease(
      directory,
      setup.bootstrap
        ? { kind: "bootstrap", commitSha: baseline }
        : { kind: "tag", name: "v1.2.3" },
      source,
    );
    const pulls = await Promise.all(
      changes.map(async (change, index) => {
        const commit = await inspectCommit(directory, change.sha);
        return {
          number: index + 1,
          id: index + 1001,
          title: change.title,
          body: "```release-log\nversion: 1\naudience: internal\nsummary: Preserve selected rows.\nimpact: Retain the selection.\nrequired_action: null\n```",
          updatedAt: "2026-11-08T10:00:00Z",
          mergedAt: "2026-11-08T09:00:00Z",
          mergeCommitSha: change.sha,
          commitCount: 1,
          headSha: change.sha,
          headRef: "feature",
          headRepositoryId: 23,
          baseRepositoryId: 17,
          authorId: 7,
          authorType: "User",
          url: `https://github.com/example/project/pull/${index + 1}`,
          landingKind: "linear" as const,
          originalCommits: [commit],
          landedCommits: [commit],
        };
      }),
    );
    return serializeReleaseSnapshot(
      await captureReleaseSnapshot(
        {
          repository: "example/project",
          releaseBranch: "main",
          range,
          pullRequests: pulls,
          bootstrapCommits,
        },
        fixtureConfiguration,
      ),
    );
  }
  function ref(name: string): string | null {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/${name}`], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  function createTree(treeSha: string, entries: readonly Record<string, unknown>[]): string {
    git(["read-tree", treeSha], undefined, true);
    for (const entry of entries) {
      const sha = git(["hash-object", "-w", "--stdin"], text(entry.content)).trim();
      git(
        ["update-index", "--add", "--cacheinfo", text(entry.mode), sha, text(entry.path)],
        undefined,
        true,
      );
    }
    return git(["write-tree"], undefined, true).trim();
  }
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const pulls: Record<string, unknown>[] = [];
  let intercept:
    | ((method: string, path: string) => Response | null | Promise<Response | null>)
    | null = null;
  const transport: GitHubRead = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.github.com");
    const path = decodeURIComponent(target.pathname.slice("/repos/example/project".length));
    const method = options.method ?? "GET";
    const parsed: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
    const body = parsed === null ? null : object(parsed);
    calls.push({ method, path, body });
    const replaced = await intercept?.(method, path);
    if (replaced) return replaced;
    if (method === "GET" && !path) return json({ id: 17, full_name: "example/project" });
    if (method === "GET" && path.startsWith("/git/ref/")) {
      const name = path.slice("/git/ref/".length);
      const sha = ref(name);
      return sha
        ? json({ ref: `refs/${name}`, object: { sha } })
        : json({ message: "not found" }, 404);
    }
    if (method === "GET" && path.startsWith("/git/commits/")) {
      const sha = path.slice("/git/commits/".length);
      const commit = await inspectCommit(directory, sha);
      return json({
        sha,
        message: commit.message,
        parents: commit.parentShas.map((parentSha) => ({ sha: parentSha })),
        tree: { sha: git(["rev-parse", `${sha}^{tree}`]).trim() },
      });
    }
    if (method === "GET" && path.startsWith("/git/trees/")) {
      const sha = path.slice("/git/trees/".length);
      const tree = git(["ls-tree", "-r", "-t", "-z", sha])
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/u.exec(row);
          assert.ok(match);
          return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
        });
      return json({ sha, truncated: false, tree });
    }
    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const sha = path.slice("/git/blobs/".length);
      const bytes = Buffer.from(git(["cat-file", "blob", sha]));
      return json({
        sha,
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
      });
    }
    if (method === "GET" && path.startsWith("/compare/")) {
      const [base, targetSha] = path.slice("/compare/".length).split("...");
      assert.ok(base && targetSha);
      const mergeBase = git(["merge-base", base, targetSha]).trim();
      const ahead = Number(git(["rev-list", "--count", targetSha, "--not", base]).trim());
      const behind = Number(git(["rev-list", "--count", base, "--not", targetSha]).trim());
      return json({
        status: behind === 0 && ahead > 0 ? "ahead" : "behind",
        base_commit: { sha: base },
        merge_base_commit: { sha: mergeBase },
        ahead_by: ahead,
        behind_by: behind,
      });
    }
    const currentPull = (raw: Record<string, unknown>) => ({
      ...raw,
      head: { ...object(raw.head), sha: ref("heads/release-log/main") ?? object(raw.head).sha },
    });
    if (method === "GET" && path === "/pulls") return json(pulls.map(currentPull));
    if (method === "GET" && path.startsWith("/pulls/")) {
      const pull = pulls.find((entry) => entry.number === Number(path.split("/")[2]));
      return pull ? json(currentPull(pull)) : json({}, 404);
    }
    assert.ok(body);
    if (method === "POST" && path === "/git/trees") {
      assert.ok(Array.isArray(body.tree));
      return json({ sha: createTree(text(body.base_tree), body.tree.map(object)) }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      assert.ok(Array.isArray(body.parents));
      const parents: unknown[] = body.parents;
      const sha = git(
        ["commit-tree", text(body.tree), ...parents.flatMap((parent) => ["-p", text(parent)])],
        text(body.message),
      ).trim();
      return json({ sha }, 201);
    }
    if (path === "/git/refs" || path.startsWith("/git/refs/heads/")) {
      const name =
        method === "POST" ? text(body.ref).slice("refs/".length) : path.slice("/git/refs/".length);
      const previous = ref(name);
      const sha = text(body.sha);
      if (method === "POST" && previous) return json({}, 422);
      if (method === "PATCH") {
        assert.equal(body.force, false);
        if (
          !previous ||
          spawnSync("git", ["merge-base", "--is-ancestor", previous, sha], {
            cwd: directory,
            env: environment,
            timeout: 10_000,
          }).status !== 0
        )
          return json({}, 422);
      }
      git(["update-ref", `refs/${name}`, sha, previous ?? "0".repeat(sha.length)]);
      return json({ ref: `refs/${name}`, object: { sha } }, method === "POST" ? 201 : 200);
    }
    if (method === "POST" && path === "/pulls") {
      assert.equal(body.draft, true);
      const pull = {
        number: pulls.length + 1,
        title: body.title,
        body: body.body,
        state: "open",
        merged_at: null,
        user: { id: botId, type: "Bot" },
        head: { ref: "release-log/main", sha: ref("heads/release-log/main"), repo: { id: 17 } },
        base: { ref: "main", repo: { id: 17 } },
      };
      pulls.push(pull);
      return json(pull, 201);
    }
    if (method === "PATCH" && path.startsWith("/pulls/")) {
      const pull = pulls.find((entry) => entry.number === Number(path.split("/")[2]));
      assert.ok(pull);
      Object.assign(pull, { title: body.title, body: body.body });
      return json(currentPull(pull));
    }
    throw new Error(`Unexpected API request ${method} ${path}`);
  };
  return {
    directory,
    git,
    ref,
    createTree,
    snapshot,
    advance,
    calls,
    pulls,
    changes,
    transport,
    baseline,
    intercept(value: typeof intercept) {
      intercept = value;
    },
    async request(write?: boolean) {
      return {
        snapshot: await snapshot(),
        configuration: fixtureConfiguration,
        version: setup.bootstrap
          ? { kind: "bootstrap" as const, initialVersion: "0.1.0" as const }
          : version,
        automation: { schemaVersion: 1 as const, botUserId: botId },
        token: "synthetic-secret",
        ...(write === undefined ? {} : { write }),
      };
    },
  };
}
