# Changelog

<!-- release-log:pending:v1 sha256:f2d743c5067ca765eff7dbf76cc6e709af91e9236f0d083abb7413be351b0e59 -->

## v0.1.0

Initial release of the captured repository state.

> Historical entries predate onboarding and may lack current release metadata. Review their sources and breaking warnings; no missing impact or migration instructions are inferred.

### Features

- **approval** [internal]: Verify independently recorded release proposals against their actual merged landings&#46; ([#38](https://github.com/lhajoosten/release-log/pull/38))
- **approval** [internal]: Capture exact reviewed proposal identities before merge and finalize records against a trusted merge outcome&#46; ([#42](https://github.com/lhajoosten/release-log/pull/42))
- **approval** [internal]: Verify generated proposal ancestry and audit exact automation&#45;only release footprints&#46; ([#43](https://github.com/lhajoosten/release-log/pull/43))
  - **Required action:** Rerun verification rather than reuse cached verification IDs&#59; verification evidence now binds automation commit IDs and prior proposal heads must replay with compatible pinned configuration and tooling&#46;
- **approval**: Add opt&#45;in strict approval checks for native GitHub reviews and trusted workflow results ([#51](https://github.com/lhajoosten/release-log/pull/51))
- **bootstrap** [internal]: Retain eligible unassociated historical commits during explicit bootstrap planning&#46; ([#40](https://github.com/lhajoosten/release-log/pull/40))
  - **Breaking change:** retain historical commit&#45;only entries; snapshots and plans use schema version 2&#46; Recapture snapshots with the new tool and update plan readers&#59; version 1 data is not migrated automatically&#46;
  - **Required action:** Recapture version 1 snapshots with the new tool and update plan readers for schema version 2&#59; no automatic migration is performed&#46;
- **bootstrap**: Support reviewed initial adoption without rewriting legacy repository metadata&#46; ([#41](https://github.com/lhajoosten/release-log/pull/41))
  - **Breaking change:** snapshots and plans now use schema 3&#46; Recapture old inputs and configure a fixed schema&#45;2 onboarding record before initial collection&#46;; support initial repository adoption
  - **Required action:** Use schema&#45;2 configuration with fixed bootstrap baselineSha and onboardingSha for initial collection&#59; use the original pinned tool for old snapshots or explicitly recapture and review schema&#45;3 snapshots and plans&#46;
- **changelog** [internal]: Render deterministic changelog entries and replace the owned pending section&#46; ([#34](https://github.com/lhajoosten/release-log/pull/34))
- **changelog**: Configure detailed&#44; concise or one&#45;line changelog entries while retaining release safety instructions&#46; ([#44](https://github.com/lhajoosten/release-log/pull/44))
  - **Required action:** When opting in or changing changelog&#46;verbosity&#44; recapture and review release inputs so proposal and approval identities use the selected format&#46;
- **cli** [internal]: Package deterministic release commands with Node and Python version&#45;file support&#46; ([#35](https://github.com/lhajoosten/release-log/pull/35))
- **collection** [internal]: Apply independently pinned release&#45;automation verification during collection and offline replay&#46; ([#45](https://github.com/lhajoosten/release-log/pull/45))
  - **Required action:** To enable exclusions&#44; pin freshly recomputed verification IDs and supply independently trusted original approval authorities&#59; use a compatible tool for schema&#45;4 captures rather than relabeling schema&#45;3 inputs or reusing cached verification IDs&#46;
- **container** [internal]: Build and test a local Linux container around the packaged release CLI&#46; ([#39](https://github.com/lhajoosten/release-log/pull/39))
- **git** [internal]: Inspect pending release history from an explicit baseline to a captured commit&#46; ([#30](https://github.com/lhajoosten/release-log/pull/30))
- **github** [internal]: Associate captured release commits with their merged GitHub PRs&#46; ([#31](https://github.com/lhajoosten/release-log/pull/31))
- **planning** [internal]: Calculate deterministic release versions from validated snapshots&#46; ([#33](https://github.com/lhajoosten/release-log/pull/33))
- **pr&#45;readiness** [internal]: Validate PR release metadata before merge&#46; ([#27](https://github.com/lhajoosten/release-log/pull/27))
  - **Required action:** Complete the v1 release context before merging PRs&#59; validate rollout before making the metadata check required&#46;
