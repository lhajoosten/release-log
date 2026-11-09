# Container vulnerability review — 2026-11-09

**Current local disposition: vulnerability threshold passed, private access/publication pending.** The locked Alpine build below has no High/Critical/Unknown matches with the recorded database; three Medium BusyBox matches remain visible. This does not close [#21](https://github.com/lhajoosten/release-log/issues/21), authorize publication, or establish private-registry access. These are scanner findings, not independently reproduced exploitability claims.

## Locked Alpine remediation

The follow-up keeps Node 26.13.0 and the packaged CLI, but replaces Debian/glibc with Alpine/musl. Git 2.54.0, musl 1.2.6-r3, libcurl 8.23.0-r0, OpenSSL libraries 3.5.9-r0 and zlib 1.4-r0 are among the 21 archives in `container/apk-lock.json` (lock SHA-256 `d2956db8e5b01ff084387c5721fea211085f9db1a02a0f082cc88008ed97853c`). Package filenames and bytes are pinned; the Docker build installs them offline with signature verification and RUN networking disabled. No advisory ignore rule or severity threshold was weakened. See the [runtime/pinning tradeoffs](container.md#build-from-locked-inputs), especially musl compatibility and upstream APK availability.

| Local candidate                             | Critical | High | Medium | Gate | Disposition                                                          |
| ------------------------------------------- | -------: | ---: | -----: | ---- | -------------------------------------------------------------------- |
| Bookworm after npm removal                  |       10 |   83 |     96 | fail | Historical baseline below                                            |
| Trixie, signed 20261108 snapshot + upgrades |        8 |   99 |     73 | fail | Rejected as a remediation; Docker smoke passed but findings remained |
| Alpine initial evaluation                   |        1 |    0 |      3 | fail | zlib 1.3.2-r1 matched CVE-2026-4738; DB supplied fixed 1.4-r0        |
| Alpine with locked APK closure              |        0 |    0 |      3 | pass | Patched zlib; real Docker smoke passed                               |

The locked scan ran at **2026-11-09 13:57:42 UTC**, using the same Syft 1.57.0 / Grype 0.121.2 / DB v6.1.10 identities recorded below, and inventoried **122 packages**, including the independent Node binary/CPE and installed production npm tree. Runtime smoke measured **324,924,811 bytes** and passed existing Node/Python offline planning/rendering/writes, UID/mount/safe-directory/failure/no-consumer-execution checks plus Alpine 3.24, unchanged Node version, absent package managers and absent runtime APK staging directory.

| Locked-image evidence    | Identity                                                                  |
| ------------------------ | ------------------------------------------------------------------------- |
| Build source             | `78f2ac3` plus the local container-only Alpine/lock/build/scan changes    |
| Local tag                | `release-log-security:alpine-locked`                                      |
| Image/index ID           | `sha256:5f9a8ae1a6aaa34a258106d09386f2dcba03bb0a66f9b241d9451b9aa87104d9` |
| Exported archive SHA-256 | `481e12dfc7c00ef1c9518cc9558e358b8d936dd31fa3d8da10598df2abb6e1d3`        |
| SBOM SHA-256             | `e8d02ff894fe215e0ebeca7b47d4ba9be6d1c54a3356fa6ac0b52b276d10b7ba`        |
| Findings report SHA-256  | `6be76579a43e26c30d1aa77b72d79562e53c63a8d86d3c42c13d85a184741763`        |
| Raw local evidence       | `.local/security-alpine-locked/` in the container-base worktree           |

Remaining matches: **CVE-2025-60876**, Medium, for `busybox`, `busybox-binsh` and `ssl_client`, each 1.37.0-r31. This database lists no fixed version. They remain in the full report under the existing Medium-review policy, not a new ignore list; continue monitoring upstream updates and rescan before release. No claim that they are unreachable or independently reproduced is made. A passing scan covers this image and database only, not all native libraries bundled into Node or future advisories.

Other evaluation evidence remains in `.local/security-trixie/` and `.local/security-alpine/` in the same worktree. Neither candidate was published. Alpine CI evidence must be observed separately; no approved online collection/release or private-registry pull is implied by offline smoke tests.

## Historical Bookworm inputs and evidence

Both images were built locally from the packaged CLI at main `c3680a5d8e6e8a85ae65e7c1faaadddb0857aac7`; the second additionally removes npm/npx/Yarn in `container/Dockerfile`. No release-state code or package/lock files changed. Runtime: Node 26.13.0, Git 2.39.5, CLI 0.0.0, Linux/amd64. Base/snapshot pins are in the [container guide](container.md).

| Evidence                                            | Before removal                                                            | After removal                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Scan time (UTC)                                     | 2026-11-09 13:20:50                                                       | 2026-11-09 13:25:41                                                       |
| Local tag                                           | `release-log-security:baseline`                                           | `release-log-security:hardened`                                           |
| Image/index ID                                      | `sha256:0280589ee2613594941f103c0449567cfd3c6af72429caa2d2cae5af0e627cca` | `sha256:1ac156a56f0c0ee18a9ebba05581ba5a12dfdedabbab5175bfb2bbbe26fd7c1d` |
| Exported archive SHA-256                            | `febd9380fdfafbfa50862425e1059b0ddc5e8db70479117f777ab4779a34a6f3`        | `10e31bc8b05eae2cf6dcf2fd003a991f02a04410759a34d8f383700234271ac3`        |
| SBOM SHA-256                                        | `9cfd37354f8fb76937136dbfd1f2fe34579546e9e5c387b33b1bb3002d2b58f3`        | `19baad2cbd97d6d199e81c4f42591d1b7e04489a14e100d7a52a2439d5d42196`        |
| Findings report SHA-256                             | `68c558d2ad07c75f953641f62360e2e188998ee814f9182073aace5473d015be`        | `fc4bf5a5241d2412c30ca2d75ece1ca45e85ddcb4a4d191ae5eceff86c9998d8`        |
| Inventoried packages                                | 349                                                                       | 205                                                                       |
| Critical / High / Medium / Low / Negligible matches | 10 / 89 / 108 / 14 / 109                                                  | 10 / 83 / 96 / 13 / 109                                                   |
| Gate exit status                                    | 1                                                                         | 1                                                                         |

Counts are **package/advisory matches**, not unique CVEs. The remaining 93 High/Critical matches cover 50 unique advisory IDs. No Unknown-severity matches occurred. Local Docker identities are not published registry references; provenance/timestamps can change a rebuild's digest.

Scanner release archives (Linux/amd64):

- [Syft 1.57.0](https://github.com/anchore/syft/releases/tag/v1.57.0), SHA-256 `9c077a7d43029b3b13e98a8db720661e700c4d58db6352153a06395ae4a2a704`.
- [Grype 0.121.2](https://github.com/anchore/grype/releases/tag/v0.121.2), SHA-256 `9c8965ced9df657e5e851c14021bae838802f711edd7a48f9bc3c923a8d28f12`.
- Both runs used Grype DB schema **v6.1.10**, built **2026-11-08 06:19:57 UTC**, archive `vulnerability-db_v6.1.10_2026-11-08T00:22:04Z_1794118797.tar.zst` from `https://grype.anchore.io/databases/v6/`, archive checksum `sha256:dcca24722e16c2bcf4a542a3f7fdd2147baf9215c17b973f5a7d4243fbddacea`. Grype reported valid database status with hash/age validation enabled.

Raw local evidence remains in `.local/security-baseline/` and `.local/security-hardened/` in the security worktree, not in Git. The initial Bookworm CI scan also failed as expected on [PR #48](https://github.com/lhajoosten/release-log/pull/48) ([run](https://github.com/lhajoosten/release-log/actions/runs/42628286137)); its ordinary verification, metadata and Docker checks passed. This does not establish Alpine CI results. Reproduce with the [documented scan command](container.md#vulnerability-gate) and a new output directory; current databases may change findings.

## Historical package-manager remediation and coverage

Every baseline npm match came from `/usr/local/lib/node_modules/npm/node_modules/`, not `/opt/release-log/node_modules/`. The CLI does not install packages at runtime, so its image now removes npm/npx and Yarn rather than patching unused dependencies or changing the shared lockfile. This removes six High matches (`brace-expansion` and `undici`), twelve Medium matches and one Low match from the installed filesystem. Examples: [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c). Lower inherited layers still contain the original bytes; this is not a smaller or rewritten base image.

The hardened SBOM contains the Node **26.13.0 binary** at `/usr/local/bin/node`, detected by Syft's binary classifier with a Node.js CPE, alongside Debian and installed production npm packages. Grype returned no matches for that Node binary or the remaining npm packages with this database. That is bounded scanner evidence, not a claim that Node's bundled native components or all future advisories are covered.

Real `pnpm check:container` passed after removal, including help/version, offline planning/rendering, Node/Python writes, UID/mount/ownership/error paths and explicit package-manager absence. Application behavior did not need npm or Yarn.

## Historical Bookworm blockers

All High/Critical matches below are in `debian:distro:debian:12`; the database lists **no fixed version** for them. `not-fixed` and `wont-fix` are database dispositions, not accepted risk waivers.

| Package or family                                                                                            | Installed version                        | High matches | Critical matches | DB fix states       |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -----------: | ---------------: | ------------------- |
| `libcurl3-gnutls`                                                                                            | `7.88.1-10+deb12u15`                     |           16 |                8 | wont-fix            |
| `libc-bin`, `libc6`                                                                                          | `2.36-9+deb12u14`                        |            8 |                2 | wont-fix, not-fixed |
| `libperl5.36`, `perl`, `perl-base`, `perl-modules-5.36`                                                      | `5.36.0-7+deb12u4`                       |            8 |                0 | not-fixed, wont-fix |
| `bsdutils`, `libblkid1`, `libmount1`, `libsmartcols1`, `libuuid1`, `mount`, `util-linux`, `util-linux-extra` | `2.38.1-5+deb12u3` (bsdutils epoch `1:`) |           24 |                0 | not-fixed           |
| `gcc-12-base`, `libatomic1`, `libgcc-s1`, `libstdc++6`                                                       | `12.2.0-14+deb12u1`                      |            8 |                0 | wont-fix            |
| `libgssapi-krb5-2`, `libk5crypto3`, `libkrb5-3`, `libkrb5support0`                                           | `1.20.1-2+deb12u5`                       |            4 |                0 | wont-fix            |
| `libexpat1`                                                                                                  | `2.5.0-1+deb12u5`                        |            5 |                0 | wont-fix, not-fixed |
| `libtinfo6`, `ncurses-base`, `ncurses-bin`                                                                   | `6.4-4`                                  |            3 |                0 | wont-fix            |
| `zlib1g`                                                                                                     | `1:1.2.13.dfsg-1`                        |            2 |                0 | not-fixed           |
| `libacl1`                                                                                                    | `2.3.1-3`                                |            2 |                0 | wont-fix            |
| `libldap-2.5-0`                                                                                              | `2.5.13+dfsg-5`                          |            1 |                0 | wont-fix            |
| `libtasn1-6`                                                                                                 | `4.19.0-2+deb12u1`                       |            1 |                0 | wont-fix            |
| `gzip`                                                                                                       | `1.12-1`                                 |            1 |                0 | wont-fix            |

Critical IDs: `libcurl3-gnutls` — CVE-2026-19931, CVE-2026-11856, CVE-2026-92388, CVE-2026-86414, CVE-2026-8924, CVE-2026-10536, CVE-2026-18924, CVE-2026-8927; both glibc packages — CVE-2026-5450. Raw reports retain full identifiers, package locations, matching evidence and advisory links for every severity.

These historical findings motivated the tested Alpine/musl migration above rather than a global ignore rule or removal of required libraries. Offline smoke tests do not prove online collection or registry authorization. Private-registry authentication and approved publication remain separately pending; no image was pushed and no credentials/visibility/settings changed.
