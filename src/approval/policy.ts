import { invalid, object, positive } from "./validation.ts";

export interface RequiredReleaseCheck {
  readonly name: string;
  readonly appId: number;
  readonly workflowId: number;
  readonly event: "pull_request" | "pull_request_target";
}

export type ReleaseApprovalPolicy = {
  readonly botUserId: number;
  readonly approverUserIds: readonly number[];
} & (
  | { readonly schemaVersion: 1 }
  | { readonly schemaVersion: 2; readonly requiredChecks: readonly RequiredReleaseCheck[] }
);
export function parseReleaseApprovalPolicy(value: unknown): ReleaseApprovalPolicy {
  const version2 =
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 2;
  const item = object(value, [
    "schemaVersion",
    "botUserId",
    "approverUserIds",
    ...(version2 ? ["requiredChecks"] : []),
  ]);
  if (
    (item.schemaVersion !== 1 && item.schemaVersion !== 2) ||
    !Array.isArray(item.approverUserIds) ||
    item.approverUserIds.length < 1 ||
    item.approverUserIds.length > 1000
  )
    return invalid(
      "Configure approval policy schema 1 or 2 and an explicit nonempty bounded list of human approver IDs.",
    );
  const botUserId = positive(item.botUserId);
  const approverUserIds = item.approverUserIds.map(positive).toSorted((a, b) => a - b);
  if (
    new Set(approverUserIds).size !== approverUserIds.length ||
    approverUserIds.includes(botUserId)
  )
    return invalid("Human approvers must be unique and must not include the automation bot.");
  if (!version2) return { schemaVersion: 1, botUserId, approverUserIds };

  if (
    !Array.isArray(item.requiredChecks) ||
    item.requiredChecks.length < 1 ||
    item.requiredChecks.length > 20
  )
    return invalid("Approval policy 2 requires 1–20 explicitly trusted workflow/job/App checks.");

  const requiredChecks = item.requiredChecks
    .map((entry: unknown): RequiredReleaseCheck => {
      const check = object(entry, ["name", "appId", "workflowId", "event"]);

      if (
        typeof check.name !== "string" ||
        !check.name.trim() ||
        check.name.length > 128 ||
        check.name
          .split("")
          .some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
        (check.event !== "pull_request" && check.event !== "pull_request_target")
      )
        return invalid("Required checks need bounded job names and explicit PR workflow events.");

      return {
        name: check.name,
        appId: positive(check.appId),
        workflowId: positive(check.workflowId),
        event: check.event,
      };
    })
    .toSorted(
      (left, right) =>
        left.workflowId - right.workflowId ||
        (left.event < right.event ? -1 : left.event > right.event ? 1 : 0) ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );

  if (
    new Set(
      requiredChecks.map((check) => JSON.stringify([check.workflowId, check.event, check.name])),
    ).size !== requiredChecks.length
  )
    return invalid(
      "Required workflow/job checks must be unique, with one trusted App identity each.",
    );

  return { schemaVersion: 2, botUserId, approverUserIds, requiredChecks };
}