- **proposals** [internal]: Add opt&#45;in creation and refresh of draft release proposals&#46; ([#37](https://github.com/lhajoosten/release-log/pull/37))
- **proposals** [internal]: Continue release proposals from verified tagged landings&#46; ([#56](https://github.com/lhajoosten/release-log/pull/56))
- **publication**: Inspect approved release publication state without creating tags&#44; Releases or artifacts ([#46](https://github.com/lhajoosten/release-log/pull/46))
- **publication**: Add explicit&#45;write execution of approved GitHub tag&#44; Release and asset steps ([#50](https://github.com/lhajoosten/release-log/pull/50))
- **release&#45;context**: Allow consumers to configure optional structured PR release context&#46; ([#59](https://github.com/lhajoosten/release-log/pull/59))
  - **Required action:** When opting in&#44; use a compatible pinned tool&#44; align the trusted metadata gate policy with release configuration&#44; and capture a fresh reviewed snapshot&#46;
- **release&#45;cycle** [internal]: Select a verified release boundary and report pending release tags&#46; ([#55](https://github.com/lhajoosten/release-log/pull/55))
- **releases**: Add tag&#45;only reconciliation for manually merged release proposals&#46; ([#54](https://github.com/lhajoosten/release-log/pull/54))
- **snapshots** [internal]: Capture validated release inputs and replay them offline&#46; ([#32](https://github.com/lhajoosten/release-log/pull/32))
- **workflow** [internal]: Connect rolling release proposals and exact&#45;landing version tags&#46; ([#57](https://github.com/lhajoosten/release-log/pull/57))
  - **Required action:** Review the pinned tool revision and configure the GitHub App and caller only under separate rollout approval&#46;

### Fixes

- **ci** [internal]: Fix post&#45;merge CI validation and distinguish commit and PR title formats&#46; ([#5](https://github.com/lhajoosten/release-log/pull/5))
  - **Required action:** Use unscoped conventional commit subjects and scoped conventional PR titles&#46; Remove the scope from the final commit subject when squash merging&#46;
- **hooks** [internal]: Isolate commit checks from Git environment routing exported by linked&#45;worktree hooks&#46; ([#47](https://github.com/lhajoosten/release-log/pull/47))
- **release** [internal]: Handle GitHub&#39;s omitted final commit&#45;message newline during rolling release verification&#46; ([#61](https://github.com/lhajoosten/release-log/pull/61))
  - **Required action:** Review the next automatic rolling&#45;release result and the generated proposal before manually merging a release PR&#46;

### Documentation

- **pages**: Add a GitHub Pages documentation site for release&#45;log&#46; ([#28](https://github.com/lhajoosten/release-log/pull/28))

### Continuous integration

- **container** [internal]: Scan built container runtime packages and replace the vulnerable base with pinned Alpine packages&#46; ([#48](https://github.com/lhajoosten/release-log/pull/48))
  - **Required action:** Review the musl runtime and locked APK availability constraints before adopting the image&#59; arbitrary glibc&#45;dependent consumer binaries are not supported&#44; and private&#45;registry access remains unverified&#46;
- **rehearsal** [internal]: Add a manual read&#45;only release rehearsal for this repository&#46; ([#36](https://github.com/lhajoosten/release-log/pull/36))
- **release** [internal]: Add the source&#45;pinned rolling release dry&#45;run caller&#46; ([#58](https://github.com/lhajoosten/release-log/pull/58))
  - **Required action:** Review the first eligible dry&#45;run result before authorizing live activation&#46;
- **release** [internal]: Enable the repository&#39;s live rolling release caller with the reviewed context&#45;policy implementation&#46; ([#60](https://github.com/lhajoosten/release-log/pull/60))
  - **Required action:** Review the generated version&#44; changelog and captured inputs before manually merging each release PR&#46;

### Historical changes

- [historical PR]: chore&#58; set up basic repository tooling ([#1](https://github.com/lhajoosten/release-log/pull/1))
- [historical PR]: feat&#58; validate conventional change metadata ([#2](https://github.com/lhajoosten/release-log/pull/2))
- [historical PR]: feat&#58; inspect exact Git tag ranges ([#3](https://github.com/lhajoosten/release-log/pull/3))
- [historical PR] [internal]: feat&#58; parse structured PR release context ([#4](https://github.com/lhajoosten/release-log/pull/4))
- [historical commit]: chore&#58; add MIT license and local ignore rules ([4d283a455871](https://github.com/lhajoosten/release-log/commit/4d283a455871973bc79b0088fc3d4aea1bac0a7b))

<!-- release-log:pending:end -->
