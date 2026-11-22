# Maintain Rolling Release

To see what your repo would release, open **Rolling Release** in your repo's Actions tab and select **Run workflow** on its default branch. The preview is read-only. [Consumer setup](consumer-setup.md#preview-and-turn-on-releases)

## Verify published image

Open **Verify published image** in Rolling Release's Actions tab. Select **Run workflow** on `main`, choose the baseline as described in the rehearsal guide, and read the preview artifact. The workflow pulls the published `latest` image and verifies it can reproduce the preview from the saved inputs. [Verify published image](https://github.com/lhajoosten/rolling-release/actions/workflows/release-rehearsal.yml) · [Inputs and results](release-rehearsal.md)

## Resume publication

- **Your repo.** Find the run for the original release PR merge in **Rolling Release**. Inspect that PR, its expected tag and GitHub Release, then rerun the original run for that merge. It verifies the same landing and completes matching partial work. [Consumer recovery](release-workflow.md#operator-recovery-and-tool-updates)
- **Rolling Release itself.** Open **Publish Rolling Release**, find the failed run and read its summary and `status.json` in the run artifact. If the exact landing's Quality run failed transiently, retry Quality first. Then rerun publication or run it on `main` to let it resume the pending candidate. Follow the recovery guide if the run reports a conflict. [Publish Rolling Release](https://github.com/lhajoosten/rolling-release/actions/workflows/rolling-release-caller.yml) · [Provider recovery](container-release.md#failure-and-retry-recovery)
