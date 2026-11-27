import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
await rm(new URL("dist/", root), { recursive: true, force: true });
await promisify(execFile)("pnpm", ["exec", "tsc", "--project", "tsconfig.build.json"], {
  cwd: root,
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
});
await chmod(new URL("dist/src/cli.js", root), 0o755);
