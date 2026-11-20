import { analyzeSource } from "./analyze.mjs";
import manifest from "./package.json" with { type: "json" };

const { ownership: graph, runtime } = await analyzeSource();
const compiler = graph.summary.environment.transpilersFound.find(
  (entry) => entry.name === "typescript",
);
if (
  !compiler?.available ||
  compiler.currentVersion !== `typescript@${manifest.devDependencies.typescript}`
) {
  console.error(
    `Architecture analysis requires the isolated TypeScript ${manifest.devDependencies.typescript} compiler`,
  );
  process.exitCode = 1;
}
/** @type {Array<[string, string, import("dependency-cruiser").DependencyType]>} */
const edges = [
  ["src/cli.ts", "src/cli/planning.ts", "import"],
  ["src/cli/planning.ts", "src/cli/versioned-input.ts", "import"],
  ["src/snapshot/evidence.ts", "src/approval/record.ts", "import"],
  ["src/publication/inspect.ts", "src/approval/verify.ts", "import"],
  ["src/cycle/select.ts", "src/tagging/reconcile.ts", "import"],
  ["src/release-roll.ts", "src/cycle/select.ts", "import"],
  ["src/publication/inspect.ts", "src/publication/plan.ts", "import"],
  ["src/release-plan.ts", "src/planning/derive-release-plan.ts", "import"],
  ["src/release-proposal.ts", "src/proposal/reconcile.ts", "export"],
  ["src/proposal/reconcile.ts", "src/proposal/history.ts", "import"],
  ["src/proposal/reconcile.ts", "src/proposal/write.ts", "import"],
  ["src/proposal-identity.ts", "src/proposal/identity.ts", "export"],
  ["src/planning/derive-release-plan.ts", "src/snapshot/model.ts", "type-only"],
  ["src/release-snapshot.ts", "src/snapshot/replay.ts", "export"],
];
for (const [from, to, type] of edges) {
  const module = graph.modules.find((entry) => entry.source === from);
  if (
    !module?.dependencies.some(
      (dependency) => dependency.resolved === to && dependency.dependencyTypes.includes(type),
    )
  ) {
    console.error(`Architecture graph is missing ${type} edge ${from} -> ${to}`);
    process.exitCode = 1;
  }
}
const runtimePlanning = runtime.modules.find(
  (entry) => entry.source === "src/planning/derive-release-plan.ts",
);
if (
  !runtimePlanning ||
  runtimePlanning.dependencies.some((dependency) => dependency.resolved === "src/snapshot/model.ts")
) {
  console.error("Runtime graph must omit the planning type-only import");
  process.exitCode = 1;
}
const runtimeWrapper = runtime.modules.find((entry) => entry.source === "src/release-plan.ts");
if (
  !runtimeWrapper?.dependencies.some(
    (dependency) => dependency.resolved === "src/planning/derive-release-plan.ts",
  )
) {
  console.error("Runtime graph is missing the planning import");
  process.exitCode = 1;
}
const provider = graph.modules.find((entry) => entry.source === "src/text-generation.ts");
if (
  !provider?.dependencies.some((dependency) =>
    /(?:^|\/)node_modules\/@ai-sdk\/openai\//.test(dependency.resolved),
  )
) {
  console.error("Architecture graph is missing the pnpm-resolved OpenAI provider import");
  process.exitCode = 1;
}
for (const violation of [...graph.summary.violations, ...runtime.summary.violations]) {
  console.error(`${violation.rule.name}: ${violation.from} -> ${violation.to}`);
}
if (graph.summary.advisedExitCode !== 0 || runtime.summary.advisedExitCode !== 0)
  process.exitCode = 1;
if (!process.exitCode)
  console.log(`Architecture contracts passed (${graph.modules.length} modules).`);
