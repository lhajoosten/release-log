import { updateCargoVersions } from "../cargo-version.ts";
import { updatePackageVersion, updatePyprojectVersion } from "../version-files.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "../github-proposals.ts";
import type { GitHubRead } from "../github.ts";
import { parseReleaseAutomation } from "../config/automation.ts";
import { requireUnusedReleaseVersions } from "../tagging/evidence.ts";
import { reconcileReleaseTag } from "../tagging/reconcile.ts";
import { parseReleaseInputConfiguration } from "../config/repository.ts";

import { ancestry, latestMergedProposal } from "./history.ts";
import { cycleError } from "./types.ts";
import type { ReleaseCycleRequest, ReleaseCycleResult } from "./types.ts";

function releasedVersion(tag: string): string {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag))
    return cycleError(
      "invalid-release-tag",
      "The verified release proposal produced an unsupported version tag.",
    );
  return tag.slice(1);
}

export async function selectReleaseCycle(
  request: ReleaseCycleRequest,
  transport: GitHubRead = fetch,
): Promise<ReleaseCycleResult> {
  const configuration = parseReleaseInputConfiguration(structuredClone(request.configuration));
  const automation = parseReleaseAutomation(structuredClone(request.automation));
  const { token, sourceSha } = request;
  if (typeof sourceSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceSha))
    throw new ProposalConflictError("Supply a complete lowercase release source commit ID.");

  const api = new GitHubProposalRepository(configuration, automation.botUserId, token, transport);
  await api.verifyRepository();
  const pulls = await api.pulls();
  const open = pulls.filter((pull) => pull.state === "open");
  if (open.length > 1)
    return cycleError(
      "ambiguous-open-proposals",
      "Multiple reserved release proposals are open; review proposal history before selecting a cycle.",
    );
  for (const pull of open) {
    if (pull.merged)
      return cycleError(
        "ambiguous-release-history",
        "GitHub returned an open release proposal marked as merged.",
      );
  }

  const isAncestor = ancestry(api);
  const latest = await latestMergedProposal(pulls, isAncestor);
  const closedUnmerged = pulls
    .filter((pull) => pull.state === "closed" && !pull.merged)
    .map((pull) => pull.number)
    .toSorted((left, right) => left - right);

  if (latest === null) {
    if (closedUnmerged.length > 0)
      return { outcome: "closed-unmerged", sourceSha, pullNumbers: closedUnmerged };
    if (configuration.schemaVersion !== 2)
      return cycleError(
        "baseline-unavailable",
        "No verified tagged release proposal or explicit bootstrap baseline is available; refusing to infer a tag.",
      );

    if ((await api.ref("heads", configuration.releaseBranch)) !== sourceSha)
      return cycleError(
        "source-not-current",
        "The captured bootstrap source is no longer the configured release-branch tip; capture the current branch before selecting a baseline.",
      );

    if (configuration.freshSeries) await requireUnusedReleaseVersions(api);
    const commitSha = proposalSha(configuration.bootstrap.baselineSha);
    if (
      configuration.freshSeries &&
      (!(await isAncestor(commitSha, configuration.bootstrap.onboardingSha)) ||
        !(await isAncestor(configuration.bootstrap.onboardingSha, sourceSha)))
    )
      return cycleError(
        "source-not-descendant",
        "The fresh-series onboarding cutoff is outside the reviewed bootstrap range.",
      );
    if (!(await isAncestor(commitSha, sourceSha)))
      return cycleError(
        "source-not-descendant",
        "The explicit bootstrap baseline is not an ancestor of the captured release source.",
      );
    return {
      outcome: "selected",
      sourceSha,
      baseline: { kind: "bootstrap", commitSha },
      version: { kind: "bootstrap", initialVersion: "0.1.0" },
    };
  }

  const landingSha = latest.mergeCommitSha;
  if (landingSha === null)
    return cycleError(
      "ambiguous-release-history",
      "The latest merged release proposal has no exact landing commit.",
    );
  if (!(await isAncestor(landingSha, sourceSha)))
    return cycleError(
      "source-not-descendant",
      "The latest merged release landing is not an ancestor of the captured source; refusing to fall back to an older release tag.",
    );

  const adoption = configuration.adoptedRelease;
  if (adoption && latest.number === adoption.pullNumber) {
    const current = await api.readPull(latest.number);
    if (
      latest.headSha !== adoption.headSha ||
      landingSha !== adoption.landingSha ||
      current.headSha !== adoption.headSha ||
      current.mergeCommitSha !== landingSha ||
      current.state !== "closed" ||
      !current.merged ||
      !(await isAncestor(landingSha, adoption.commitSha)) ||
      !(await isAncestor(adoption.commitSha, sourceSha))
    )
      return cycleError(
        "baseline-unavailable",
        "The reviewed release adoption does not match merged history.",
      );

    const files = await api.contents(await api.tree(adoption.commitSha));
    const changelog = files["CHANGELOG.md"];
    const manifestVersion = { currentVersion: releasedVersion(adoption.tag), nextVersion: null };
    const nodeManifest = files["package.json"];
    const pythonManifest = files["pyproject.toml"];
    if (
      (nodeManifest === null && pythonManifest === null && files["Cargo.toml"] == null) ||
      !changelog ||
      changelog.includes("<!-- release-log:pending:") ||
      !changelog.split("\n").some((line) => line.startsWith(`## ${adoption.tag} (`))
    )
      return cycleError(
        "baseline-unavailable",
        "The adopted commit must contain the finalized changelog and matching package version.",
      );
    if (nodeManifest !== null) updatePackageVersion(nodeManifest, manifestVersion);
    if (pythonManifest !== null) updatePyprojectVersion(pythonManifest, manifestVersion);
    updateCargoVersions(files, manifestVersion);
    if (configuration.githubRelease) {
      const release = proposalObject((await api.request(`/releases/tags/${adoption.tag}`)).data);
      if (
        release.tag_name !== adoption.tag ||
        release.draft !== false ||
        release.prerelease !== false ||
        typeof release.published_at !== "string"
      )
        return cycleError(
          "github-release-pending",
          "The adopted boundary requires its published stable GitHub Release.",
        );
    }
    if ((await api.ref("tags", adoption.tag, true)) !== adoption.commitSha)
      return cycleError(
        "tag-changed",
        "The adopted lightweight tag is missing or points to a different commit.",
      );
    if ((await api.ref("heads", configuration.releaseBranch)) !== sourceSha)
      return cycleError("source-not-current", "The release branch advanced during adoption.");
    if (closedUnmerged.length > 0)
      return { outcome: "closed-unmerged", sourceSha, pullNumbers: closedUnmerged };
    return {
      outcome: "selected",
      sourceSha,
      baseline: {
        kind: "tag",
        adopted: true,
        name: adoption.tag,
        objectSha: adoption.commitSha,
        commitSha: adoption.commitSha,
        pullNumber: latest.number,
      },
      version: { kind: "released", currentVersion: releasedVersion(adoption.tag) },
    };
  }

  const tagResult = await reconcileReleaseTag(
    {
      configuration,
      automation,
      pullNumber: latest.number,
      landingSha,
      token,
      write: false,
    },
    transport,
  );
  if (tagResult.pullNumber !== latest.number || tagResult.landingSha !== landingSha)
    return cycleError(
      "ambiguous-release-history",
      "Release-tag reconciliation returned a different proposal or landing commit.",
    );
  if (tagResult.outcome === "would-create")
    return {
      outcome: "release-tag-pending",
      sourceSha,
      tag: tagResult.tag,
      landingSha,
      pullNumber: latest.number,
    };
  if (tagResult.release?.outcome === "would-create")
    return cycleError(
      "github-release-pending",
      `The verified tag has no GitHub Release; rerun tag-release for PR #${latest.number} at ${landingSha} before the next cycle.`,
    );
  if (tagResult.outcome !== "unchanged")
    return cycleError(
      "tag-changed",
      "Read-only release-tag reconciliation returned an unexpected write outcome.",
    );

  if (closedUnmerged.length > 0)
    return { outcome: "closed-unmerged", sourceSha, pullNumbers: closedUnmerged };

  const objectShaBefore = await api.ref("tags", tagResult.tag);
  if (objectShaBefore === null)
    return cycleError("tag-changed", "The verified release tag disappeared during selection.");
  const rechecked = await reconcileReleaseTag(
    {
      configuration,
      automation,
      pullNumber: latest.number,
      landingSha,
      token,
      write: false,
    },
    transport,
  );
  if (rechecked.release?.outcome === "would-create")
    return cycleError(
      "github-release-pending",
      "The GitHub Release disappeared during cycle selection; rerun tag-release before continuing.",
    );
  const objectShaAfter = await api.ref("tags", tagResult.tag);
  if (
    rechecked.outcome !== "unchanged" ||
    rechecked.tag !== tagResult.tag ||
    rechecked.landingSha !== landingSha ||
    objectShaBefore !== objectShaAfter
  )
    return cycleError(
      "tag-changed",
      "The exact release tag changed during cycle selection; retry from fresh GitHub state.",
    );

  return {
    outcome: "selected",
    sourceSha,
    baseline: {
      kind: "tag",
      name: tagResult.tag,
      objectSha: objectShaAfter,
      commitSha: landingSha,
      pullNumber: latest.number,
    },
    version: { kind: "released", currentVersion: releasedVersion(tagResult.tag) },
  };
}
