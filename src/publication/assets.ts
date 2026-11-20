import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fail, ReleasePublicationError } from "./error.ts";
import type { PublicationReceipt } from "./types.ts";

export async function publicationAssets(
  directory: string,
  receipt: PublicationReceipt,
): Promise<ReadonlyMap<string, Uint8Array<ArrayBuffer>>> {
  if (
    receipt.assets.some((asset) => asset.size > 64 * 1024 * 1024) ||
    receipt.assets.reduce((total, asset) => total + asset.size, 0) > 128 * 1024 * 1024
  )
    return fail("resource-limit", "Publication assets exceed 64 MiB per file or 128 MiB total.");

  const assets = new Map<string, Uint8Array<ArrayBuffer>>();

  try {
    const root = resolve(directory);

    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
      return fail(
        "invalid-input",
        "Publication assets require an ordinary directory without symlink parents.",
      );

    for (const asset of receipt.assets) {
      const path = join(root, asset.name);

      if (!(await lstat(path)).isFile())
        return fail(
          "invalid-input",
          "Publication assets must be ordinary files, not links or special files.",
        );

      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      try {
        const before = await handle.stat();

        if (!before.isFile() || before.size !== asset.size)
          return fail(
            "conflict",
            "Local publication asset size differs from its trusted build receipt.",
          );

        // Keep the exact verified bytes in memory; never reopen a path for upload.
        const bytes = new Uint8Array(asset.size + 1);
        let offset = 0;

        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);

          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }

        const after = await handle.stat();
        const payload = bytes.subarray(0, asset.size);

        if (
          offset !== asset.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          createHash("sha256").update(payload).digest("hex") !== asset.sha256
        )
          return fail(
            "conflict",
            "Local publication asset changed or differs from its trusted build digest.",
          );

        assets.set(asset.name, payload);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error instanceof ReleasePublicationError) throw error;
    return fail(
      "invalid-input",
      "Cannot read ordinary publication assets; verify the directory and file permissions.",
    );
  }

  return assets;
}
