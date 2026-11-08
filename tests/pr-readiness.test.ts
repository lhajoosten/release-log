import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";

import {
  checkGitHubPullRequest,
  pullRequestFromEvent,
  PullRequestCheckError,
} from "../src/github-pr-readiness.ts";
import type { GitHubRead } from "../src/github-pr-readiness.ts";
import { validatePullRequestMetadata } from "../src/pr-readiness.ts";
import type { PullRequestReadiness } from "../src/pr-readiness.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const request = {
  repository: "example/project",
  number: 7,
  headSha: head,
  token: "synthetic-token",
};
const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/check-pr-metadata.ts", import.meta.url));

function body(audience = "users", action = "null"): string {
  return [
    "```release-log",
    "version: 1",
    `audience: ${audience}`,
    "summary: Export selected rows.",
    "impact: Avoid downloading unwanted rows.",
    `required_action: ${action}`,
    "```",
  ].join("\n");
}

function commit(sha = head, message = "feat: add exports", parentCount = 1) {
  return { sha, message, parentCount };
}

function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    state: "open",
    merged: false,
    title: "feat(exports): add selected rows",
    body: body(),
    updated_at: "2026-11-08T10:00:00Z",
    commits: 1,
    user: { id: 11, type: "User" },
    base: { sha: base, ref: "main", repo: { id: 1, full_name: "example/project" } },
    head: { sha: head, ref: "feature", repo: { id: 2, full_name: "contributor/fork" } },
    ...overrides,
  };
}

function remoteCommit(sha = head, message = "feat: add exports", parents = [base]) {
  return { sha, commit: { message }, parents: parents.map((id) => ({ sha: id })) };
}

function api(...responses: Response[]) {
  const calls: { url: string; options: RequestInit }[] = [];
  const read: GitHubRead = (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    assert.ok(response, `Unexpected API call: ${url}`);
    return Promise.resolve(response);
  };
  return { read, calls };
}

function expectIssue(result: PullRequestReadiness, code: string): void {
  assert.ok(!result.valid);
  assert.ok(
    result.errors.some((issue) => issue.code === code),
    JSON.stringify(result.errors),
  );
  assert.equal("context" in result, false);
}

void test("readiness validates scoped titles and v1 context with separate unscoped commits", async () => {
  const result = await validatePullRequestMetadata("feat(exports): add selected rows", body(), [
    commit(),
  ]);
  assert.ok(result.valid);
  assert.equal(result.title.scope, "exports");
  assert.equal(result.context.audience, "users");
  assert.equal(result.context.requiredAction, null);
});

for (const [name, title, description, code] of [
  ["unscoped title", "feat: add exports", body(), "scope-empty"],
  ["invalid title", "add exports", body(), "type-empty"],
  [
    "multiline title",
    "feat(api): add exports\n\nBREAKING CHANGE: supply keys",
    body(),
    "title-invalid",
  ],
  ["oversized title", "a".repeat(1025), body(), "title-invalid"],
  ["missing context", "feat(api): add exports", "", "block-missing"],
  ["duplicate context", "feat(api): add exports", `${body()}\n${body()}`, "block-duplicate"],
  ["invalid audience", "feat(api): add exports", body("everyone"), "field-invalid"],
  [
    "missing action",
    "feat(api): add exports",
    body().replace("required_action: null\n", ""),
    "field-missing",
  ],
  [
    "oversized context",
    "feat(api): add exports",
    "x".repeat(1024 * 1024 + 1),
    "description-too-large",
  ],
] as const) {
  void test(`readiness rejects ${name}`, async () => {
    expectIssue(await validatePullRequestMetadata(title, description, [commit()]), code);
  });
}

