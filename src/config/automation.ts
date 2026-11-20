import { ProposalConflictError, proposalObject } from "../evidence/proposal.ts";

export interface ReleaseAutomationConfiguration {
  readonly schemaVersion: 1;
  readonly botUserId: number;
}
export function parseReleaseAutomation(value: unknown): ReleaseAutomationConfiguration {
  const item = proposalObject(value);
  if (
    item.schemaVersion !== 1 ||
    Object.keys(item).toSorted().join(",") !== "botUserId,schemaVersion" ||
    typeof item.botUserId !== "number" ||
    !Number.isSafeInteger(item.botUserId) ||
    item.botUserId <= 0
  )
    throw new ProposalConflictError(
      "Configure exactly schemaVersion 1 and the expected positive numeric botUserId.",
    );
  return { schemaVersion: 1, botUserId: item.botUserId };
}
