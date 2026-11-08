# Documentation site

The documentation site uses VitePress to render the maintained Markdown in `docs/`. Component pages remain readable on GitHub; there is no separate generated copy to edit.

## Local development

Use the Node.js and pnpm versions pinned by the repository. Follow the [contribution guide](https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md) for setup, then run from the repository root:

```sh
pnpm docs:dev
```

Open the `/release-log/` URL printed by VitePress. To check the production output instead:

```sh
pnpm docs:build
pnpm docs:preview
```

The build writes static files to `docs/.vitepress/dist/` and fails on broken internal page links. Both output and the VitePress cache are ignored by Git and formatting checks. `pnpm verify` includes the production docs build alongside the existing source checks and tests.

## GitHub Pages setup

Adding this workflow does not enable Pages or change repository visibility. A repository administrator must complete these steps before deployment can succeed:

1. Confirm GitHub Pages is available for this private repository under the account's plan. Do not make the repository public just to enable it.
2. Review the documentation for publication and confirm the site's intended visibility. Pages sites can be public even when their source repository is private; do not assume source-repository permissions protect the published site. If private access is required, verify the account supports it and configure access before publishing.
3. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
4. Review the `github-pages` environment's protection rules and restrict deployments to `main`. Require approval if publication needs an additional review step.
5. After the workflow has merged, run **Documentation → Run workflow** against `main`, or push a documentation update to `main`.

With the default project-site URL, the site is served at `https://lhajoosten.github.io/release-log/`. That address is the intended destination, not evidence that deployment has occurred. The workflow's deployment environment reports the actual URL after a successful run.

## Build and deployment boundaries

The Quality workflow builds the site on PRs through `pnpm verify`, with read-only repository permissions. PRs do not deploy documentation or receive Pages write permissions.

The separate Documentation workflow builds and uploads only `docs/.vitepress/dist/` on pushes to `main` or manual runs against `main`. Its deployment job alone receives `pages: write` and `id-token: write`, and it targets the `github-pages` environment. External actions are pinned to immutable SHAs.

The VitePress configuration sets the `/release-log/` base path, sidebar, and browser-local search. Search does not send queries to a hosted search service. `docs/reviews/` is excluded from site content; only reviewed documentation should be added under `docs/`. Do not put secrets or private runtime data in Markdown or public assets.

Add new pages to the sidebar in `docs/.vitepress/config.mts` and link them from the relevant guide. If the repository is renamed or the site moves to a custom domain, update the base path and destination documented here before deploying.
