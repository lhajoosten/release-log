import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
await rm(new URL("dist/", root), { recursive: true, force: true });
await promisify(execFile)("pnpm", ["exec", "tsc", "--project", "tsconfig.build.json"], {
  cwd: root,
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
});
await mkdir(new URL("dist/", root), { recursive: true });
for (const path of ["package.json", "commitlint.base.config.mjs"])
  await copyFile(new URL(path, root), new URL(`dist/${path}`, root));
// Package managers omit lockfile-named files even inside the runtime directory.
await copyFile(new URL("pnpm-lock.yaml", root), new URL("dist/dependency-lock.txt", root));
await chmod(new URL("dist/src/cli.js", root), 0o755);
