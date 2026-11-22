export default {
  lang: "en-US",
  title: "Rolling Release",
  description: "Deterministic PR-based changelogs and AI-assisted release notes",
  base: "/release-log/",
  srcExclude: ["reviews/**"],
  markdown: {
    languageAlias: { "release-log": "yaml" },
  },
  themeConfig: {
    nav: [
      { text: "Overview", link: "/" },
      { text: "Use the CLI", link: "/cli" },
      { text: "Set up Rolling Release", link: "/consumer-setup" },
      { text: "Maintain Rolling Release", link: "/maintain-rolling-release" },
      {
        text: "Contributing",
        link: "https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md",
      },
    ],
    sidebar: [
      {
        text: "Rolling Release",
        items: [
          { text: "Set up Rolling Release", link: "/consumer-setup" },
          { text: "Maintain Rolling Release", link: "/maintain-rolling-release" },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Overview", link: "/" },
          { text: "Release policy", link: "/release-policy" },
          { text: "Container distribution decision", link: "/adr/0001-container-distribution" },
          { text: "AI SDK integration decision", link: "/adr/0002-ai-sdk-provider-integration" },
          { text: "Documentation site", link: "/github-pages" },
        ],
      },
      {
        text: "Installation and operations",
        items: [
          { text: "Pull and run from GHCR", link: "/container-release#pull-and-run" },
          { text: "Container runtime and local builds", link: "/container" },
          { text: "Container publication and recovery", link: "/container-release" },
          { text: "Container vulnerability review", link: "/container-security" },
          { text: "Rolling workflow and recovery", link: "/release-workflow" },
          { text: "Deterministic CLI", link: "/cli" },
        ],
      },
      {
        text: "Deterministic components",
        items: [
          { text: "Initial adoption", link: "/initial-adoption" },
          { text: "PR metadata readiness", link: "/pr-readiness" },
          { text: "PR release context", link: "/release-context" },
          { text: "Conventional metadata", link: "/conventional-metadata" },
          { text: "Git range inspection", link: "/git-tag-range" },
          { text: "GitHub PR association", link: "/github-association" },
          { text: "Release input snapshots", link: "/release-snapshot" },
          { text: "Release version planning", link: "/release-plan" },
          { text: "Deterministic changelog", link: "/changelog" },
          { text: "Verify published image", link: "/release-rehearsal" },
          { text: "Release proposal controller", link: "/release-proposal" },
        ],
      },
      {
        text: "Separate integration APIs",
        items: [
          { text: "Optional text generation", link: "/text-generation" },
          { text: "Release approval verification", link: "/release-approval" },
          { text: "Verified automation exclusions", link: "/automation-exclusions" },
          { text: "Publication reconciliation/execution", link: "/release-publication" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/lhajoosten/release-log" }],
    editLink: {
      pattern: "https://github.com/lhajoosten/release-log/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    outline: [2, 3],
    footer: {
      message:
        'Released under the <a href="https://github.com/lhajoosten/release-log/blob/main/LICENSE.md">MIT License</a>.',
    },
  },
};
