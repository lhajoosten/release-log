import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { loadProducerRuntimes, withProducerRuntimes } from "../src/producer-runtime.ts";
import { inspectPendingRelease } from "../src/git.ts";
import { auditReleaseExclusion, verifyReleaseApproval } from "../src/release-approval.ts";
import { parseVerifiedReleaseApproval } from "../src/release-approval-record.ts";
import { capturedIdentity } from "../src/proposal-identity.ts";
import {
  parseReleaseInputConfiguration,
  captureReleaseSnapshot,
  replayReleaseSnapshot,
  serializeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { reconcileReleaseProposal } from "../src/release-proposal.ts";
import { reconcileReleaseTag } from "../src/release-tag.ts";
import { rollRelease } from "../src/release-roll.ts";
import { selectReleaseCycle } from "../src/release-cycle.ts";
import { updateToolPins, workflowPath } from "../src/tool-upgrade.ts";
import { botId, fixture, json, object } from "./proposal-fixture.ts";

const replacementSha = "a".repeat(40);
const oldSha = "8828be515345d761a7375b5c00b1beff0cfabaeb";
const caller = `# retain comments and permissions\nname: Rolling release caller\npermissions:\n  contents: read\n  pull-requests: read\njobs:\n  release:\n    uses: lhajoosten/release-log/.github/workflows/rolling-release.yml@${oldSha}\n    with:\n      tool-sha: ${oldSha} # keep this comment\n      write: true\n`;

async function producer(context: TestContext, version = "0.0.0", differentLock = false) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "trusted-producer-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "dist"));
  await cp(join(root, "src"), join(directory, "dist/src"), { recursive: true });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  const manifest = object(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown,
  );
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(join(directory, "dist/package.json"), JSON.stringify({ ...manifest, version }));
  await cp(
    join(root, "commitlint.base.config.mjs"),
    join(directory, "dist/commitlint.base.config.mjs"),
  );
  await writeFile(
    join(directory, "dist/pnpm-lock.yaml"),
    (await readFile(join(root, "pnpm-lock.yaml"), "utf8")) + (differentLock ? "\n" : ""),
  );
  for (const name of ["release-snapshot", "proposal-files", "proposal-identity"])
    await writeFile(join(directory, `dist/src/${name}.js`), `export * from './${name}.ts';\n`);
  return directory;
}

async function selfUse(context: TestContext) {
  const f = await fixture(context, "node", "feat(api): export rows", { selfUse: true, caller });
  // Model the reviewed bootstrap: the source caller points to an existing
  // immutable runner revision, while the proposed pin will point to this source.
  await writeFile(join(f.directory, workflowPath), caller.replaceAll(oldSha, f.baseline));
  await f.advance("chore(tooling): activate the reviewed runner");
  let ci = "success";
  let human = true;
  let quality: (() => string | null | Promise<string | null>) | undefined;
  f.intercept(async (method, path) => {
    if (method !== "GET") return null;
    const source = f.ref("heads/main");
    if (path.startsWith("/commits/") && path.endsWith("/pulls"))
      return json([{ number: 999, merge_commit_sha: source }]);
    if (path === "/pulls/999")
      return json({
        number: 999,
        state: "closed",
        merged: true,
        merged_at: "2026-11-16T12:00:00Z",
        merge_commit_sha: source,
        merged_by: { type: human ? "User" : "Bot" },
        base: { ref: "main", repo: { id: 1449550207 } },
      });
    if (path === "/actions/workflows/quality.yml/runs") {
      const status = quality ? await quality() : "completed";
      if (status === null) return json({ total_count: 0, workflow_runs: [] });
      return json({
        total_count: 1,
        workflow_runs: [
          {
            head_sha: source,
            head_branch: "main",
            event: "push",
            path: ".github/workflows/quality.yml",
            status,
            conclusion: status === "completed" ? ci : null,
            run_number: 1,
            repository: { id: 1449550207 },
          },
        ],
      });
    }
    return null;
  });
  async function upgradedRequest() {
    const request = await f.request(true);
    const previous = await replayReleaseSnapshot(request.snapshot, request.configuration);
    const configuration = parseReleaseInputConfiguration({
      ...request.configuration,
      selfUpgrade: true,
      contextPolicy: "required",
      changelog: { verbosity: "concise", format: "compact" },
    });
    return {
      ...request,
      configuration,
      snapshot: await serializeReleaseSnapshot(
        await captureReleaseSnapshot(previous.input, configuration, "2026-11-16T12:00:00.000Z"),
      ),
    };
  }
  return {
    f,
    request: upgradedRequest,
    ci(value: string) {
      ci = value;
    },
    quality(value: () => string | null | Promise<string | null>) {
      quality = value;
    },
    human(value: boolean) {
      human = value;
    },
  };
}

