import assert from "node:assert/strict";
import { analyzeSource } from "./analyze.mjs";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

/** @param {string} root
 * @param {string} path
 * @param {string} contents
 */
function write(root, path, contents) {
  const file = resolve(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** @param {string} root */
async function cruise(root) {
  const original = process.cwd();
  try {
    process.chdir(root);
    const { ownership, runtime } = await analyzeSource();
    return {
      status: ownership.summary.advisedExitCode || runtime.summary.advisedExitCode,
      names: [...ownership.summary.violations, ...runtime.summary.violations].map(
        (violation) => violation.rule.name,
      ),
    };
  } finally {
    process.chdir(original);
  }
}

/** @type {Array<[string, string, Record<string, string>]>} */
const cases = [
  [
    "direct planning violation",
    "planning-stays-offline",
    {
      "src/planning/plan.ts": "import '../github.ts';",
      "src/github.ts": "export const transport = 1;",
    },
  ],
  [
    "indirect planning violation",
    "planning-stays-offline",
    {
      "src/planning/plan.ts": "import '../helper.ts';",
      "src/helper.ts": "import './github.ts';",
      "src/github.ts": "export const transport = 1;",
    },
  ],
  [
    "type-only planning violation",
    "planning-stays-offline",
    {
      "src/planning/plan.ts":
        "import type { Transport } from '../github.ts'; export type T = Transport;",
      "src/github.ts": "export type Transport = string;",
    },
  ],
  [
    "publication planner cannot reach the filesystem through its types module",
    "publication-planner-stays-pure",
    {
      "src/publication/plan.ts":
        "import type { State } from './types.ts'; export type Input = State;",
      "src/publication/types.ts":
        "import type { Stats } from 'node:fs'; export type State = Stats;",
    },
  ],
  [
    "publication planner cannot import a transport adapter",
    "publication-planner-stays-pure",
    {
      "src/publication/plan.ts": "import './registry.ts';",
      "src/publication/registry.ts": "export {};",
    },
  ],
  [
    "configuration violation",
    "configuration-is-foundational",
    {
      "src/config/repository.ts": "import '../release-proposal.ts';",
      "src/release-proposal.ts": "export const workflow = 1;",
    },
  ],
  [
    "CLI violation",
    "cli-composes-capabilities",
    { "src/release-proposal.ts": "import './cli.ts';", "src/cli.ts": "export const cli = 1;" },
  ],
  [
    "snapshot replay cannot depend transitively on a proposal consumer",
    "snapshot-independent-of-consumers",
    {
      "src/snapshot/replay.ts": "import './model.ts';",
      "src/snapshot/model.ts":
        "import type { Proposal } from '../proposal/prepare.ts'; export type T = Proposal;",
      "src/proposal/prepare.ts": "export type Proposal = string;",
    },
  ],
  [
    "application cannot import a compatibility facade",
    "application-bypasses-proposal-compatibility-facades",
    {
      "src/consumer.ts": "import type { T } from './proposal-files.ts'; export type U = T;",
      "src/proposal-files.ts": "export type T = string;",
    },
  ],
  [
    "rolling release imports cycle selection from its owner",
    "application-bypasses-cycle-and-tag-facades",
    {
      "src/release-roll.ts": "import './release-cycle.ts';",
      "src/release-cycle.ts": "export {};",
    },
  ],
  [
    "tag result types come from their owning module",
    "application-bypasses-cycle-and-tag-facades",
    {
      "src/release-roll.ts":
        "import type { Result } from './release-tag.ts'; export type R = Result;",
      "src/release-tag.ts": "export type Result = string;",
    },
  ],
  [
    "application imports approval from the owning module",
    "application-bypasses-approval-facades",
    {
      "src/consumer.ts": "import './release-approval.ts';",
      "src/release-approval.ts": "export {};",
    },
  ],
  [
    "record decoding cannot reach verification through a shared helper",
    "approval-records-independent-of-workflows",
    {
      "src/approval/record.ts": "import './helper.ts';",
      "src/approval/helper.ts": "import type { T } from './verify.ts'; export type R = T;",
      "src/approval/verify.ts": "export type T = string;",
    },
  ],
  [
    "proposal write phase is private to the reconciler",
    "proposal-phases-owned-by-reconciler",
    {
      "src/release-tag.ts": "import './proposal/write.ts';",
      "src/proposal/write.ts": "export {};",
    },
  ],
  [
    "test dependency violation",
    "production-independent-of-tests",
    {
      "src/helper.ts": "import '../tests/fixture.ts';",
      "tests/fixture.ts": "export const fixture = 1;",
    },
  ],
  [
    "unresolved local import",
    "no-unresolved-local-imports",
    { "src/helper.ts": "import './missing.ts';" },
  ],
  [
    "runtime cycle",
    "no-runtime-cycles",
    { "src/a.ts": "import './b.ts';", "src/b.ts": "import './a.ts';" },
  ],
];

for (const [label, contract, files] of cases) {
  void test(`${label} fails and removal restores a pass`, async () => {
    const root = mkdtempSync(resolve(tmpdir(), "release-log-architecture-"));
    try {
      write(
        root,
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
      );
      write(root, "src/release-proposal.ts", "import './planning/plan.ts';");
      write(root, "src/planning/plan.ts", "export const plan = 1;");
      for (const [path, contents] of Object.entries(files)) write(root, path, contents);
      const failed = await cruise(root);
      assert.notEqual(failed.status, 0);
      assert.ok(failed.names.includes(contract), `${contract}: ${failed.names.join(", ")}`);
      for (const path of Object.keys(files)) write(root, path, "export {};");
      assert.deepEqual(await cruise(root), { status: 0, names: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

void test("workflow may import planning and type-only cycles are allowed", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "release-log-architecture-"));
  try {
    write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    write(root, "src/release-proposal.ts", "export { reconcile } from './proposal/reconcile.ts';");
    write(
      root,
      "src/proposal/reconcile.ts",
      "import './history.ts'; import './write.ts'; import '../planning/plan.ts'; export const reconcile = 1;",
    );
    write(root, "src/proposal/history.ts", "export {};");
    write(root, "src/proposal/write.ts", "export {};");
    write(root, "src/planning/plan.ts", "import type { B } from '../b.ts'; export type A = B;");
    write(root, "src/b.ts", "import type { A } from './planning/plan.ts'; export type B = A;");
    assert.deepEqual(await cruise(root), { status: 0, names: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("a mixed cycle is allowed while a parallel runtime cycle fails", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "release-log-architecture-"));
  try {
    write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    write(root, "src/a.ts", "import './b.ts';");
    write(root, "src/b.ts", "import type { A } from './a.ts'; export type B = A;");
    assert.deepEqual(await cruise(root), { status: 0, names: [] });
    write(root, "src/b.ts", "import './a.ts'; import type { A } from './a.ts'; export type B = A;");
    const failed = await cruise(root);
    assert.notEqual(failed.status, 0);
    assert.ok(failed.names.includes("no-runtime-cycles"));
    write(root, "src/b.ts", "export {};");
    assert.deepEqual(await cruise(root), { status: 0, names: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("planning cannot import a pnpm-resolved provider", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "release-log-architecture-"));
  try {
    write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    mkdirSync(resolve(root, "node_modules/@ai-sdk"), { recursive: true });
    symlinkSync(
      resolve(process.cwd(), "node_modules/@ai-sdk/openai"),
      resolve(root, "node_modules/@ai-sdk/openai"),
      "dir",
    );
    write(root, "src/planning/plan.ts", "import '@ai-sdk/openai';");
    const failed = await cruise(root);
    assert.notEqual(failed.status, 0);
    assert.ok(failed.names.includes("planning-stays-offline"));
    write(root, "src/planning/plan.ts", "export {};");
    assert.deepEqual(await cruise(root), { status: 0, names: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("runtime triangle is detected despite shorter mixed cycles", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "release-log-architecture-"));
  try {
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          verbatimModuleSyntax: true,
        },
      }),
    );
    write(
      root,
      "src/a.ts",
      "import './b.ts'; export type { T as Previous } from './c.ts'; export type T = number;",
    );
    write(
      root,
      "src/b.ts",
      "import './c.ts'; export type { T as Previous } from './a.ts'; export type T = number;",
    );
    write(
      root,
      "src/c.ts",
      "import './a.ts'; export type { T as Previous } from './b.ts'; export type T = number;",
    );
    const failed = await cruise(root);
    assert.notEqual(failed.status, 0);
    assert.ok(failed.names.includes("no-runtime-cycles"));
    write(root, "src/c.ts", "export type { T as Previous } from './b.ts'; export type T = number;");
    assert.deepEqual(await cruise(root), { status: 0, names: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
