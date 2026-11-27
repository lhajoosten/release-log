# Contributing

Use the Node version in `.node-version` and the pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`. Run `pnpm verify` for formatting, type-aware lint, strict TypeScript checks, the test suite, CLI compilation and the documentation build. Use `node --test tests/<file>.test.ts` for a focused test.

The CLI in `src/cli.ts` dispatches to the Git and GitHub controllers. Release planning and Markdown rendering share a pure implementation in `src/release/core.ts`. Version adapters plan file changes before the controller writes them. Registry publication verifies and reuses an existing image by digest.

Tests use temporary Git repositories, controlled GitHub responses and synthetic registry data. Never use a production credential or publish a release to exercise local tests.