void test("pin updates replace exactly two scalars and reject ambiguous or mutable callers", () => {
  assert.equal(updateToolPins(caller, replacementSha), caller.replaceAll(oldSha, replacementSha));
  assert.equal(
    updateToolPins(updateToolPins(caller, replacementSha), replacementSha),
    caller.replaceAll(oldSha, replacementSha),
  );
  assert.equal(
    updateToolPins(caller.replace(`tool-sha: ${oldSha}`, `tool-sha: '${oldSha}'`), replacementSha),
    caller
      .replaceAll(oldSha, replacementSha)
      .replace(`tool-sha: ${replacementSha}`, `tool-sha: '${replacementSha}'`),
  );
  for (const content of [
    null,
    caller.replaceAll(oldSha, "main"),
    caller.replace(`tool-sha: ${oldSha}`, `tool-sha: ${replacementSha}`),
    caller + "  release: {}\n",
    caller.replace(`tool-sha: ${oldSha}`, "tool-sha: &pin main"),
    caller.replace(`tool-sha: ${oldSha}`, `tool-sha: &pin ${oldSha}`),
    caller.replace("release:\n", "release: &shared\n") + "  second: *shared\n",
  ])
    assert.throws(() => updateToolPins(content, replacementSha));
  assert.throws(() => updateToolPins(caller, "main"));
});

void test("consumer repositories cannot select self-use and their workflows stay outside generated files", async (context) => {
  const f = await fixture(context, "node", "feat(api): export rows", { caller });
  const request = await f.request();
  assert.throws(
    () => parseReleaseInputConfiguration({ ...request.configuration, selfUpgrade: true }),
    /repository identity/u,
  );
  await reconcileReleaseProposal({ ...request, write: true }, f.transport);
  assert.equal(f.git(["show", "release-log/main:" + workflowPath]), caller);
});

void test("self-upgrades require a pinned producer, human merge and successful CI before writes", async (context) => {
  const s = await selfUse(context);
  const activeSha = s.f.baseline;
  const request = await s.request();
  await assert.rejects(reconcileReleaseProposal(request, s.f.transport), /pinned active producer/u);
  const runtimes = await loadProducerRuntimes({ activeSha, producers: [] });
  await withProducerRuntimes(runtimes, async () => {
    s.ci("failure");
    await assert.rejects(reconcileReleaseProposal(request, s.f.transport), /Quality run/u);
    s.ci("success");
    s.human(false);
    await assert.rejects(reconcileReleaseProposal(request, s.f.transport), /human-merged/u);
  });
  assert.ok(s.f.calls.every((call) => call.method === "GET"));
});

function advanceQualityClock(context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = setInterval(() => context.mock.timers.tick(15_000), 10);
  context.after(() => clearInterval(clock));
}

void test("pending Quality automatically admits the exact source and refreshes the same proposal", async (context) => {
  const s = await selfUse(context);
  advanceQualityClock(context);
  const runtimes = await loadProducerRuntimes({ activeSha: s.f.baseline, producers: [] });
  await withProducerRuntimes(runtimes, async () => {
    async function reconcileAfterQuality() {
      const statuses = ["missing", "queued", "in_progress", "completed"];
      s.quality(() => {
        const status = statuses.shift() ?? "completed";
        if (status !== "completed") {
          assert.ok(s.f.calls.slice(start).every((call) => call.method === "GET"));
        }
        return status === "missing" ? null : status;
      });
      const start = s.f.calls.length;
      const result = await reconcileReleaseProposal(await s.request(), s.f.transport);
      assert.equal(statuses.length, 0);
      assert.equal(result.sourceSha, s.f.ref("heads/main"));
      return result;
    }

    const created = await reconcileAfterQuality();
    assert.equal(created.outcome, "created");
    await s.f.advance("fix(api): retain keys");
    await s.f.advance("fix(api): retain values");
    const refreshed = await reconcileAfterQuality();
    assert.equal(refreshed.outcome, "refreshed");
    assert.equal(refreshed.pullNumber, created.pullNumber);
    assert.equal(s.f.pulls.length, 1);
    const capture = await replayReleaseSnapshot(
      s.f.git(["show", `${refreshed.headSha}:.release-log/inputs.json`]),
      (await s.request()).configuration,
    );
    assert.deepEqual(
      capture.input.range.commitShas.toSorted(),
      s.f
        .git(["rev-list", `${refreshed.baselineSha}..${refreshed.sourceSha}`])
        .trim()
        .split("\n")
        .toSorted(),
    );
    assert.equal(
      (await reconcileReleaseProposal(await s.request(), s.f.transport)).outcome,
      "unchanged",
    );
  });
});

