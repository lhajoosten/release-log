# Changelog

<!-- release-log:pending:v1 sha256:89d8459d3a6fb2d6ea7bcc1f1da7a6a8fcdcf7cbbe750e00a7b33755a5354cb2 -->

## v0.1.0

Initial release of the captured repository state.

> Historical entries predate onboarding and may lack current release metadata. Review their sources and breaking warnings; no missing impact or migration instructions are inferred.

### Features

- Support reviewed initial adoption without rewriting legacy repository metadata&#46; ([#41](https://github.com/lhajoosten/release-log/pull/41))
- Configure detailed&#44; concise or one&#45;line changelog entries while retaining release safety instructions&#46; ([#44](https://github.com/lhajoosten/release-log/pull/44))
- Inspect approved release publication state without creating tags&#44; Releases or artifacts ([#46](https://github.com/lhajoosten/release-log/pull/46))
- Add explicit&#45;write execution of approved GitHub tag&#44; Release and asset steps ([#50](https://github.com/lhajoosten/release-log/pull/50))
- Add opt&#45;in strict approval checks for native GitHub reviews and trusted workflow results ([#51](https://github.com/lhajoosten/release-log/pull/51))
- Add tag&#45;only reconciliation for manually merged release proposals&#46; ([#54](https://github.com/lhajoosten/release-log/pull/54))
- Allow consumers to configure optional structured PR release context&#46; ([#59](https://github.com/lhajoosten/release-log/pull/59))
- Add a compact changelog layout with collapsed internal maintenance and visible safety information&#46; ([#64](https://github.com/lhajoosten/release-log/pull/64))

### Documentation

- Add a GitHub Pages documentation site for release&#45;log&#46; ([#28](https://github.com/lhajoosten/release-log/pull/28))

### Historical changes

- &#91;historical PR&#93; chore&#58; set up basic repository tooling ([#1](https://github.com/lhajoosten/release-log/pull/1))
  - Historical context unavailable; review the linked source.
- &#91;historical PR&#93; feat&#58; validate conventional change metadata ([#2](https://github.com/lhajoosten/release-log/pull/2))
  - Historical context unavailable; review the linked source.
- &#91;historical PR&#93; feat&#58; inspect exact Git tag ranges ([#3](https://github.com/lhajoosten/release-log/pull/3))
  - Historical context unavailable; review the linked source.
- &#91;historical commit&#93; chore&#58; add MIT license and local ignore rules ([4d283a455871](https://github.com/lhajoosten/release-log/commit/4d283a455871973bc79b0088fc3d4aea1bac0a7b))
  - Historical context unavailable; review the linked source.

### Breaking changes

- retain historical commit&#45;only entries; snapshots and plans use schema version 2&#46; Recapture snapshots with the new tool and update plan readers&#59; version 1 data is not migrated automatically&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40))
- snapshots and plans now use schema 3&#46; Recapture old inputs and configure a fixed schema&#45;2 onboarding record before initial collection&#46;; support initial repository adoption ([#41](https://github.com/lhajoosten/release-log/pull/41))

### Required actions

- Use unscoped conventional commit subjects and scoped conventional PR titles&#46; Remove the scope from the final commit subject when squash merging&#46; ([#5](https://github.com/lhajoosten/release-log/pull/5))
- Complete the v1 release context before merging PRs&#59; validate rollout before making the metadata check required&#46; ([#27](https://github.com/lhajoosten/release-log/pull/27))
- Recapture version 1 snapshots with the new tool and update plan readers for schema version 2&#59; no automatic migration is performed&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40))
- Use schema&#45;2 configuration with fixed bootstrap baselineSha and onboardingSha for initial collection&#59; use the original pinned tool for old snapshots or explicitly recapture and review schema&#45;3 snapshots and plans&#46; ([#41](https://github.com/lhajoosten/release-log/pull/41))
- Rerun verification rather than reuse cached verification IDs&#59; verification evidence now binds automation commit IDs and prior proposal heads must replay with compatible pinned configuration and tooling&#46; ([#43](https://github.com/lhajoosten/release-log/pull/43))
- When opting in or changing changelog&#46;verbosity&#44; recapture and review release inputs so proposal and approval identities use the selected format&#46; ([#44](https://github.com/lhajoosten/release-log/pull/44))
- To enable exclusions&#44; pin freshly recomputed verification IDs and supply independently trusted original approval authorities&#59; use a compatible tool for schema&#45;4 captures rather than relabeling schema&#45;3 inputs or reusing cached verification IDs&#46; ([#45](https://github.com/lhajoosten/release-log/pull/45))
- Review the musl runtime and locked APK availability constraints before adopting the image&#59; arbitrary glibc&#45;dependent consumer binaries are not supported&#44; and private&#45;registry access remains unverified&#46; ([#48](https://github.com/lhajoosten/release-log/pull/48))
- Review the pinned tool revision and configure the GitHub App and caller only under separate rollout approval&#46; ([#57](https://github.com/lhajoosten/release-log/pull/57))
- Review the first eligible dry&#45;run result before authorizing live activation&#46; ([#58](https://github.com/lhajoosten/release-log/pull/58))
- When opting in&#44; use a compatible pinned tool&#44; align the trusted metadata gate policy with release configuration&#44; and capture a fresh reviewed snapshot&#46; ([#59](https://github.com/lhajoosten/release-log/pull/59))
- Review the generated version&#44; changelog and captured inputs before manually merging each release PR&#46; ([#60](https://github.com/lhajoosten/release-log/pull/60))
- Review the next automatic rolling&#45;release result and the generated proposal before manually merging a release PR&#46; ([#61](https://github.com/lhajoosten/release-log/pull/61))
- Observe the refreshed release PR checks after merging this source correction&#44; then review its generated version&#44; changelog and captured inputs before release merge&#46; ([#63](https://github.com/lhajoosten/release-log/pull/63))