void test("readiness retains internal context without assigning a bump or exempting validation", async () => {
  const result = await validatePullRequestMetadata("feat(engine): add cache", body("internal"), [
    commit(),
  ]);
  assert.ok(result.valid);
  assert.equal(result.context.audience, "internal");
  assert.equal("version" in result, false);
  expectIssue(
    await validatePullRequestMetadata("feat: add cache", body("internal"), [commit()]),
    "scope-empty",
  );
});

for (const message of [
  "feat!: require keys",
  "fix: require keys\n\nBREAKING CHANGE: supply a key",
  "fix: require keys\n\nBREAKING-CHANGE: supply a key",
]) {
  void test(`readiness rejects breaking commit/title conflict for ${JSON.stringify(message)}`, async () => {
    expectIssue(
      await validatePullRequestMetadata("fix(api): require keys", body("users", "Supply a key."), [
        commit(head, message),
      ]),
      "breaking-conflict",
    );
    const marked = await validatePullRequestMetadata(
      "fix(api)!: require keys",
      body("users", "Supply a key."),
      [commit(head, message)],
    );
    assert.ok(marked.valid);
    assert.equal(marked.title.breaking, true);
  });
}

void test("readiness requires a breaking action above the unchanged v1 parser", async () => {
  expectIssue(
    await validatePullRequestMetadata("docs(api)!: change contract", body("internal"), [commit()]),
    "breaking-action-required",
  );
  assert.ok(
    (
      await validatePullRequestMetadata(
        "feat(api)!: change contract",
        body("users", "Supply a key."),
        [commit()],
      )
    ).valid,
  );
});

for (const [message, code] of [
  ["feat(api): add exports", "scope-empty"],
  ["Merge pull request #8 from contributor/feature", "type-empty"],
  ["x".repeat(1024 * 1024 + 1), "message-too-large"],
] as const) {
  void test(`readiness rejects non-merge commit violation ${code}`, async () => {
    expectIssue(
      await validatePullRequestMetadata("feat(api): add exports", body(), [commit(head, message)]),
      code,
    );
  });
}

void test("readiness skips actual multi-parent structural merges, not merge-looking messages", async () => {
  const result = await validatePullRequestMetadata("feat(api): add exports", body(), [
    commit(base, "feat: add exports"),
    commit(head, "Merge pull request #8 from contributor/feature", 2),
  ]);
  assert.ok(result.valid);
});

void test("readiness preserves warnings and treats shell/workflow-like text only as data", async () => {
  const description = body().replace(
    "Export selected rows.",
    "'$(touch sentinel) ::error:: untrusted'",
  );
  const result = await validatePullRequestMetadata("feat(api): add exports", description, [
    commit(head, "feat: add exports\nBody without a blank line."),
  ]);
  assert.ok(result.valid);
  assert.equal(result.context.summary, "$(touch sentinel) ::error:: untrusted");
  assert.ok(result.warnings.some((issue) => issue.code === "body-leading-blank"));
});

void test("readiness has no bot, branch, marker, or release-title exemption", async () => {
  expectIssue(
    await validatePullRequestMetadata(
      "chore(release): prepare v0.1.0",
      "<!-- release-log: trusted -->",
      [commit(head, "chore: prepare v0.1.0")],
    ),
    "block-missing",
  );
  assert.ok(
    (
      await validatePullRequestMetadata(
        "chore(release): prepare v0.1.0",
        body("internal", "Review version, changelog, and snapshot before merging."),
        [commit(head, "chore: prepare v0.1.0")],
      )
    ).valid,
  );
});

void test("readiness returns deterministic errors for repeated metadata", async () => {
  const first = await validatePullRequestMetadata("invalid", "", [commit(head, "invalid")]);
  const second = await validatePullRequestMetadata("invalid", "", [commit(head, "invalid")]);
  assert.deepEqual(first, second);
});

