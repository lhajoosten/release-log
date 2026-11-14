import { inspectCommit, inspectPendingRelease } from "./git.ts";
import { collectMergedPullRequests } from "./github-association.ts";
import {
  GitHubProposalRepository,
  ProposalConflictError,
  proposalObject,
  proposalSha,
} from "./github-proposals.ts";
import type { GitHubRead } from "./github.ts";
import { selectReleaseCycle } from "./release-cycle.ts";
import { parseReleaseAutomation, reconcileReleaseProposal } from "./release-proposal.ts";
import type { ReleaseAutomationConfiguration, ReleaseProposalResult } from "./release-proposal.ts";
import {
  captureReleaseSnapshot,
  parseReleaseInputConfiguration,
  serializeReleaseSnapshot,
} from "./release-snapshot.ts";
import type { ReleaseInputConfiguration } from "./release-snapshot.ts";
import { reconcileReleaseTag } from "./release-tag.ts";
import type { ReleaseTagResult } from "./release-tag.ts";

export interface ReleaseRollRequest {
  readonly configuration: ReleaseInputConfiguration;
  readonly automation: ReleaseAutomationConfiguration;
  readonly repository: string;
  readonly token: string;
  readonly eventName: string;
  readonly event: unknown;
  readonly write?: boolean;
}

export type ReleaseRollResult =
  | { readonly route: "ignored" }
  | { readonly route: "tag"; readonly result: ReleaseTagResult }
  | { readonly route: "proposal"; readonly result: ReleaseProposalResult };

// Event data only identifies the merge to re-read. It never authorizes a proposal
// exemption or supplies executable configuration or a checkout revision.
export async function rollRelease(
  request: ReleaseRollRequest,
  transport: GitHubRead = fetch,
): Promise<ReleaseRollResult> {
  const configuration = parseReleaseInputConfiguration(structuredClone(request.configuration));
  const automation = parseReleaseAutomation(structuredClone(request.automation));
  if (request.write !== undefined && typeof request.write !== "boolean")
    throw new ProposalConflictError("An explicit boolean write option is required.");
  if (configuration.automationExclusions !== undefined)
    throw new ProposalConflictError(
      "Rolling releases use tag boundaries; separate exclusion authorities are unsupported here.",
    );
  if (request.eventName !== "pull_request_target" && request.eventName !== "pull_request")
    return { route: "ignored" };
  const event = proposalObject(request.event);
  if (event.action !== "closed") return { route: "ignored" };
  const eventRepository = proposalObject(event.repository);
  if (
    eventRepository.id !== configuration.repositoryId ||
    eventRepository.full_name !== configuration.repository
  )
    throw new ProposalConflictError("The merge event belongs to a different repository.");
  const eventPull = proposalObject(event.pull_request);
  if (eventPull.merged !== true) return { route: "ignored" };
  const number = eventPull.number;
  if (
    !Number.isSafeInteger(number) ||
    typeof number !== "number" ||
    number <= 0 ||
    event.number !== number
  )
    throw new ProposalConflictError("The merge event needs one positive pull request number.");
  if (proposalObject(eventPull.base).ref !== configuration.releaseBranch)
    return { route: "ignored" };
  const landingSha = proposalSha(eventPull.merge_commit_sha);
  const api = new GitHubProposalRepository(
    configuration,
    automation.botUserId,
    request.token,
    transport,
  );
  await api.verifyRepository();
  const pull = proposalObject((await api.request(`/pulls/${number}`)).data);
  const base = proposalObject(pull.base);
  const baseRepository = proposalObject(base.repo);
  if (
    pull.number !== number ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    typeof pull.merged_at !== "string" ||
    pull.merge_commit_sha !== landingSha ||
    base.ref !== configuration.releaseBranch ||
    baseRepository.id !== configuration.repositoryId ||
    baseRepository.full_name !== configuration.repository
  )
    throw new ProposalConflictError(
      "The current merged PR differs from its event repository, branch or landing.",
    );

  const head = proposalObject(pull.head);
  const author = proposalObject(pull.user);
  if (head.ref === api.headRef || author.id === automation.botUserId) {
    // Full reconstruction and identity/landing checks happen before any tag
    // write. Failed release verification must never fall through to collection.
    return {
      route: "tag",
      result: await reconcileReleaseTag(
        {
          configuration,
          automation,
          pullNumber: number,
          landingSha,
          token: request.token,
          write: request.write === true,
        },
        transport,
      ),
    };
  }

  const sourceSha = await api.ref("heads", configuration.releaseBranch);
  if (sourceSha === null) throw new ProposalConflictError("The release branch is missing.");
  await api.requireDescendant(landingSha, sourceSha);
  const cycle = await selectReleaseCycle(
    { configuration, automation, token: request.token, sourceSha },
    transport,
  );
  if (cycle.outcome === "release-tag-pending")
    throw new ProposalConflictError(
      `release-tag-pending: rerun tag-release for PR #${cycle.pullNumber} at ${cycle.landingSha} to create ${cycle.tag}.`,
    );
  if (cycle.outcome !== "selected")
    throw new ProposalConflictError(
      `Closed unmerged release proposals require manual recovery: ${cycle.pullNumbers.join(", ")}.`,
    );

  // This is deliberately after the pending-tag guard and before PR collection.
  // Local ref object and peeled commit must both match the selected remote tag.
  const range = await inspectPendingRelease(request.repository, cycle.baseline, sourceSha);
  if (
    range.baseline.kind !== cycle.baseline.kind ||
    range.baseline.commitSha !== cycle.baseline.commitSha ||
    (cycle.baseline.kind === "tag" &&
      (range.baseline.kind !== "tag" ||
        range.baseline.name !== cycle.baseline.name ||
        range.baseline.objectSha !== cycle.baseline.objectSha))
  )
    throw new ProposalConflictError(
      "Local baseline tag/object/commit differs from GitHub; fetch unchanged tags and retry.",
    );
  await inspectCommit(request.repository, landingSha);
  if ((await api.ref("heads", configuration.releaseBranch)) !== sourceSha)
    throw new ProposalConflictError(
      "The release source changed before collection; retry with current history.",
    );
  if (
    cycle.baseline.kind === "tag" &&
    (await api.ref("tags", cycle.baseline.name)) !== cycle.baseline.objectSha
  )
    throw new ProposalConflictError(
      "The selected release tag changed before collection; retry from fresh state.",
    );
  const snapshot = await captureReleaseSnapshot(
    await collectMergedPullRequests(
      {
        repository: configuration.repository,
        releaseBranch: configuration.releaseBranch,
        localRepository: request.repository,
        range,
        token: request.token,
        ...(cycle.baseline.kind === "bootstrap" && configuration.schemaVersion === 2
          ? { onboardingSha: configuration.bootstrap.onboardingSha }
          : {}),
      },
      transport,
    ),
    configuration,
  );
  return {
    route: "proposal",
    result: await reconcileReleaseProposal(
      {
        configuration,
        automation,
        token: request.token,
        snapshot: await serializeReleaseSnapshot(snapshot),
        version: cycle.version,
        write: request.write === true,
      },
      transport,
    ),
  };
}