<details>
<summary>Internal maintenance</summary>

- &#91;historical PR&#93; feat&#58; parse structured PR release context ([#4](https://github.com/lhajoosten/release-log/pull/4))
- Fix post&#45;merge CI validation and distinguish commit and PR title formats&#46; ([#5](https://github.com/lhajoosten/release-log/pull/5))
- Validate PR release metadata before merge&#46; ([#27](https://github.com/lhajoosten/release-log/pull/27))
- Inspect pending release history from an explicit baseline to a captured commit&#46; ([#30](https://github.com/lhajoosten/release-log/pull/30))
- Associate captured release commits with their merged GitHub PRs&#46; ([#31](https://github.com/lhajoosten/release-log/pull/31))
- Capture validated release inputs and replay them offline&#46; ([#32](https://github.com/lhajoosten/release-log/pull/32))
- Calculate deterministic release versions from validated snapshots&#46; ([#33](https://github.com/lhajoosten/release-log/pull/33))
- Render deterministic changelog entries and replace the owned pending section&#46; ([#34](https://github.com/lhajoosten/release-log/pull/34))
- Package deterministic release commands with Node and Python version&#45;file support&#46; ([#35](https://github.com/lhajoosten/release-log/pull/35))
- Add a manual read&#45;only release rehearsal for this repository&#46; ([#36](https://github.com/lhajoosten/release-log/pull/36))
- Add opt&#45;in creation and refresh of draft release proposals&#46; ([#37](https://github.com/lhajoosten/release-log/pull/37))
- Verify independently recorded release proposals against their actual merged landings&#46; ([#38](https://github.com/lhajoosten/release-log/pull/38))
- Build and test a local Linux container around the packaged release CLI&#46; ([#39](https://github.com/lhajoosten/release-log/pull/39))
- Retain eligible unassociated historical commits during explicit bootstrap planning&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40))
- Capture exact reviewed proposal identities before merge and finalize records against a trusted merge outcome&#46; ([#42](https://github.com/lhajoosten/release-log/pull/42))
- Verify generated proposal ancestry and audit exact automation&#45;only release footprints&#46; ([#43](https://github.com/lhajoosten/release-log/pull/43))
- Apply independently pinned release&#45;automation verification during collection and offline replay&#46; ([#45](https://github.com/lhajoosten/release-log/pull/45))
- Isolate commit checks from Git environment routing exported by linked&#45;worktree hooks&#46; ([#47](https://github.com/lhajoosten/release-log/pull/47))
- Scan built container runtime packages and replace the vulnerable base with pinned Alpine packages&#46; ([#48](https://github.com/lhajoosten/release-log/pull/48))
- Select a verified release boundary and report pending release tags&#46; ([#55](https://github.com/lhajoosten/release-log/pull/55))
- Continue release proposals from verified tagged landings&#46; ([#56](https://github.com/lhajoosten/release-log/pull/56))
- Connect rolling release proposals and exact&#45;landing version tags&#46; ([#57](https://github.com/lhajoosten/release-log/pull/57))
- Add the source&#45;pinned rolling release dry&#45;run caller&#46; ([#58](https://github.com/lhajoosten/release-log/pull/58))
- Enable the repository&#39;s live rolling release caller with the reviewed context&#45;policy implementation&#46; ([#60](https://github.com/lhajoosten/release-log/pull/60))
- Handle GitHub&#39;s omitted final commit&#45;message newline during rolling release verification&#46; ([#61](https://github.com/lhajoosten/release-log/pull/61))
- Allow CI to validate generated releases while preserving canonical snapshot bytes&#46; ([#63](https://github.com/lhajoosten/release-log/pull/63))

</details>

<!-- release-log:pending:end -->
