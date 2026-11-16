import { updateChangelog } from "./changelog.ts";
import { GitHubReadError } from "./github.ts";
import { ProposalConflictError, proposalObject } from "./github-proposals.ts";
import type { GitHubProposalRepository } from "./github-proposals.ts";

export interface TaggedGitHubReleaseResult {
  readonly outcome: "would-create" | "created" | "unchanged";
  readonly url: string;
}

export function taggedReleaseNotes(changelog: string, version: string): string {
  // Reuse the changelog's top-level marker and digest validation, then extract
  // only the verified version. Released history and the preamble are excluded.
  updateChangelog(changelog, null, version);
  const match =
    /^<!-- release-log:pending:v1 sha256:[a-f0-9]{64} -->\n\n([\s\S]*?)\n<!-- release-log:pending:end -->/mu.exec(
      changelog,
    );
  const notes = match?.[1];
  if (!notes || /^## v([^\s]+)(?: \(\d{4}-\d{2}-\d{2}\))?\n/u.exec(notes)?.[1] !== version)
    throw new ProposalConflictError(
      "GitHub Release notes require the verified tagged version's generated changelog section.",
    );
  return notes;
}

async function optionalRelease(
  api: GitHubProposalRepository,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return proposalObject((await api.request(path)).data);
  } catch (error) {
    if (error instanceof GitHubReadError && error.status === 404) return null;
    throw error;
  }
}

function published(release: Record<string, unknown>, tag: string): void {
  if (
    !Number.isSafeInteger(release.id) ||
    Number(release.id) <= 0 ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false
  )
    throw new ProposalConflictError(
      "An existing or returned GitHub Release conflicts with the stable tag; preserve it and recover explicitly.",
    );
}

function compareTags(left: string, right: string): number {
  const pattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
  const a = pattern.exec(left);
  const b = pattern.exec(right);
  if (!a || !b || left.length > 129 || right.length > 129)
    throw new ProposalConflictError(
      "Latest-release comparison requires stable vMAJOR.MINOR.PATCH tags.",
    );
  for (const index of [1, 2, 3]) {
    const x = BigInt(a[index] ?? "0");
    const y = BigInt(b[index] ?? "0");
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export async function reconcileTaggedGitHubRelease(
  api: GitHubProposalRepository,
  repository: string,
  tag: string,
  landingSha: string,
  notes: string,
  write: boolean,
  beforeWrite: () => Promise<void>,
): Promise<TaggedGitHubReleaseResult> {
  const path = `/releases/tags/${encodeURIComponent(tag)}`;
  const url = `https://github.com/${repository}/releases/tag/${tag}`;
  const existing = await optionalRelease(api, path);
  if (existing) {
    published(existing, tag);
    return { outcome: "unchanged", url };
  }
  if (!write) return { outcome: "would-create", url };
  await beforeWrite();
  const raced = await optionalRelease(api, path);
  if (raced) {
    published(raced, tag);
    return { outcome: "unchanged", url };
  }
  const latest = await optionalRelease(api, "/releases/latest");
  if (latest) {
    if (typeof latest.tag_name !== "string")
      throw new ProposalConflictError("GitHub returned an incomplete latest release.");
    published(latest, latest.tag_name);
    if (latest.tag_name === tag)
      throw new ProposalConflictError(
        "GitHub returned inconsistent release lookup evidence; retry from fresh state.",
      );
  }
  // A delayed older event must not displace an already newer stable release.
  const makeLatest = !latest || compareTags(tag, String(latest.tag_name)) > 0;
  await beforeWrite();
  const created = proposalObject(
    (
      await api.request("/releases", "POST", {
        tag_name: tag,
        target_commitish: landingSha,
        name: tag,
        body: notes,
        draft: false,
        prerelease: false,
        generate_release_notes: false,
        make_latest: makeLatest ? "true" : "false",
      })
    ).data,
  );
  published(created, tag);
  if (created.body !== notes || created.name !== tag)
    throw new ProposalConflictError(
      "GitHub did not save the exact release notes; inspect the published release before retrying.",
    );
  const saved = await optionalRelease(api, path);
  if (!saved || saved.id !== created.id || saved.body !== notes)
    throw new ProposalConflictError(
      "The GitHub Release changed after creation; inspect remote state before retrying.",
    );
  published(saved, tag);
  if (makeLatest) {
    const currentLatest = await optionalRelease(api, "/releases/latest");
    if (!currentLatest || typeof currentLatest.tag_name !== "string")
      throw new ProposalConflictError(
        "GitHub did not confirm the published latest release; inspect before retrying.",
      );
    published(currentLatest, currentLatest.tag_name);
    if (
      compareTags(currentLatest.tag_name, tag) < 0 ||
      (currentLatest.tag_name === tag && currentLatest.id !== created.id)
    )
      throw new ProposalConflictError(
        "GitHub did not retain the expected latest release; inspect before retrying.",
      );
  }
  return { outcome: "created", url };
}