void test("Quality timeout, failed admission, and superseded source leave the proposal untouched", async (context) => {
  const s = await selfUse(context);
  advanceQualityClock(context);
  const runtimes = await loadProducerRuntimes({ activeSha: s.f.baseline, producers: [] });
  await withProducerRuntimes(runtimes, async () => {
    const request = await s.request();
    let polls = 0;
    s.quality(() => {
      polls++;
      return "in_progress";
    });
    await assert.rejects(
      reconcileReleaseProposal(request, s.f.transport),
      /Quality run is still pending/u,
    );
    assert.equal(polls, 25);

    polls = 0;
    s.ci("failure");
    s.quality(() => (++polls === 1 ? "queued" : "completed"));
    await assert.rejects(reconcileReleaseProposal(request, s.f.transport), /must pass/u);
    assert.equal(polls, 2);

    polls = 0;
    s.ci("success");
    s.quality(() => (++polls === 1 ? "completed" : "queued"));
    await assert.rejects(reconcileReleaseProposal(request, s.f.transport), /still pending/u);
    assert.equal(polls, 2);

    s.quality(async () => {
      await s.f.advance("fix(api): retain keys");
      return "queued";
    });
    await assert.rejects(
      reconcileReleaseProposal(request, s.f.transport),
      /Main changed after capture/u,
    );
    assert.ok(s.f.calls.every((call) => call.method === "GET"));
    assert.equal(s.f.pulls.length, 0);
  });
});

