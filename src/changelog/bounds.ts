export class ChangelogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangelogError";
  }
}

const maximumBytes = 16 * 1024 * 1024;

export function bounded(value: string): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes)
    throw new ChangelogError("Changelog exceeds 16 MiB in UTF-8.");
}
