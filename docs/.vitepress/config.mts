export default {
  lang: "en-US",
  title: "release-log",
  description: "Deterministic PR-based changelogs and AI-assisted release notes",
  base: "/release-log/",
  srcExclude: ["reviews/**"],
  markdown: {
    languageAlias: { "release-log": "yaml" },
  },
  themeConfig: {
    nav: [
      { text: "Overview", link: "/" },
      { text: "PR release context", link: "/release-context" },
      {
        text: "Contributing",
        link: "https://github.com/lhajoosten/release-log/blob/main/CONTRIBUTING.md",
      },
    ],
    sidebar: [
      {
        text: "Project",
        items: [
          { text: "Overview", link: "/" },
          { text: "Release policy", link: "/release-policy" },
          { text: "Documentation site", link: "/github-pages" },
        ],
      },
      {
        text: "Components",
        items: [
          { text: "PR metadata readiness", link: "/pr-readiness" },
          { text: "PR release context", link: "/release-context" },
          { text: "Conventional metadata", link: "/conventional-metadata" },
          { text: "Git range inspection", link: "/git-tag-range" },
          { text: "GitHub PR association", link: "/github-association" },
          { text: "Release input snapshots", link: "/release-snapshot" },
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