void test("creation, retry, refresh, changed caller pin and merge routing preserve exact-landing tags", async (context) => {
  const s = await selfUse(context);
  const activeSha = s.f.baseline;
  const runtimes = await loadProducerRuntimes({ activeSha, producers: [] });
  await withProducerRuntimes(runtimes, async () => {
    const created = await reconcileReleaseProposal(await s.request(), s.f.transport);
    assert.ok(created.headSha);
    assert.equal(
      s.f.git(["show", `${created.headSha}:${workflowPath}`]),
      caller.replaceAll(oldSha, created.sourceSha),
    );
    assert.equal(
      capturedIdentity(s.f.git(["show", "-s", "--format=%B", created.headSha]).trimEnd() + "\n")
        .producerSha,
      activeSha,
    );
    const writes = s.f.calls.filter((c) => c.method !== "GET").length;
    assert.equal(
      (await reconcileReleaseProposal(await s.request(), s.f.transport)).outcome,
      "unchanged",
    );
    assert.equal(s.f.calls.filter((c) => c.method !== "GET").length, writes);
    await s.f.advance("fix(api): retain keys");
    const request = await s.request();
    const refreshed = await reconcileReleaseProposal(request, s.f.transport);
    assert.equal(refreshed.outcome, "refreshed");
    assert.equal(refreshed.pullNumber, created.pullNumber);
    assert.ok(refreshed.headSha);
    assert.equal(
      s.f.git(["show", `${refreshed.headSha}:${workflowPath}`]),
      caller.replaceAll(oldSha, refreshed.sourceSha),
    );
    const tree = s.f.git(["rev-parse", `${refreshed.headSha}^{tree}`]).trim();
    const landing = s.f
      .git(
        ["commit-tree", tree, "-p", refreshed.sourceSha, "-p", refreshed.headSha],
        "chore: merge release\n",
      )
      .trim();
    s.f.git(["update-ref", "refs/heads/main", landing]);
    const pull = s.f.pulls[0];
    assert.ok(pull);
    Object.assign(pull, {
      state: "closed",
      merged: true,
      merged_at: "2026-11-16T13:00:00Z",
      merge_commit_sha: landing,
      merged_by: { id: 7, type: "User" },
    });
    pull.base = {
      ...object(pull.base),
      repo: { id: 1449550207, full_name: "lhajoosten/release-log" },
    };
    const transport = async (url: string, options: RequestInit = {}) => {
      const response = await s.f.transport(url, options);
      if (!response.ok) return response;
      if (
        url.includes("/git/ref/tags/") ||
        (options.method === "POST" && new URL(url).pathname.endsWith("/git/refs"))
      ) {
        const data = object(await response.json());
        return json(
          { ...data, object: { ...object(data.object), type: "commit" } },
          response.status,
        );
      }
      return response;
    };
    await withProducerRuntimes({ activeSha: refreshed.sourceSha, producers: [] }, async () => {
      await assert.rejects(
        reconcileReleaseTag(
          {
            configuration: request.configuration,
            automation: request.automation,
            token: request.token,
            pullNumber: 1,
            landingSha: landing,
          },
          transport,
        ),
        /trusted verification runtime/u,
      );
    });
    // Retain the runner identity from capture; the release PR may have bumped
    // the checkout package version independently of the consumer fixture.
    const producerVersion = (await replayReleaseSnapshot(request.snapshot, request.configuration))
      .tool.version;
    // Next handler uses the newly proposed pin, retaining the prior producer.
    const next = await loadProducerRuntimes({
      activeSha: refreshed.sourceSha,
      producers: [
        { sha: activeSha, directory: await producer(context, producerVersion), legacy: false },
      ],
    });
    await withProducerRuntimes(next, async () => {
      const result = await rollRelease(
        {
          configuration: request.configuration,
          automation: request.automation,
          repository: s.f.directory,
          token: request.token,
          write: true,
          eventName: "pull_request_target",
          event: {
            action: "closed",
            number: refreshed.pullNumber,
            repository: { id: 1449550207, full_name: "lhajoosten/release-log" },
            pull_request: {
              merged: true,
              number: refreshed.pullNumber,
              merge_commit_sha: landing,
              base: { ref: "main" },
            },
          },
        },
        transport,
      );
      assert.equal(result.route, "tag");
      assert.equal(s.f.ref("tags/v1.3.0"), landing);
      const tags = await reconcileReleaseTag(
        {
          configuration: request.configuration,
          automation: request.automation,
          token: request.token,
          pullNumber: 1,
          landingSha: landing,
          write: true,
        },
        transport,
      );
      assert.equal(tags.outcome, "unchanged");
      const cycle = await selectReleaseCycle(
        {
          configuration: request.configuration,
          automation: request.automation,
          token: request.token,
          sourceSha: landing,
        },
        transport,
      );
      assert.equal(cycle.outcome, "selected");
      assert.ok(refreshed.headSha && refreshed.proposalId);
      const approval = {
        schemaVersion: 1 as const,
        repositoryId: 1449550207,
        pullNumber: 1,
        approverUserId: 7,
        sourceSha: refreshed.sourceSha,
        headSha: refreshed.headSha,
        landingSha: landing,
        mergeKind: "merge" as const,
        baseline: {
          kind: "tag" as const,
          name: "v1.2.3",
          objectSha: s.f.baseline,
          commitSha: s.f.baseline,
        },
        snapshotId: refreshed.snapshotId,
        proposalId: refreshed.proposalId,
      };
      const approved = {
        repository: s.f.directory,
        configuration: request.configuration,
        policy: { schemaVersion: 1 as const, botUserId: botId, approverUserIds: [7] },
        approval,
        token: request.token,
      };
      const verified = await verifyReleaseApproval(approved, transport);
      assert.ok(
        parseVerifiedReleaseApproval(verified).files.some((file) => file.path === workflowPath),
      );
      const range = await inspectPendingRelease(s.f.directory, approval.baseline, landing);
      const audit = await auditReleaseExclusion({ ...approved, range }, transport);
      assert.ok(audit.excludedCommitShas.includes(created.headSha ?? ""));
      assert.ok(audit.excludedCommitShas.includes(refreshed.headSha));
      assert.ok(audit.excludedCommitShas.includes(landing));
      assert.ok(audit.retainedCommitShas.includes(refreshed.sourceSha));
      assert.equal(s.f.pulls.length, 1);
    });
  });
});

