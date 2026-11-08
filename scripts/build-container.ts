import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--tag" ||
  !/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u.test(args[1] ?? "")
)
  throw new Error(
    "Usage: pnpm container:build --tag LOCAL_IMAGE:TAG (local build only; never pushes).",
  );
const tag = args[1];
if (!tag) throw new Error("An explicit local image tag is required.");
const directory = await mkdtemp(join(tmpdir(), "release-container-build-"));
try {
  const context = join(directory, "context");
  const runtime = join(context, "runtime");
  await mkdir(runtime, { recursive: true });
  await execute("pnpm", ["pack", "--pack-destination", directory], {
    cwd: root,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  const archive = archives[0];
  if (archives.length !== 1 || !archive)
    throw new Error("Expected exactly one packaged CLI archive.");
  await execute(
    "tar",
    ["-xzf", join(directory, archive), "--strip-components=1", "--directory", runtime],
    { timeout: 10_000 },
  );
  await copyFile(join(runtime, "dist", "dependency-lock.txt"), join(runtime, "pnpm-lock.yaml"));
  await execute(
    "pnpm",
    ["install", "--offline", "--prod", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: runtime, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  for (const path of [
    "pnpm-lock.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
  ])
    await rm(join(runtime, path), { force: true });
  const manifest: unknown = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version)
  )
    throw new Error("The packaged artifact must declare a stable tool version.");
  for (const name of ["Dockerfile", ".dockerignore"])
    await copyFile(join(root, "container", name), join(context, name));
  const built = await execute(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--build-arg",
      `TOOL_VERSION=${manifest.version}`,
      "--tag",
      tag,
      context,
    ],
    { cwd: root, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
  );
  process.stdout.write(built.stdout);
  process.stderr.write(built.stderr);
  process.stdout.write(
    `Built local ${tag} from packaged release-log ${manifest.version}; no registry publication.\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
