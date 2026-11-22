# Set up Rolling Release

Rolling Release checks PR titles and release context before merge, then prepares releases after merge. It provides the release policy, GitHub Release and changelog defaults. Your repository supplies its release App credentials and any settings it wants to override.

## Install once

From a checkout of your repository, use an authenticated GitHub CLI to run this after Rolling Release has activated `consumer-v1`. It fetches both workflows from the same promoted revision. If your repository already uses Rolling Release, follow the [migration steps](release-workflow.md#one-time-migration-and-recovery) to preserve its settings and required checks.

```sh
sh <<'SH'
set -eu
cd "$(git rev-parse --show-toplevel)"
provider=lhajoosten/rolling-release
workflows=.github/workflows
release=rolling-release-caller.yml
readiness=release-metadata-caller.yml

for file in "$release" "$readiness"; do
  if [ -e "$workflows/$file" ] || [ -L "$workflows/$file" ]; then
    printf 'Already installed: %s\n' "$workflows/$file" >&2
    exit 1
  fi
done

revision=$(gh api "repos/$provider/git/ref/heads/consumer-v1" --jq .object.sha)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
gh api --method GET "repos/$provider/contents/examples/rolling-release.yml" \
  -H 'Accept: application/vnd.github.raw+json' -f ref="$revision" > "$staging/$release"
gh api --method GET "repos/$provider/contents/examples/release-metadata-caller.yml" \
  -H 'Accept: application/vnd.github.raw+json' -f ref="$revision" > "$staging/$readiness"
mkdir -p "$workflows"
cp "$staging/$release" "$staging/$readiness" "$workflows/"
SH
```

If your default branch differs from `main`, set `release-branch` and its matching literal branch filter in both files. For immutable updates, replace `@consumer-v1` with the same promoted full SHA in both files. Put deliberate overrides or a reviewed starting point in [`.release-log/settings.json`](release-workflow.md#minimal-consumer-workflow).

## Preview and turn on releases

1. Install the release App on the repository with **Contents** and **Pull requests** write access. Set `RELEASE_APP_ID` and `RELEASE_BOT_USER_ID` as Actions variables, set `RELEASE_APP_PRIVATE_KEY` as an Actions secret, and set `RELEASE_LOG_WRITE_ENABLED` to `false`.
2. Review and land the setup. In the repository's Actions tab, select **Rolling Release** and choose **Run workflow** on the default branch. Review the release preview and confirm the existing release boundary. For a first release, review the suggested starting point, record it in the settings file, and preview again. [Initial adoption](initial-adoption.md)
3. Observe **Check PR readiness** on an ordinary PR. Require `release-log / metadata` from GitHub Actions in branch protection and verify title edits trigger a new result. After preview agrees with what you expect, enable writes by setting `RELEASE_LOG_WRITE_ENABLED` to `true`. Verify the metadata check on the App's generated release PR before merging it. [Readiness and branch protection](pr-readiness.md#consumer-setup-and-migration)

If a release run stops halfway, follow the [maintainer guide](maintain-rolling-release.md#resume-publication).