void test("event selection verifies repository/number/head and ignores attacker-provided API URLs", () => {
  const event = {
    number: 7,
    repository: { full_name: request.repository },
    pull_request: { head: { sha: head }, url: "https://attacker.invalid/steal-token" },
  };
  assert.deepEqual(pullRequestFromEvent(event, request.repository), { number: 7, headSha: head });
  for (const invalid of [
    null,
    {},
    { ...event, number: -1 },
    { ...event, number: 1.5 },
    { ...event, repository: { full_name: "another/project" } },
    { ...event, pull_request: { head: { sha: "HEAD; touch sentinel" } } },
  ]) {
    assert.throws(() => pullRequestFromEvent(invalid, request.repository), PullRequestCheckError);
  }
});

void test("GitHub readiness validates a fork through read-only calls with bounded signals and no redirects", async () => {
  const stub = api(Response.json(pull()), Response.json([remoteCommit()]), Response.json(pull()));
  const result = await checkGitHubPullRequest(request, stub.read);
  assert.ok(result.result.valid);
  assert.equal(result.headSha, head);
  assert.deepEqual(
    stub.calls.map(({ url }) => url),
    [
      "https://api.github.com/repos/example/project/pulls/7",
      "https://api.github.com/repos/example/project/pulls/7/commits?per_page=100&page=1",
      "https://api.github.com/repos/example/project/pulls/7",
    ],
  );
  for (const { options } of stub.calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer synthetic-token");
    assert.equal(options.body, undefined);
  }
});

void test("GitHub readiness uses current edited API metadata rather than the event body", async () => {
  const current = pull({ body: "" });
  const stub = api(Response.json(current), Response.json([remoteCommit()]), Response.json(current));
  const result = await checkGitHubPullRequest(request, stub.read);
  expectIssue(result.result, "block-missing");
});

void test("GitHub readiness accepts the supported 250-commit boundary in three complete pages", async () => {
  const commits = Array.from({ length: 249 }, (_, index) =>
    remoteCommit(index.toString(16).padStart(40, "0")),
  );
  commits.push(remoteCommit());
  const current = pull({ commits: 250 });
  const next = { headers: { link: '<https://api.github.com/next>; rel="next"' } };
  const stub = api(
    Response.json(current),
    Response.json(commits.slice(0, 100), next),
    Response.json(commits.slice(100, 200), next),
    Response.json(commits.slice(200)),
    Response.json(current),
  );
  assert.ok((await checkGitHubPullRequest(request, stub.read)).result.valid);
  assert.equal(stub.calls.length, 5);
  const truncated = api(
    Response.json(pull({ commits: 101 })),
    Response.json(commits.slice(0, 100)),
  );
  await assert.rejects(
    checkGitHubPullRequest(request, truncated.read),
    /truncated the PR commits/u,
  );
  assert.equal(truncated.calls.length, 2);
});

void test("GitHub readiness validates all paginated commits and catches a later-page break", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    remoteCommit(index.toString(16).padStart(40, "0")),
  );
  const current = pull({ commits: 101 });
  const stub = api(
    Response.json(current),
    Response.json(first, { headers: { link: '<https://api.github.com/page/2>; rel="next"' } }),
    Response.json([remoteCommit(head, "fix!: require keys")]),
    Response.json(current),
  );
  const result = await checkGitHubPullRequest(request, stub.read);
  expectIssue(result.result, "breaking-conflict");
  assert.equal(stub.calls.length, 4);
  assert.match(stub.calls[2]?.url ?? "", /page=2$/u);
});

for (const [name, change] of [
  ["title", { title: "fix(api): retain keys" }],
  ["body", { body: body("internal") }],
  ["head", { head: { sha: "c".repeat(40), ref: "feature", repo: { id: 2 } } }],
  [
    "base",
    { base: { sha: "c".repeat(40), ref: "main", repo: { id: 1, full_name: request.repository } } },
  ],
  ["commit count", { commits: 2 }],
  ["author identity", { user: { id: 99 } }],
  ["update timestamp", { updated_at: "2026-11-08T11:00:00Z" }],
] as const) {
  void test(`GitHub readiness rejects ${name} changing during validation`, async () => {
    const stub = api(
      Response.json(pull()),
      Response.json([remoteCommit()]),
      Response.json(pull(change)),
    );
    await assert.rejects(checkGitHubPullRequest(request, stub.read), /changed during validation/u);
  });
}