void test("schema-3 0.0.0 predecessor fails closed, then refreshes through an explicitly trusted producer", async (context) => {
  const s = await selfUse(context);
  const activeSha = s.f.baseline;
  const oldDirectory = await producer(context);
  const registry = await loadProducerRuntimes({
    activeSha,
    producers: [{ sha: oldSha, directory: oldDirectory, legacy: true }],
  });
  const old = registry.producers[0];
  assert.ok(old);
  // Capture under the actual separate producer manifest, without rewriting a snapshot.
  const captureModule: {
    captureReleaseSnapshot: typeof captureReleaseSnapshot;
    serializeReleaseSnapshot: typeof serializeReleaseSnapshot;
  } = await import(new URL(`file://${oldDirectory}/dist/src/release-snapshot.ts`).href);
  const baseRequest = await s.f.request(true);
  const request = {
    ...baseRequest,
    configuration: parseReleaseInputConfiguration({
      ...baseRequest.configuration,
      contextPolicy: "required",
      changelog: { verbosity: "concise", format: "compact" },
    }),
  };
  const current = await replayReleaseSnapshot(baseRequest.snapshot, baseRequest.configuration);
  const serialized = await captureModule.serializeReleaseSnapshot(
    await captureModule.captureReleaseSnapshot(current.input, request.configuration),
  );
  const snapshot = await old.replay(serialized, request.configuration);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.tool.version, "0.0.0");
  assert.match(snapshot.tool.normalizerId, /^[a-f0-9]{64}$/u);
  await assert.rejects(replayReleaseSnapshot(serialized, request.configuration), {
    code: "normalizer-mismatch",
  });
  const { GitHubProposalRepository } = await import("../src/github-proposals.ts");
  const api = new GitHubProposalRepository(
    request.configuration,
    botId,
    request.token,
    s.f.transport,
  );
  const source = await api.tree(snapshot.normalized.sourceCommitSha);
  const prepared = await old.prepare(
    serialized,
    request.configuration,
    request.version,
    await api.contents(source),
  );
  const description = old.describe(snapshot, prepared, botId, null);
  const head = await api.commit(source, null, prepared.files, description.message);
  await api.setRef(head, false);
  await api.savePull(null, description.title, description.body);
  await assert.rejects(reconcileReleaseProposal(await s.request(), s.f.transport), {
    code: "normalizer-mismatch",
  });
  const refreshed = await withProducerRuntimes(registry, async () =>
    reconcileReleaseProposal(await s.request(), s.f.transport),
  );
  assert.equal(refreshed.outcome, "refreshed");
  assert.equal(refreshed.pullNumber, 1);
  assert.ok(refreshed.headSha);
  assert.equal(s.f.git(["show", `${head}:.release-log/inputs.json`]), serialized);
  const result = await withProducerRuntimes(registry, async () =>
    reconcileReleaseProposal(await s.request(), s.f.transport),
  );
  assert.equal(result.outcome, "unchanged");
  assert.equal(
    s.f.git(["show", `${refreshed.headSha}:${workflowPath}`]),
    caller.replaceAll(oldSha, refreshed.sourceSha),
  );
});

for (const tamper of ["workflow", "unrelated-workflow", "producer"] as const) {
  void test(`edited ${tamper} is rejected before refresh writes`, async (context) => {
    const s = await selfUse(context);
    const registry = await loadProducerRuntimes({ activeSha: s.f.baseline, producers: [] });
    await withProducerRuntimes(registry, async () => {
      const created = await reconcileReleaseProposal(await s.request(), s.f.transport);
      assert.ok(created.headSha);
      const head = created.headSha;
      let message = s.f.git(["show", "-s", "--format=%B", head]).trimEnd() + "\n";
      let tree = s.f.git(["rev-parse", `${head}^{tree}`]).trim();
      if (tamper === "producer") {
        const marker = /Release-Log-Proposal:\n([\s\S]+)$/u.exec(message);
        assert.ok(marker?.[1]);
        const value = object(
          JSON.parse(
            Buffer.from(marker[1].replaceAll("\n", ""), "base64url").toString("utf8"),
          ) as unknown,
        );
        const encoded = Buffer.from(
          JSON.stringify({ ...value, producerSha: replacementSha }),
        ).toString("base64url");
        message =
          message.slice(0, message.indexOf("Release-Log-Proposal:")) +
          "Release-Log-Proposal:\n" +
          (encoded.match(/.{1,72}/gu) ?? []).join("\n") +
          "\n";
      } else {
        tree = s.f.createTree(tree, [
          {
            path: tamper === "workflow" ? workflowPath : ".github/workflows/unrelated.yml",
            mode: "100644",
            content:
              tamper === "workflow"
                ? s.f
                    .git(["show", `${head}:${workflowPath}`])
                    .replace("contents: read", "contents: write")
                : "name: human edit\n",
          },
        ]);
      }
      const edited = s.f.git(["commit-tree", tree, "-p", created.sourceSha], message).trim();
      s.f.git(["update-ref", "refs/heads/release-log/main", edited, head]);
      const before = s.f.calls.length;
      await assert.rejects(
        reconcileReleaseProposal(await s.request(), s.f.transport),
        tamper === "producer" ? /trusted verification runtime/u : /edited|unrelated file/u,
      );
      assert.ok(s.f.calls.slice(before).every((call) => call.method === "GET"));
    });
  });
}

