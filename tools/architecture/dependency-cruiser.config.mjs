const planning = "^src/(planning/|release-plan\\.ts$)";
const configuration = "^src/config/";
const cli = "^src/(cli\\.ts$|cli/)";
const workflows =
  "^src/(release-(cycle|proposal|tag|approval|publication|roll|readiness|plan|snapshot)|changelog\\.ts$|(?:cycle|proposal|tagging|approval|publication|planning|snapshot|changelog)/)";

/** @satisfies {import("dependency-cruiser").IConfiguration} */
const config = {
  forbidden: [
    {
      name: "planning-stays-offline",
      severity: "error",
      from: { path: planning },
      to: {
        path: [
          "^src/(github(?:/|[-.]|\\.ts$)|publication/|release-publication\\.ts$|text-generation\\.ts$|ai-configuration\\.ts$)",
          "(^|/)node_modules/@ai-sdk/",
          "(^|/)node_modules/ai/",
        ],
        reachable: true,
      },
    },
    {
      name: "publication-planner-stays-pure",
      severity: "error",
      from: { path: "^src/publication/plan\\.ts$" },
      to: {
        pathNot: ["^src/publication/types\\.ts$", "^(node:)?crypto$"],
        reachable: true,
      },
    },
    {
      name: "configuration-is-foundational",
      severity: "error",
      from: { path: configuration },
      to: { path: `${cli}|${workflows}`, reachable: true },
    },
    {
      name: "cli-composes-capabilities",
      severity: "error",
      from: { path: "^src/", pathNot: cli },
      to: { path: cli, reachable: true },
    },
    {
      name: "snapshot-independent-of-consumers",
      severity: "error",
      from: { path: "^src/(snapshot/|release-snapshot\\.ts$)" },
      to: {
        path: [
          "^src/(planning|proposal|changelog|publication)/",
          "^src/(changelog|proposal-files|release-(plan|proposal|publication))\\.ts$",
        ],
        reachable: true,
      },
    },
    {
      name: "application-bypasses-proposal-compatibility-facades",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^src/(release-proposal|proposal-files|proposal-identity)\\.ts$" },
    },
    {
      name: "application-bypasses-cycle-and-tag-facades",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^src/release-(cycle|tag)\\.ts$" },
    },
    {
      name: "proposal-phases-owned-by-reconciler",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/proposal/reconcile\\.ts$" },
      to: { path: "^src/proposal/(history|write)\\.ts$" },
    },
    {
      name: "production-independent-of-tests",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(tests/|fixtures/)", reachable: true },
    },
    {
      name: "no-unresolved-local-imports",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^\\.", couldNotResolve: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
  },
};

export default config;

/** @type {import("dependency-cruiser").IForbiddenRuleType[]} */
export const runtimeRules = [
  {
    name: "no-runtime-cycles",
    severity: "error",
    from: { path: "^src/" },
    to: { circular: true },
  },
];