void test("GitHub readiness rejects old-head events before collecting commits", async () => {
  const stub = api(Response.json(pull()));
  await assert.rejects(
    checkGitHubPullRequest({ ...request, headSha: "c".repeat(40) }, stub.read),
    /event head SHA is outdated/u,
  );
  assert.equal(stub.calls.length, 1);
});

for (const [name, metadata] of [
  ["closed PR", pull({ state: "closed" })],
  ["merged PR", pull({ merged: true })],
  [
    "wrong repository",
    pull({ base: { sha: base, ref: "main", repo: { id: 9, full_name: "another/project" } } }),
  ],
  ["missing body field", { number: 7 }],
  ["too many commits", pull({ commits: 251 })],
  ["deleted head repository", pull({ head: { sha: head, ref: "feature", repo: null } })],
] as const) {
  void test(`GitHub readiness fails closed for ${name}`, async () => {
    const stub = api(Response.json(metadata));
    await assert.rejects(checkGitHubPullRequest(request, stub.read), PullRequestCheckError);
    assert.equal(stub.calls.length, 1);
  });
}

for (const status of [301, 401, 403, 404, 429, 500]) {
  void test(`GitHub readiness reports HTTP ${status} without exposing response/token data`, async () => {
    const stub = api(new Response("private response containing synthetic-token", { status }));
    await assert.rejects(checkGitHubPullRequest(request, stub.read), (error: unknown) => {
      assert.ok(error instanceof PullRequestCheckError);
      assert.match(error.message, new RegExp(`HTTP ${status}`, "u"));
      assert.doesNotMatch(error.message, /synthetic-token|private response/u);
      return true;
    });
  });
}

void test("GitHub readiness reports fetch/timeout failures without reflecting arbitrary errors", async () => {
  const failure = new Error("synthetic-token ::error:: private response");
  const read: GitHubRead = () => Promise.reject(failure);
  await assert.rejects(checkGitHubPullRequest(request, read), (error: unknown) => {
    assert.ok(error instanceof PullRequestCheckError);
    assert.match(error.message, /failed or timed out/u);
    assert.doesNotMatch(error.message, /synthetic-token|::error::|private response/u);
    return true;
  });
});

for (const [name, response] of [
  ["malformed JSON", () => new Response("{private metadata")],
  ["empty response", () => new Response(null)],
  ["oversized response", () => new Response(" ".repeat(4 * 1024 * 1024 + 1))],
  [
    "interrupted stream",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private token"));
          },
        }),
      ),
  ],
] as const) {
  void test(`GitHub readiness rejects ${name}`, async () => {
    const stub = api(response());
    await assert.rejects(checkGitHubPullRequest(request, stub.read), PullRequestCheckError);
  });
}

for (const [name, metadata, commits, headers] of [
  ["missing page", pull(), [], {}],
  ["malformed commit", pull(), [{ sha: head }], {}],
  ["invalid parents", pull(), [{ ...remoteCommit(), parents: [{}] }], {}],
  ["wrong head evidence", pull(), [remoteCommit(base)], {}],
  ["duplicate commit", pull({ commits: 2 }), [remoteCommit(), remoteCommit()], {}],
  ["extra commit", pull(), [remoteCommit(base), remoteCommit()], {}],
  ["truncated pagination", pull({ commits: 2 }), [remoteCommit(base)], {}],
  [
    "unexpected next page",
    pull(),
    [remoteCommit()],
    { link: '<https://attacker.invalid/>; rel="next"' },
  ],
] as const) {
  void test(`GitHub readiness rejects ${name} without following supplied URLs`, async () => {
    const stub = api(Response.json(metadata), Response.json(commits, { headers }));
    await assert.rejects(checkGitHubPullRequest(request, stub.read), PullRequestCheckError);
    assert.equal(stub.calls.length, 2);
    assert.ok(
      stub.calls.every(({ url }) =>
        url.startsWith("https://api.github.com/repos/example/project/"),
      ),
    );
  });
}

