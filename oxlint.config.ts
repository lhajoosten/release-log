import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "node"],
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  options: {
    typeAware: true,
    reportUnusedDisableDirectives: "error",
  },
  rules: {
    "no-debugger": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/consistent-type-imports": "error",
  },
});
