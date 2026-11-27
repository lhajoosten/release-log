export default {
  title: "Rolling Release",
  base: "/rolling-release/",
  description: "Deterministic GitHub releases from merged PR titles",
  srcExclude: [
    "adr/**",
    "engineering/**",
    "rfc/**",
    "spec/77-release-export.md",
    "spec/78-release-candidates.md",
  ],
  themeConfig: {
    nav: [
      { text: "Setup", link: "/consumer-setup" },
      { text: "Operations", link: "/release-workflow" },
      { text: "Release contract", link: "/spec/186-release-cycle" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/lhajoosten/rolling-release" }],
  },
};
