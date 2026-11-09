import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { checkInventory, installScanner, summarizeMatches } from "../scripts/scan-container.ts";

void test("security workflow runs unprivileged scans and retains failure evidence with pinned Actions", async () => {
  const workflow: unknown = parse(
    await readFile(new URL("../.github/workflows/container-security.yml", import.meta.url), "utf8"),
  );
  assert.ok(
    typeof workflow === "object" &&
      workflow !== null &&
      "on" in workflow &&
      "permissions" in workflow &&
      "jobs" in workflow,
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(typeof workflow.on === "object" && workflow.on !== null);
  assert.ok("pull_request" in workflow.on && "schedule" in workflow.on);
  assert.ok(!("pull_request_target" in workflow.on) && !("workflow_run" in workflow.on));
  assert.ok(typeof workflow.jobs === "object" && workflow.jobs !== null && "scan" in workflow.jobs);
  const job = workflow.jobs.scan;
  assert.ok(typeof job === "object" && job !== null && "steps" in job && Array.isArray(job.steps));
  let uploadsFailureEvidence = false;
  for (const step of job.steps) {
    assert.ok(typeof step === "object" && step !== null);
    if ("uses" in step) {
      assert.equal(typeof step.uses, "string");
      assert.match(String(step.uses), /@[a-f0-9]{40}$/u);
      if (String(step.uses).startsWith("actions/checkout@")) {
        assert.ok("with" in step);
        assert.deepEqual(step.with, { "persist-credentials": false });
      }
      if (String(step.uses).startsWith("actions/upload-artifact@")) {
        assert.ok("if" in step && "with" in step);
        assert.equal(step.if, "always()");
        assert.ok(typeof step.with === "object" && step.with !== null && "path" in step.with);
        assert.equal(step.with.path, "reports/container-security/");
        uploadsFailureEvidence = true;
      }
    }
  }
  assert.equal(uploadsFailureEvidence, true);
});

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/scan-container.ts", import.meta.url));
const packages = [
  { name: "libc6", type: "deb", version: "2.36" },
  {
    name: "node",
    type: "binary",
    version: "26.13.0",
    cpes: [{ cpe: "cpe:2.3:a:nodejs:node.js:26.13.0:*:*:*:*:*:*:*" }],
  },
  { name: "@commitlint/lint", type: "npm", version: "21.2.4" },
];

void test("inventory must include OS packages, the independent Node runtime and production dependencies", () => {
  assert.deepEqual(checkInventory({ artifacts: packages }), {
    packageCount: 3,
    nodeVersion: "26.13.0",
  });
  assert.deepEqual(
    checkInventory({
      artifacts: packages.map((pkg) =>
        pkg.type === "deb" ? { name: "musl", type: "apk", version: "1.2.6-r3" } : pkg,
      ),
    }),
    { packageCount: 3, nodeVersion: "26.13.0" },
  );
  assert.throws(
    () =>
      checkInventory({
        artifacts: packages.map((pkg) => (pkg.type === "deb" ? { ...pkg, type: "unknown" } : pkg)),
      }),
    /Incomplete inventory/u,
  );
  for (const pkg of packages)
    assert.throws(
      () => checkInventory({ artifacts: packages.filter((item) => item !== pkg) }),
      /Incomplete inventory/u,
    );
  assert.throws(
    () => checkInventory({ artifacts: [{ name: "node", type: "npm" }] }),
    /Incomplete inventory/u,
  );
  for (const input of [null, [], {}, { artifacts: [null] }])
    assert.throws(() => checkInventory(input));
  assert.throws(
    () => checkInventory({ artifacts: packages.map((pkg) => ({ ...pkg, cpes: [] })) }),
    /matching vulnerability CPE/u,
  );
});

for (const severity of ["Negligible", "Low", "Medium", "High", "Critical", "Unknown"]) {
  void test(`vulnerability policy handles ${severity}, including unfixed findings`, () => {
    for (const state of ["fixed", "not-fixed", "wont-fix", "unknown"]) {
      assert.deepEqual(
        summarizeMatches({
          matches: [{ vulnerability: { id: "CVE-fixture", severity, fix: { state } } }],
        }),
        { counts: { [severity]: 1 }, blocked: ["High", "Critical", "Unknown"].includes(severity) },
      );
    }
  });
}

void test("vulnerability policy counts package/advisory matches and rejects malformed reports", () => {
  assert.deepEqual(summarizeMatches({ matches: [] }), { counts: {}, blocked: false });
  assert.deepEqual(
    summarizeMatches({
      matches: [
        { vulnerability: { id: "CVE-fixture", severity: "High" } },
        { vulnerability: { id: "CVE-fixture", severity: "High" } },
        { vulnerability: { id: "CVE-other", severity: "Low" } },
      ],
    }),
    { counts: { High: 2, Low: 1 }, blocked: true },
  );
  for (const input of [
    null,
    {},
    { matches: null },
    { matches: [null] },
    { matches: [{ vulnerability: {} }] },
    { matches: [{ vulnerability: { id: "CVE-fixture", severity: "unexpected" } }] },
  ])
    assert.throws(() => summarizeMatches(input));
});

void test("scanner downloads fail closed before extraction on HTTP failures or checksum mismatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-scanner-pin-"));
  try {
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response("missing", { status: 404 }),
    );
    await assert.rejects(installScanner("syft", directory), /HTTP 404/u);
    fetchMock.mock.mockImplementation(async () => new Response("not the pinned scanner archive"));
    await assert.rejects(installScanner("grype", directory), /checksum mismatch/u);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("scan CLI rejects unknown arguments without starting Docker or downloads", async () => {
  await assert.rejects(
    execute(process.execPath, [script, "--image", "fixture:local", "--push"], { timeout: 10_000 }),
    /Usage:/u,
  );
});

