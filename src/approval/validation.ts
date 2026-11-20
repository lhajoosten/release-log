export class ReleaseApprovalError extends Error {
  readonly code:
    | "approval-invalid"
    | "identity-mismatch"
    | "stale-source"
    | "baseline-mismatch"
    | "content-mismatch"
    | "unsupported-merge"
    | "exclusion-invalid"
    | "readiness-failed"
    | "resource-limit";
  constructor(code: ReleaseApprovalError["code"], message: string) {
    super(message);
    this.name = "ReleaseApprovalError";
    this.code = code;
  }
}
export function invalid(message: string): never {
  throw new ReleaseApprovalError("approval-invalid", message);
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return invalid("Approval records/policies require exactly the supported schema fields.");
  return Object.fromEntries(Object.entries(value));
}
export function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid("Approval identities require positive safe integer IDs.");
  return value;
}
