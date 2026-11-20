import { readFile, stat } from "node:fs/promises";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export async function readText(path: string, maximum = 16 * 1024 * 1024): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum)
    throw new UsageError("Input must be an ordinary file within its size limit.");
  const result = await readFile(path, "utf8");
  if (Buffer.byteLength(result, "utf8") > maximum)
    throw new UsageError("Input exceeds its size limit.");
  return result;
}

export function required<K extends string>(
  options: Pick<ReadonlyMap<K, string | true>, "get">,
  key: NoInfer<K>,
): string {
  const value = options.get(key);
  if (typeof value !== "string" || !value) throw new UsageError(`Missing value for --${key}.`);
  return value;
}