void test("legacy permission, dependency locks and runtime identities stay default-deny", async (context) => {
  const s = await selfUse(context);
  const directory = await producer(context);
  const registry = await loadProducerRuntimes({
    activeSha: s.f.baseline,
    producers: [{ sha: oldSha, directory, legacy: false }],
  });
  const old = registry.producers[0];
  assert.ok(old);
  const { reconstructProposal } = await import("../src/producer-runtime.ts");
  const request = await s.f.request();
  const module: {
    captureReleaseSnapshot: typeof captureReleaseSnapshot;
    serializeReleaseSnapshot: typeof serializeReleaseSnapshot;
  } = await import(new URL(`file://${directory}/dist/src/release-snapshot.ts`).href);
  const source = await replayReleaseSnapshot(request.snapshot, request.configuration);
  const serialized = await module.serializeReleaseSnapshot(
    await module.captureReleaseSnapshot(source.input, request.configuration),
  );
  const files = {
    "package.json": '{"version":"1.2.3"}',
    "pyproject.toml": null,
    "CHANGELOG.md": null,
    ".release-log/inputs.json": null,
    "package-lock.json": null,
    "npm-shrinkwrap.json": null,
    "uv.lock": null,
  };
  await withProducerRuntimes(registry, async () => {
    await assert.rejects(
      reconstructProposal(serialized, request.configuration, request.version, files, botId, null),
      { code: "normalizer-mismatch" },
    );
    const result = await reconstructProposal(
      serialized,
      request.configuration,
      request.version,
      files,
      botId,
      null,
      oldSha,
    );
    assert.equal(result.snapshot.tool.version, "0.0.0");
    await assert.rejects(
      reconstructProposal(
        serialized,
        request.configuration,
        request.version,
        files,
        botId,
        null,
        replacementSha,
      ),
      /trusted verification runtime/u,
    );
  });
  const changed = await producer(context, "0.0.0", true);
  const wrong = await loadProducerRuntimes({
    activeSha: s.f.baseline,
    producers: [{ sha: oldSha, directory: changed, legacy: true }],
  });
  await withProducerRuntimes(wrong, async () => {
    await assert.rejects(
      reconstructProposal(serialized, request.configuration, request.version, files, botId, null),
      { code: "normalizer-mismatch" },
    );
  });
  const trusted = await loadProducerRuntimes({
    activeSha: s.f.baseline,
    producers: [{ sha: oldSha, directory, legacy: true }],
  });
  const tampered = object(JSON.parse(serialized) as unknown);
  tampered.snapshotId = "0".repeat(64);
  await withProducerRuntimes(trusted, async () => {
    await assert.rejects(
      reconstructProposal(
        JSON.stringify(tampered),
        request.configuration,
        request.version,
        files,
        botId,
        null,
      ),
      { code: "integrity-mismatch" },
    );
  });
  for (const value of [
    { activeSha: "main", producers: [] },
    {
      activeSha: replacementSha,
      producers: [
        { sha: oldSha, directory, legacy: true },
        { sha: oldSha, directory, legacy: true },
      ],
    },
    {
      activeSha: replacementSha,
      producers: [{ sha: oldSha, directory: "relative", legacy: true }],
    },
  ])
    await assert.rejects(loadProducerRuntimes(value));
});

void test("producer reconstruction follows the captured runner version after a package bump", async (context) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "release-tool-version-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ["src", "tests"])
    await cp(join(root, path), join(directory, path), { recursive: true });
  for (const path of ["pnpm-lock.yaml", "commitlint.base.config.mjs"])
    await cp(join(root, path), join(directory, path));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  const manifest = object(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown,
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ ...manifest, version: "9.8.7" }),
  );
  // Run the full transition in another package, without changing the checkout or
  // rewriting captured tool identities. The filter prevents recursive execution.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=^creation, retry, refresh, changed caller pin and merge routing preserve exact-landing tags$",
      "tests/tool-upgrade.test.ts",
    ],
    { cwd: directory, env: environment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.match(stdout, /^# pass 1$/mu);
});
