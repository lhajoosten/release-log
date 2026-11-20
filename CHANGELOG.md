# Changelog

<!-- release-log:pending:v1 sha256:c5969849e381df07aec0050be48210be2e1b6127257d75b08653f671f6aa3b2d -->

## v0.5.0 (2026-11-20)

### ✨ Features

- Preview the pending changelog in release pull requests&#46; ([#104](https://github.com/lhajoosten/release-log/pull/104)) by [&#64;lhajoosten](https://github.com/lhajoosten)

### 🐛 Fixes

- Accept conventional commits with or without scopes during ordinary release validation&#46; ([#106](https://github.com/lhajoosten/release-log/pull/106)) by [&#64;lhajoosten](https://github.com/lhajoosten)

<details>
<summary>🔧 Internal maintenance</summary>

- Skip redundant CI builds on generated release proposals&#46; ([#105](https://github.com/lhajoosten/release-log/pull/105)) by [&#64;lhajoosten](https://github.com/lhajoosten)

</details>

<br>

Full changelog: [v0&#46;4&#46;1&#8230;092309d63c8acd9eacef35a8debc787d1908e248](https://github.com/lhajoosten/release-log/compare/v0.4.1...092309d63c8acd9eacef35a8debc787d1908e248) (captured source).

<!-- release-log:pending:end -->

## v0.4.1 (2026-11-19)

### 🐛 Fixes

- Recognize stacked pull requests during initial release adoption&#46; ([#94](https://github.com/lhajoosten/release-log/pull/94)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Update the release&#45;log container to Node&#46;js 26&#46;13&#46;1&#46; ([#95](https://github.com/lhajoosten/release-log/pull/95)) by [&#64;lhajoosten](https://github.com/lhajoosten)

<details>
<summary>🔧 Internal maintenance</summary>

- Document a proposed release candidate and stable promotion policy&#46; ([#97](https://github.com/lhajoosten/release-log/pull/97)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Propose a versioned JSON export contract for reviewed releases&#46; ([#98](https://github.com/lhajoosten/release-log/pull/98)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Record the owner&#8217;s closure of adoption issue &#35;26&#46; ([#99](https://github.com/lhajoosten/release-log/pull/99)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Wait for the exact main&#45;push Quality result before proposing a release&#45;log self&#45;upgrade&#46; ([#100](https://github.com/lhajoosten/release-log/pull/100)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Propose the first deterministic release notes contract&#46; ([#101](https://github.com/lhajoosten/release-log/pull/101)) by [&#64;lhajoosten](https://github.com/lhajoosten)

</details>

<br>

Full changelog: [v0&#46;4&#46;0&#8230;9e1659722e0c5e3dd1a216343ea9763ce461c5b0](https://github.com/lhajoosten/release-log/compare/v0.4.0...9e1659722e0c5e3dd1a216343ea9763ce461c5b0) (captured source).


## v0.4.0 (2026-11-18)

### ✨ Features

- Support release proposals for standalone Cargo packages and workspaces with a shared version&#46; ([#91](https://github.com/lhajoosten/release-log/pull/91)) by [&#64;lhajoosten](https://github.com/lhajoosten)

<details>
<summary>🔧 Internal maintenance</summary>

- Activate the rolling release controller after the v0&#46;3&#46;0 recovery&#46; ([#89](https://github.com/lhajoosten/release-log/pull/89)) by [&#64;lhajoosten](https://github.com/lhajoosten)

</details>

<br>

Full changelog: [v0&#46;3&#46;0&#8230;ca768fafc464465e9bbd768766b51ce320f7f7e4](https://github.com/lhajoosten/release-log/compare/v0.3.0...ca768fafc464465e9bbd768766b51ce320f7f7e4) (captured source).


## v0.3.0 (recovery candidate)

### ✨ Features

- Add capture timestamps&#44; contributor credits&#44; section emojis and full comparison links to changelogs&#44; plus an optional command to enrich existing releases with recorded tag&#45;date fallbacks&#46; ([#81](https://github.com/lhajoosten/release-log/pull/81)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add optional text generation through explicitly configured AI providers&#46; ([#82](https://github.com/lhajoosten/release-log/pull/82)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Support release PR tool upgrades and GitHub Release publication&#46; ([#84](https://github.com/lhajoosten/release-log/pull/84)) by [&#64;lhajoosten](https://github.com/lhajoosten)

- Format historical release notes consistently and publish the verified stable container manifest under the latest alias. ([#87](https://github.com/lhajoosten/release-log/pull/87))

### 🐛 Fixes

- Recover rolling releases after a stale proposal lands, and use the patched OpenSSL packages in the container. ([#88](https://github.com/lhajoosten/release-log/pull/88))

### 📚 Documentation

- Document the published CLI and current release operations&#46; ([#74](https://github.com/lhajoosten/release-log/pull/74)) by [&#64;lhajoosten](https://github.com/lhajoosten)

### 🛠️ Required actions

- Enable the trusted configuration options through the documented reviewed bootstrap and retain the required producer runtimes and App permissions&#46; ([#84](https://github.com/lhajoosten/release-log/pull/84))

<details>
<summary>🔧 Internal maintenance</summary>

- Record worker findings and owner&#45;requested issue closures&#46; ([#79](https://github.com/lhajoosten/release-log/pull/79)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Keep release lifecycle fixtures compatible with package version bumps&#46; ([#85](https://github.com/lhajoosten/release-log/pull/85)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Activate the reviewed release controller with trusted legacy replay and GitHub Release publication&#46; ([#86](https://github.com/lhajoosten/release-log/pull/86)) by [&#64;lhajoosten](https://github.com/lhajoosten)

</details>

<br>

Full changelog: [v0.2.1…v0.3.0](https://github.com/lhajoosten/release-log/compare/v0.2.1...v0.3.0)

## v0.2.1 (2026-11-16)

### 🐛 Fixes

- Fix dependency installation for tagged container releases&#46; ([#72](https://github.com/lhajoosten/release-log/pull/72)) by [&#64;lhajoosten](https://github.com/lhajoosten)

Full changelog: [v0.2.0…v0.2.1](https://github.com/lhajoosten/release-log/compare/v0.2.0...v0.2.1)

## v0.2.0 (2026-11-15)

### ✨ Features

- Add GHCR container publication for stable version tags&#46; ([#68](https://github.com/lhajoosten/release-log/pull/68)) by [&#64;lhajoosten](https://github.com/lhajoosten)

<details>
<summary>🔧 Internal maintenance</summary>

- Correct operational documentation after the first live tag&#45;only release&#46; ([#66](https://github.com/lhajoosten/release-log/pull/66)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Document the verified rolling release lifecycle and matching&#45;tag retry&#46; ([#67](https://github.com/lhajoosten/release-log/pull/67)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Preserve generated release bytes and automatically format staged maintained files&#46; ([#70](https://github.com/lhajoosten/release-log/pull/70)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add a project header image to the README&#46; ([#71](https://github.com/lhajoosten/release-log/pull/71)) by [&#64;lhajoosten](https://github.com/lhajoosten)

</details>

<br>

Full changelog: [v0.1.0…v0.2.0](https://github.com/lhajoosten/release-log/compare/v0.1.0...v0.2.0)


## v0.1.0 (2026-11-15)

Initial release of the captured repository state.

> Historical entries predate onboarding and may lack current release metadata. Review their sources and breaking warnings; no missing impact or migration instructions are inferred.

### ✨ Features

- Support reviewed initial adoption without rewriting legacy repository metadata&#46; ([#41](https://github.com/lhajoosten/release-log/pull/41)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Configure detailed&#44; concise or one&#45;line changelog entries while retaining release safety instructions&#46; ([#44](https://github.com/lhajoosten/release-log/pull/44)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Inspect approved release publication state without creating tags&#44; Releases or artifacts ([#46](https://github.com/lhajoosten/release-log/pull/46)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add explicit&#45;write execution of approved GitHub tag&#44; Release and asset steps ([#50](https://github.com/lhajoosten/release-log/pull/50)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add opt&#45;in strict approval checks for native GitHub reviews and trusted workflow results ([#51](https://github.com/lhajoosten/release-log/pull/51)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add tag&#45;only reconciliation for manually merged release proposals&#46; ([#54](https://github.com/lhajoosten/release-log/pull/54)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Allow consumers to configure optional structured PR release context&#46; ([#59](https://github.com/lhajoosten/release-log/pull/59)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add a compact changelog layout with collapsed internal maintenance and visible safety information&#46; ([#64](https://github.com/lhajoosten/release-log/pull/64)) by [&#64;lhajoosten](https://github.com/lhajoosten)

### 📚 Documentation

- Add a GitHub Pages documentation site for release&#45;log&#46; ([#28](https://github.com/lhajoosten/release-log/pull/28)) by [&#64;lhajoosten](https://github.com/lhajoosten)

### 📜 Historical changes

- &#91;historical PR&#93; chore&#58; set up basic repository tooling ([#1](https://github.com/lhajoosten/release-log/pull/1)) by [&#64;lhajoosten](https://github.com/lhajoosten)
  - Historical context unavailable; review the linked source.
- &#91;historical PR&#93; feat&#58; validate conventional change metadata ([#2](https://github.com/lhajoosten/release-log/pull/2)) by [&#64;lhajoosten](https://github.com/lhajoosten)
  - Historical context unavailable; review the linked source.
- &#91;historical PR&#93; feat&#58; inspect exact Git tag ranges ([#3](https://github.com/lhajoosten/release-log/pull/3)) by [&#64;lhajoosten](https://github.com/lhajoosten)
  - Historical context unavailable; review the linked source.
- &#91;historical commit&#93; chore&#58; add MIT license and local ignore rules ([4d283a455871](https://github.com/lhajoosten/release-log/commit/4d283a455871973bc79b0088fc3d4aea1bac0a7b))
  - Historical context unavailable; review the linked source.

### 💥 Breaking changes

- retain historical commit&#45;only entries; snapshots and plans use schema version 2&#46; Recapture snapshots with the new tool and update plan readers&#59; version 1 data is not migrated automatically&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- snapshots and plans now use schema 3&#46; Recapture old inputs and configure a fixed schema&#45;2 onboarding record before initial collection&#46;; support initial repository adoption ([#41](https://github.com/lhajoosten/release-log/pull/41)) by [&#64;lhajoosten](https://github.com/lhajoosten)

### 🛠️ Required actions

- Use unscoped conventional commit subjects and scoped conventional PR titles&#46; Remove the scope from the final commit subject when squash merging&#46; ([#5](https://github.com/lhajoosten/release-log/pull/5)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Complete the v1 release context before merging PRs&#59; validate rollout before making the metadata check required&#46; ([#27](https://github.com/lhajoosten/release-log/pull/27)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Recapture version 1 snapshots with the new tool and update plan readers for schema version 2&#59; no automatic migration is performed&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Use schema&#45;2 configuration with fixed bootstrap baselineSha and onboardingSha for initial collection&#59; use the original pinned tool for old snapshots or explicitly recapture and review schema&#45;3 snapshots and plans&#46; ([#41](https://github.com/lhajoosten/release-log/pull/41)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Rerun verification rather than reuse cached verification IDs&#59; verification evidence now binds automation commit IDs and prior proposal heads must replay with compatible pinned configuration and tooling&#46; ([#43](https://github.com/lhajoosten/release-log/pull/43)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- When opting in or changing changelog&#46;verbosity&#44; recapture and review release inputs so proposal and approval identities use the selected format&#46; ([#44](https://github.com/lhajoosten/release-log/pull/44)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- To enable exclusions&#44; pin freshly recomputed verification IDs and supply independently trusted original approval authorities&#59; use a compatible tool for schema&#45;4 captures rather than relabeling schema&#45;3 inputs or reusing cached verification IDs&#46; ([#45](https://github.com/lhajoosten/release-log/pull/45)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Review the musl runtime and locked APK availability constraints before adopting the image&#59; arbitrary glibc&#45;dependent consumer binaries are not supported&#44; and private&#45;registry access remains unverified&#46; ([#48](https://github.com/lhajoosten/release-log/pull/48)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Review the pinned tool revision and configure the GitHub App and caller only under separate rollout approval&#46; ([#57](https://github.com/lhajoosten/release-log/pull/57)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Review the first eligible dry&#45;run result before authorizing live activation&#46; ([#58](https://github.com/lhajoosten/release-log/pull/58)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- When opting in&#44; use a compatible pinned tool&#44; align the trusted metadata gate policy with release configuration&#44; and capture a fresh reviewed snapshot&#46; ([#59](https://github.com/lhajoosten/release-log/pull/59)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Review the generated version&#44; changelog and captured inputs before manually merging each release PR&#46; ([#60](https://github.com/lhajoosten/release-log/pull/60)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Review the next automatic rolling&#45;release result and the generated proposal before manually merging a release PR&#46; ([#61](https://github.com/lhajoosten/release-log/pull/61)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Observe the refreshed release PR checks after merging this source correction&#44; then review its generated version&#44; changelog and captured inputs before release merge&#46; ([#63](https://github.com/lhajoosten/release-log/pull/63)) by [&#64;lhajoosten](https://github.com/lhajoosten)

<details>
<summary>🔧 Internal maintenance</summary>

- &#91;historical PR&#93; feat&#58; parse structured PR release context ([#4](https://github.com/lhajoosten/release-log/pull/4)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Fix post&#45;merge CI validation and distinguish commit and PR title formats&#46; ([#5](https://github.com/lhajoosten/release-log/pull/5)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Validate PR release metadata before merge&#46; ([#27](https://github.com/lhajoosten/release-log/pull/27)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Inspect pending release history from an explicit baseline to a captured commit&#46; ([#30](https://github.com/lhajoosten/release-log/pull/30)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Associate captured release commits with their merged GitHub PRs&#46; ([#31](https://github.com/lhajoosten/release-log/pull/31)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Capture validated release inputs and replay them offline&#46; ([#32](https://github.com/lhajoosten/release-log/pull/32)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Calculate deterministic release versions from validated snapshots&#46; ([#33](https://github.com/lhajoosten/release-log/pull/33)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Render deterministic changelog entries and replace the owned pending section&#46; ([#34](https://github.com/lhajoosten/release-log/pull/34)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Package deterministic release commands with Node and Python version&#45;file support&#46; ([#35](https://github.com/lhajoosten/release-log/pull/35)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add a manual read&#45;only release rehearsal for this repository&#46; ([#36](https://github.com/lhajoosten/release-log/pull/36)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add opt&#45;in creation and refresh of draft release proposals&#46; ([#37](https://github.com/lhajoosten/release-log/pull/37)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Verify independently recorded release proposals against their actual merged landings&#46; ([#38](https://github.com/lhajoosten/release-log/pull/38)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Build and test a local Linux container around the packaged release CLI&#46; ([#39](https://github.com/lhajoosten/release-log/pull/39)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Retain eligible unassociated historical commits during explicit bootstrap planning&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Capture exact reviewed proposal identities before merge and finalize records against a trusted merge outcome&#46; ([#42](https://github.com/lhajoosten/release-log/pull/42)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Verify generated proposal ancestry and audit exact automation&#45;only release footprints&#46; ([#43](https://github.com/lhajoosten/release-log/pull/43)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Apply independently pinned release&#45;automation verification during collection and offline replay&#46; ([#45](https://github.com/lhajoosten/release-log/pull/45)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Isolate commit checks from Git environment routing exported by linked&#45;worktree hooks&#46; ([#47](https://github.com/lhajoosten/release-log/pull/47)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Scan built container runtime packages and replace the vulnerable base with pinned Alpine packages&#46; ([#48](https://github.com/lhajoosten/release-log/pull/48)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Select a verified release boundary and report pending release tags&#46; ([#55](https://github.com/lhajoosten/release-log/pull/55)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Continue release proposals from verified tagged landings&#46; ([#56](https://github.com/lhajoosten/release-log/pull/56)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Connect rolling release proposals and exact&#45;landing version tags&#46; ([#57](https://github.com/lhajoosten/release-log/pull/57)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Add the source&#45;pinned rolling release dry&#45;run caller&#46; ([#58](https://github.com/lhajoosten/release-log/pull/58)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Enable the repository&#39;s live rolling release caller with the reviewed context&#45;policy implementation&#46; ([#60](https://github.com/lhajoosten/release-log/pull/60)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Handle GitHub&#39;s omitted final commit&#45;message newline during rolling release verification&#46; ([#61](https://github.com/lhajoosten/release-log/pull/61)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Allow CI to validate generated releases while preserving canonical snapshot bytes&#46; ([#63](https://github.com/lhajoosten/release-log/pull/63)) by [&#64;lhajoosten](https://github.com/lhajoosten)
- Record the package author&#39;s name and email&#46; ([#65](https://github.com/lhajoosten/release-log/pull/65)) by [&#64;lhajoosten](https://github.com/lhajoosten)

</details>

