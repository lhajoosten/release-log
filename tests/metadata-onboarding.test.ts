import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parseReleaseInputConfiguration } from "../src/config/repository.ts";
import type { GitHubRead } from "../src/github.ts";
import { verifyMetadataOnboarding } from "../src/metadata-onboarding.ts";

const pin = "a".repeat(40);
const tip = "b".repeat(40);
const branch = "releases/stable";
const check = "release-log / metadata";
const metadataPath = ".github/workflows/release-metadata-caller.yml";
const rollingPath = ".github/workflows/rolling-release-caller.yml";
const config = parseReleaseInputConfiguration({
  schemaVersion: 1,
  repository: "example/project",
  repositoryId: 17,
  releaseBranch: branch,
  releasePolicy: "release-policy-v1",
  contextPolicy: "optional",
});

function file(path: string, contents: string) {
  return Response.json({
    path,
    type: "file",
    encoding: "base64",
    content: Buffer.from(contents).toString("base64"),
  });
}

async function template(name: string) {
  return (await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8"))
    .replaceAll("REVIEWED_FULL_COMMIT_SHA", pin)
    .replace("branches: [main]", `branches: [${branch}]`)
    .replace("release-branch: main", `release-branch: ${branch}`)
    .replace(/^        \{"schemaVersion":.+$/mu, `        ${JSON.stringify(config)}`);
}

const metadata = await template("release-metadata-caller.yml");
const rolling = await template("rolling-release.yml");
const branchPath = "/branches/releases%2Fstable";
const rulesPath = "/rules/branches/releases%2Fstable?per_page=100&page=1";
const protectionPath = `${branchPath}/protection`;
const contentsPath = (path: string) => `/contents/${path}?ref=${tip}`;
const rulesetPath = "/rulesets/42?includes_parents=true";
const rule = {
  type: "required_status_checks",
  ruleset_id: 42,
  ruleset_source_type: "Organization",
  parameters: { required_status_checks: [{ context: check, integration_id: 15368 }] },
};

function fixture(overrides: Record<string, Response> = {}) {
  const responses = new Map(
    Object.entries({
      "": Response.json({ id: 17, full_name: "example/project" }),
      [branchPath]: Response.json({ name: branch, commit: { sha: tip }, protected: true }),
      [contentsPath(rollingPath)]: file(rollingPath, rolling),
      [contentsPath(metadataPath)]: file(metadataPath, metadata),
      "/actions/workflows/release-metadata-caller.yml": Response.json({
        path: metadataPath,
        state: "active",
      }),
      [rulesPath]: Response.json([]),
      [protectionPath]: Response.json({
        required_status_checks: { checks: [{ context: check, app_id: 15368 }] },
        enforce_admins: { enabled: true },
      }),
      ...overrides,
    }),
  );
  const visited: string[] = [];
  const read: GitHubRead = (url, options) => {
    const root = "https://api.github.com/repos/example/project";
    assert.ok(url === root || url.startsWith(root + "/"));
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    const path = url.slice(root.length);
    assert.ok(!visited.includes(path));
    visited.push(path);
    const response = responses.get(path);
    assert.ok(response, `Unexpected read for ${path}`);
    return Promise.resolve(response);
  };
  return { read, visited };
}

void test("verifies GitHub Actions enforcement on a non-main release branch", async () => {
  const { read, visited } = fixture();
  const result = await verifyMetadataOnboarding(config, "synthetic", read);
  assert.equal(result.status, "verified");
  assert.equal(result.branch, branch);
  assert.equal(result.check, check);
  assert.ok(visited.includes(protectionPath));
});

void test("accepts an installed rolling caller without manual dispatch", async () => {
  const legacy = rolling
    .replace("  workflow_dispatch:\n", "")
    .replace("github.event_name == 'workflow_dispatch' || ", "");
  const { read } = fixture({ [contentsPath(rollingPath)]: file(rollingPath, legacy) });
  assert.equal((await verifyMetadataOnboarding(config, "synthetic", read)).status, "verified");
});

for (const [name, overrides, status, message] of [
  [
    "missing caller",
    {
      [contentsPath(metadataPath)]: new Response(null, { status: 404 }),
      [contentsPath(".github/workflows")]: Response.json([{ path: rollingPath }]),
    },
    "incomplete",
    /Install.*release-metadata-caller/u,
  ],
  [
    "unreadable caller contents",
    {
      [contentsPath(metadataPath)]: new Response(null, { status: 404 }),
      [contentsPath(".github/workflows")]: new Response(null, { status: 403 }),
    },
    "insufficient-evidence",
    /permissions/u,
  ],
  [
    "metadata context drift",
    {
      [contentsPath(metadataPath)]: file(
        metadataPath,
        metadata.replace('"optional"', '"required"'),
      ),
    },
    "incomplete",
    /align repository, release branch and context policy/u,
  ],
  [
    "rolling caller branch drift",
    {
      [contentsPath(rollingPath)]: file(rollingPath, rolling.replace(`[${branch}]`, "[main]")),
    },
    "incomplete",
    /Align the pinned rolling-release caller/u,
  ],
  [
    "unexpected rolling caller trigger",
    {
      [contentsPath(rollingPath)]: file(
        rollingPath,
        rolling.replace("  workflow_dispatch:", "  push:"),
      ),
    },
    "incomplete",
    /Align the pinned rolling-release caller/u,
  ],
  [
    "tool pin mismatch",
    {
      [contentsPath(metadataPath)]: file(
        metadataPath,
        metadata.replace(`tool-sha: ${pin}`, `tool-sha: ${tip}`),
      ),
    },
    "incomplete",
    /supported pinned, read-only template/u,
  ],
  [
    "metadata event missing",
    {
      [contentsPath(metadataPath)]: file(metadataPath, metadata.replace("edited, ", "")),
    },
    "incomplete",
    /all five PR events/u,
  ],
  [
    "disabled caller",
    {
      "/actions/workflows/release-metadata-caller.yml": Response.json({
        path: metadataPath,
        state: "disabled_manually",
      }),
    },
    "incomplete",
    /Enable the Actions workflow/u,
  ],
  [
    "unprotected branch",
    {
      [branchPath]: Response.json({ name: branch, commit: { sha: tip }, protected: false }),
      [protectionPath]: new Response(null, { status: 404 }),
    },
    "incomplete",
    /check is missing/u,
  ],
  [
    "status context bound to a different app",
    {
      [protectionPath]: Response.json({
        required_status_checks: { checks: [{ context: check, app_id: 12 }] },
      }),
    },
    "incomplete",
    /different source/u,
  ],
  [
    "classic administrator bypass",
    {
      [protectionPath]: Response.json({
        required_status_checks: { checks: [{ context: check, app_id: 15368 }] },
        enforce_admins: { enabled: false },
      }),
    },
    "incomplete",
    /enforcement for administrators/u,
  ],
  [
    "protection denied",
    { [protectionPath]: new Response(null, { status: 403 }) },
    "insufficient-evidence",
    /authorized repository administrator/u,
  ],
  [
    "merge queue",
    { [rulesPath]: Response.json([{ type: "merge_queue" }]) },
    "incomplete",
    /merge-group/u,
  ],
] as const) {
  void test(`reports ${name} with the branch and exact check`, async () => {
    const { read } = fixture(overrides);
    const result = await verifyMetadataOnboarding(config, "synthetic", read);
    assert.equal(result.status, status);
    assert.ok(result.message.includes(check));
    assert.ok(result.message.includes(branch));
    assert.match(result.message, message);
  });
}

for (const [bypassEvidence, status] of [
  [{ bypass_actors: [] }, "verified"],
  [
    { bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "pull_request" }] },
    "incomplete",
  ],
  [{}, "insufficient-evidence"],
] as const) {
  void test(`reports ruleset enforcement as ${status} based on bypass evidence`, async () => {
    const { read, visited } = fixture({
      [protectionPath]: Response.json({}),
      [rulesPath]: Response.json([rule]),
      [rulesetPath]: Response.json({
        id: 42,
        enforcement: "active",
        rules: [rule],
        ...bypassEvidence,
      }),
    });
    assert.equal((await verifyMetadataOnboarding(config, "synthetic", read)).status, status);
    assert.ok(visited.includes(rulesetPath));
  });
}
