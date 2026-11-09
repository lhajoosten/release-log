import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repository = "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/";
export interface ApkPin {
  file: string;
  sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readApkLock(value: unknown): ApkPin[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.repository !== repository ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > 64
  )
    throw new Error("Invalid Alpine 3.24 x86_64 package lock.");
  const files = new Set<string>();
  return value.packages.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.file !== "string" ||
      !/^[a-z0-9][a-z0-9+_.-]*-[0-9][a-zA-Z0-9+_.-]*\.apk$/u.test(item.file) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      files.has(item.file)
    )
      throw new Error("Invalid or duplicate Alpine package pin.");
    files.add(item.file);
    return { file: item.file, sha256: item.sha256 };
  });
}

export async function stageContainerApks(directory: string, pins: readonly ApkPin[]) {
  await mkdir(directory);
  for (const pin of pins) {
    const response = await fetch(repository + pin.file, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok)
      throw new Error(`APK download failed for ${pin.file}: HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) throw new Error(`APK exceeds size limit: ${pin.file}.`);
    if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      throw new Error(`APK checksum mismatch: ${pin.file}.`);
    await writeFile(join(directory, pin.file), bytes);
  }
}