void test("GitHub readiness accepts SHA-256 identities and validates all bot metadata normally", async () => {
  const sha256 = "a".repeat(64);
  const current = pull({
    title: "chore(release): prepare v0.1.0",
    body: "<!-- release-log: trusted -->",
    user: { id: 99, type: "Bot" },
    head: { sha: sha256, ref: "release-log/main", repo: { id: 1 } },
  });
  const stub = api(
    Response.json(current),
    Response.json([remoteCommit(sha256, "chore: prepare v0.1.0")]),
    Response.json(current),
  );
  expectIssue(
    (await checkGitHubPullRequest({ ...request, headSha: sha256 }, stub.read)).result,
    "block-missing",
  );
});

void test("GitHub readiness rejects invalid request identities before sending credentials", async () => {
  for (const invalid of [
    { ...request, repository: "https://attacker.invalid/project" },
    { ...request, repository: "example/.." },
    { ...request, number: -1 },
    { ...request, headSha: "HEAD" },
    { ...request, token: "" },
  ]) {
    const stub = api();
    await assert.rejects(checkGitHubPullRequest(invalid, stub.read), PullRequestCheckError);
    assert.equal(stub.calls.length, 0);
  }
});

void test("metadata workflow runs only trusted base source with read-only permissions and pinned Actions", async () => {
  const source = await readFile(
    new URL("../.github/workflows/pr-metadata.yml", import.meta.url),
    "utf8",
  );
  const workflow: unknown = parse(source);
  assert.ok(typeof workflow === "object" && workflow !== null);
  assert.ok("on" in workflow && typeof workflow.on === "object" && workflow.on !== null);
  assert.deepEqual(workflow.on, {
    pull_request_target: {
      types: ["opened", "synchronize", "reopened", "edited", "ready_for_review"],
    },
  });
  assert.ok("permissions" in workflow);
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
  assert.ok(
    "jobs" in workflow &&
      typeof workflow.jobs === "object" &&
      workflow.jobs !== null &&
      "metadata" in workflow.jobs,
  );
  const job = workflow.jobs.metadata;
  assert.ok(typeof job === "object" && job !== null && "steps" in job && Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const runs: string[] = [];
  const actions: string[] = [];
  for (const step of steps) {
    assert.ok(typeof step === "object" && step !== null);
    if ("uses" in step) {
      assert.match(String(step.uses), /@[a-f0-9]{40}$/u);
      actions.push(String(step.uses).split("@")[0] ?? "");
      if (String(step.uses).startsWith("actions/checkout@")) {
        assert.ok("with" in step);
        assert.deepEqual(step.with, {
          repository: "${{ github.repository }}",
          ref: "${{ github.event.pull_request.base.sha }}",
          "persist-credentials": false,
        });
      }
    }
    if ("run" in step) {
      runs.push(String(step.run));
      assert.doesNotMatch(String(step.run), /\$\{\{/u);
    }
    if ("run" in step && step.run === "pnpm check:pr-metadata") {
      assert.ok("env" in step);
      assert.deepEqual(step.env, { GITHUB_TOKEN: "${{ github.token }}" });
    } else {
      assert.equal("env" in step, false);
    }
  }
  assert.deepEqual(actions, ["actions/checkout", "actions/setup-node", "pnpm/action-setup"]);
  assert.deepEqual(runs, [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "pnpm check:pr-metadata",
  ]);
  assert.doesNotMatch(source, /secrets\.|pull_request\.head|refs\/pull|actions\/cache@/u);
  assert.match(source, /cancel-in-progress: true/u);
});

void test("metadata command exercises successful and failing checks with only the HTTP boundary replaced", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-log-pr-command-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const eventPath = join(directory, "event.json");
  const loader = join(directory, "fetch.mjs");
  const responses = join(directory, "responses.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      number: 7,
      repository: { full_name: request.repository },
      pull_request: { head: { sha: head } },
    }),
  );
  await writeFile(
    loader,
    [
      'import { readFileSync } from "node:fs";',
      'const responses = JSON.parse(readFileSync(new URL("./responses.json", import.meta.url), "utf8"));',
      "globalThis.fetch = (url, options) => {",
      '  if (!String(url).startsWith("https://api.github.com/repos/example/project/pulls/7") || options.method !== "GET") throw new Error("Unexpected request");',
      '  if (!responses.length) throw new Error("Unexpected extra request");',
      "  return Promise.resolve(Response.json(responses.shift()));",
      "};",
      'process.on("beforeExit", () => { if (responses.length) process.exitCode = 1; });',
    ].join("\n"),
  );
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: request.repository,
    GITHUB_TOKEN: request.token,
  };
  const current = pull({
    body: body().replace("Export selected rows.", "'$(touch sentinel) ::error:: untrusted'"),
  });
  await writeFile(responses, JSON.stringify([current, [remoteCommit()], current]));
  const success = await execute(process.execPath, ["--import", loader, script], {
    cwd: directory,
    timeout: 10_000,
    env,
  });
  assert.deepEqual(JSON.parse(success.stdout), { valid: true, number: 7, headSha: head });
  assert.equal(success.stderr, "");
  const invalid = pull({
    body: body().replace("version: 1", '"::error:: injected": value\nversion: 1'),
  });
  await writeFile(responses, JSON.stringify([invalid, [remoteCommit()], invalid]));
  await assert.rejects(
    execute(process.execPath, ["--import", loader, script], {
      cwd: directory,
      timeout: 10_000,
      env,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 1);
      const stderr = String(error.stderr).trim();
      assert.equal(stderr.split("\n").length, 1);
      assert.match(stderr, /^\{"level":"error"/u);
      assert.doesNotMatch(stderr, /synthetic-token/u);
      const diagnostic: unknown = JSON.parse(stderr);
      assert.ok(
        typeof diagnostic === "object" &&
          diagnostic !== null &&
          "code" in diagnostic &&
          diagnostic.code === "unknown-field",
      );
      return true;
    },
  );
});