void test(
  "scan refuses existing evidence without overwriting a previous result",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-scan-evidence-"));
    try {
      const evidence = join(directory, "evidence.json");
      await writeFile(evidence, "previous result\n");
      await assert.rejects(
        execute(process.execPath, [script, "--image", "fixture:local", "--output", directory], {
          timeout: 10_000,
        }),
        /EEXIST/u,
      );
      assert.equal(await readFile(evidence, "utf8"), "previous result\n");
      assert.deepEqual(await readdir(directory), ["evidence.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  "invalid local image records failure, inherits no scanner overrides or tokens, and never pulls",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-scan-boundary-"));
    try {
      const bin = join(directory, "bin");
      const output = join(directory, "output");
      const calls = join(directory, "docker-call.json");
      await mkdir(bin);
      const docker = join(bin, "docker");
      await writeFile(
        docker,
        `#!${process.execPath}\nimport {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),env:process.env})); console.log(JSON.stringify([{Id:"sha256:${"a".repeat(64)}",Os:"linux",Architecture:"arm64"}]));\n`,
      );
      await chmod(docker, 0o755);
      await assert.rejects(
        execute(process.execPath, [script, "--image", "fixture:local", "--output", output], {
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: bin,
            GITHUB_TOKEN: "synthetic-unused-token",
            GRYPE_DB_VALIDATE_AGE: "false",
            SYFT_CHECK_FOR_APP_UPDATE: "true",
          },
        }),
        /Linux\/amd64/u,
      );
      const call: unknown = JSON.parse(await readFile(calls, "utf8"));
      assert.ok(typeof call === "object" && call !== null && "args" in call && "env" in call);
      assert.deepEqual(call.args, ["image", "inspect", "fixture:local"]);
      assert.ok(!JSON.stringify(call.env).includes("synthetic-unused-token"));
      assert.ok(!JSON.stringify(call.env).includes("GRYPE_"));
      assert.ok(!JSON.stringify(call.env).includes("SYFT_"));
      assert.deepEqual(await readdir(output), ["failure.json"]);
      assert.match(await readFile(join(output, "failure.json"), "utf8"), /Linux\/amd64/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
