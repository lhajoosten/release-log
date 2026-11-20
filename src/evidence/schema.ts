import type { ReadinessIssue } from "./readiness-issue.ts";

export class ReleaseSnapshotError extends Error {
  readonly code:
    | "schema-invalid"
    | "resource-limit"
    | "metadata-invalid"
    | "integrity-mismatch"
    | "configuration-mismatch"
    | "normalizer-mismatch";
  readonly issues: readonly ReadinessIssue[];
  constructor(
    code: ReleaseSnapshotError["code"],
    message: string,
    issues: readonly ReadinessIssue[] = [],
  ) {
    super(message);
    this.name = "ReleaseSnapshotError";
    this.code = code;
    this.issues = issues;
  }
}

export function invalid(message: string): never {
  throw new ReleaseSnapshotError("schema-invalid", message);
}

export function limit(message: string): never {
  throw new ReleaseSnapshotError("resource-limit", message);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value)) return invalid(`Expected ${label} to be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    return invalid(`Unexpected or missing fields in ${label}.`);
  return value;
}

export function text(value: unknown, label: string, bytes = 1024 * 1024): string {
  if (typeof value !== "string") return invalid(`Expected ${label} to be text.`);
  if (Buffer.byteLength(value, "utf8") > bytes) return limit(`${label} exceeds its text limit.`);
  return value;
}

export function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid(`Expected a positive integer for ${label}.`);
  return value;
}

export function sha(value: unknown): string {
  const result = text(value, "object ID", 64);
  if (result.trim() !== result || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result))
    return invalid("Expected a complete lowercase SHA-1 or SHA-256 object ID.");
  return result;
}

export function array(value: unknown, size: number, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(`Expected ${label} to be an array.`);
  if (value.length > size) return limit(`${label} exceeds its entry limit.`);
  return value;
}

export function unique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate entries in ${label}.`);
}