void test("metadata command fails closed offline for bad runtime/event inputs and emits single-line JSON", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-log-pr-event-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const eventPath = join(directory, "event.json");
  for (const [eventName, contents, apiUrl] of [
    ["pull_request", "{}", "https://api.github.com"],
    ["pull_request_target", "{}", "https://enterprise.invalid/api/v3"],
    ["pull_request_target", "not JSON\n::error:: private text", "https://api.github.com"],
    [
      "pull_request_target",
      JSON.stringify({ number: 7, repository: { full_name: "attacker/project" } }),
      "https://api.github.com",
    ],
  ]) {
    await writeFile(eventPath, contents ?? "");
    await assert.rejects(
      execute(process.execPath, [script], {
        cwd: directory,
        timeout: 10_000,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_API_URL: apiUrl,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: request.repository,
          GITHUB_TOKEN: request.token,
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && "stderr" in error);
        assert.equal(error.code, 1);
        const stderr = String(error.stderr).trim();
        assert.equal(stderr.split("\n").length, 1);
        assert.doesNotMatch(stderr, /synthetic-token|private text|::error::/u);
        const output: unknown = JSON.parse(stderr);
        assert.ok(
          typeof output === "object" &&
            output !== null &&
            "valid" in output &&
            output.valid === false,
        );
        return true;
      },
    );
  }
});
