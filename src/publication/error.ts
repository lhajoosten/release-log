export class ReleasePublicationError extends Error {
  readonly code:
    | "invalid-input"
    | "conflict"
    | "incomplete-evidence"
    | "resource-limit"
    | "read-failed"
    | "write-failed";

  constructor(code: ReleasePublicationError["code"], message: string) {
    super(message);
    this.name = "ReleasePublicationError";
    this.code = code;
  }
}

export function fail(code: ReleasePublicationError["code"], message: string): never {
  throw new ReleasePublicationError(code, message);
}
