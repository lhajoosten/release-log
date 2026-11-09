import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixtureConfiguration, releaseFixture } from "../tests/release-fixture.ts";

function failure(code: number, message: RegExp) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    message.test(error.stderr) &&
    !error.stderr.includes("synthetic-runtime-only-secret");
}

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Container smoke tests currently support Linux x86-64 hosts only.");
const uid = process.getuid?.();
const gid = process.getgid?.();
assert.ok(uid !== undefined && gid !== undefined);
const directory = await mkdtemp(join(tmpdir(), "release-container-smoke-"));
const image = `release-log-smoke:${randomUUID()}`;
let built = false;
try {
  const build = await execute("pnpm", ["container:build", "--tag", image], {
    cwd: root,
    timeout: 360_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  built = true;
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  await chmod(directory, 0o755);
  const snapshot = await releaseFixture([{ title: "fix(api): retain selected rows" }]);
  await writeFile(join(directory, "config.json"), JSON.stringify(fixtureConfiguration));
  await writeFile(join(directory, "inputs.json"), snapshot.serialized);
  const repository = join(directory, "repo");
  await mkdir(repository);
  await writeFile(
    join(repository, "package.json"),
    '{"version":"1.2.3","scripts":{"prepare":"touch /workspace/executed"}}\n',
  );
  await writeFile(join(repository, "pyproject.toml"), '[project]\nversion="1.2.3" # preserve\n');
  const gitEnvironment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE",
  ])
    delete gitEnvironment[name];
  async function git(args: string[]) {
    return (
      await execute("git", ["--no-pager", ...args], {
        cwd: repository,
        env: gitEnvironment,
        timeout: 10_000,
      })
    ).stdout.trim();
  }
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Container Fixture"]);
  await git(["config", "user.email", "container@example.invalid"]);
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "chore: initialize fixture"]);
  const baseline = await git(["rev-parse", "HEAD"]);
  await writeFile(join(repository, "change.txt"), "ordinary source change\n");
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fix: retain rows"]);
  const source = await git(["rev-parse", "HEAD"]);

  await writeFile(
    join(directory, "adoption-config.json"),
    JSON.stringify({
      ...fixtureConfiguration,
      schemaVersion: 2,
      bootstrap: { baselineSha: baseline, onboardingSha: source },
    }),
  );

  await writeFile(
    join(repository, ".git", "hooks", "post-checkout"),
    "#!/bin/sh\ntouch /workspace/executed\n",
  );
  await chmod(join(repository, ".git", "hooks", "post-checkout"), 0o755);
  async function run(
    args: string[],
    write = false,
    user = `${uid}:${gid}`,
    entrypoint?: string,
    environment: string[] = [],
  ) {
    return execute(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=32m",
        "--user",
        user,
        "--mount",
        `type=bind,src=${directory},dst=/workspace${write ? "" : ",readonly"}`,
        ...environment.flatMap((value) => ["--env", value]),
        ...(entrypoint ? ["--entrypoint", entrypoint] : []),
        image,
        ...args,
      ],
      { cwd: root, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
  }

  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(
    typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string",
  );
  assert.equal(
    (
      await execute(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          image,
          "--version",
        ],
        { timeout: 20_000 },
      )
    ).stdout,
    `${manifest.version}\n`,
  );
  assert.equal((await run(["--version"])).stdout, `${manifest.version}\n`);
  assert.match((await run(["--help"])).stdout, /verify-approval/u);
  const inspect: unknown = JSON.parse(
    (await execute("docker", ["image", "inspect", image], { timeout: 10_000 })).stdout,
  );
  assert.ok(Array.isArray(inspect));
  const metadata: unknown = inspect[0];
  assert.ok(
    typeof metadata === "object" && metadata !== null && "Config" in metadata && "Size" in metadata,
  );
  const config = metadata.Config;
  assert.ok(
    typeof config === "object" &&
      config !== null &&
      "User" in config &&
      "Labels" in config &&
      "Env" in config,
  );
  assert.equal(config.User, "1000:1000");
  assert.ok(
    typeof config.Labels === "object" &&
      config.Labels !== null &&
      "org.opencontainers.image.version" in config.Labels,
  );
  assert.equal(config.Labels["org.opencontainers.image.version"], manifest.version);
  assert.ok(!JSON.stringify(config.Env).includes("GITHUB_TOKEN"));
  await run(
    [
      "--input-type=module",
      "-e",
      'import { existsSync } from "node:fs"; for (const path of [".git", ".env", ".npmrc", "src", "tests", "scripts", "node_modules/typescript", "node_modules/vitepress"]) if (existsSync("/opt/release-log/" + path)) throw new Error("Unexpected runtime material: " + path);',
    ],
    false,
    `${uid}:${gid}`,
    "node",
  );
  await run(
    [
      "--input-type=module",
      "-e",
      'import { existsSync, readdirSync } from "node:fs"; for (const path of ["/usr/local/lib/node_modules/npm", "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg"]) if (existsSync(path)) throw new Error("Unexpected package manager: " + path); if (readdirSync("/opt").some((name) => name.startsWith("yarn-"))) throw new Error("Unexpected Yarn installation");',
    ],
    false,
    `${uid}:${gid}`,
    "node",
  );
  const expectedNode = (await readFile(join(root, ".node-version"), "utf8")).trim();
  await run(
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict"; import { existsSync, readFileSync } from "node:fs"; const os = readFileSync("/etc/os-release", "utf8"); assert.match(os, /^ID=alpine$/m); assert.match(readFileSync("/etc/alpine-release", "utf8"), /^3\\.24\\./); assert.equal(process.version, ${JSON.stringify(`v${expectedNode}`)}); assert.equal(existsSync("/tmp/release-log-apks"), false);`,
    ],
    false,
    `${uid}:${gid}`,
    "node",
  );
  const args = [
    "--config",
    "/workspace/config.json",
    "--snapshot",
    "/workspace/inputs.json",
    "--current-version",
    "1.2.3",
  ];
  const plan: unknown = JSON.parse((await run(["plan", ...args])).stdout);
  assert.ok(typeof plan === "object" && plan !== null && "nextVersion" in plan);
  assert.equal(plan.nextVersion, "1.2.4");
  assert.match((await run(["render", ...args])).stdout, /^## v1\.2\.4/u);
  const before = await readFile(join(repository, "package.json"), "utf8");
  await run(["prepare", ...args, "--repository", "/workspace/repo", "--dry-run"]);
  assert.equal(await readFile(join(repository, "package.json"), "utf8"), before);
  await assert.rejects(
    run(["prepare", ...args, "--repository", "/workspace/repo", "--write"]),
    failure(1, /release-log:/u),
  );
  await run(["prepare", ...args, "--repository", "/workspace/repo", "--write"], true);
  assert.match(await readFile(join(repository, "package.json"), "utf8"), /"version":"1.2.4"/u);
  assert.equal(
    await readFile(join(repository, "pyproject.toml"), "utf8"),
    '[project]\nversion="1.2.4" # preserve\n',
  );
  for (const path of ["CHANGELOG.md", ".release-log/inputs.json"]) {
    const info = await stat(join(repository, path));
    assert.equal(info.uid, uid);
    assert.equal(info.gid, gid);
  }
  assert.equal(
    (
      await run(["-C", "/workspace/repo", "rev-parse", "HEAD"], false, `${uid}:${gid}`, "git")
    ).stdout.trim(),
    source,
  );
  await assert.rejects(
    run(
      ["-C", "/workspace/repo", "rev-parse", "HEAD"],
      false,
      `${uid === 65534 ? 65533 : 65534}:65534`,
      "git",
    ),
    failure(128, /dubious ownership/u),
  );
  await assert.rejects(
    run(
      [
        "collect",
        "--config",
        "/workspace/adoption-config.json",
        "--repository",
        "/workspace/repo",
        "--source",
        source,
        "--bootstrap-sha",
        baseline,
      ],
      false,
      `${uid}:${gid}`,
      undefined,
      ["GITHUB_TOKEN=synthetic-runtime-only-secret"],
    ),
    failure(1, /GitHub read failed/u),
  );
  await assert.rejects(stat(join(directory, "executed")), { code: "ENOENT" });
  await writeFile(
    join(directory, "fetch-helper"),
    "#!/bin/sh\ntouch /workspace/executed\nexit 1\n",
  );
  await chmod(join(directory, "fetch-helper"), 0o755);
  await git(["config", "remote.origin.url", "ext::/workspace/fetch-helper"]);
  await git(["config", "remote.origin.promisor", "true"]);
  await git(["config", "protocol.ext.allow", "always"]);
  // Prove that the synthetic promisor executes if lazy fetch is not disabled.
  await assert.rejects(
    run(["-C", "/workspace/repo", "cat-file", "-t", "a".repeat(40)], true, `${uid}:${gid}`, "git", [
      "GIT_NO_LAZY_FETCH=0",
    ]),
    failure(128, /fatal/u),
  );
  assert.ok((await stat(join(directory, "executed"))).isFile());
  await rm(join(directory, "executed"));
  await run(
    [
      "--input-type=module",
      "-e",
      'import { inspectCommit } from "/opt/release-log/dist/src/git.js"; try { await inspectCommit("/workspace/repo", "a".repeat(40)); throw new Error("Accepted a missing object"); } catch (error) { if (error.code !== "commit-not-found") throw error; }',
    ],
    true,
    `${uid}:${gid}`,
    "node",
  );
  await assert.rejects(stat(join(directory, "executed")), { code: "ENOENT" });
  await assert.rejects(run(["unknown"]), failure(2, /Unknown command/u));
  await writeFile(join(directory, "invalid.json"), '{"schemaVersion":99}');
  await assert.rejects(
    run([
      "plan",
      "--config",
      "/workspace/config.json",
      "--snapshot",
      "/workspace/invalid.json",
      "--current-version",
      "1.2.3",
    ]),
    failure(1, /release-log:/u),
  );
  const gitVersion = (await run(["--version"], false, `${uid}:${gid}`, "git")).stdout.trim();
  process.stdout.write(
    `Container smoke passed: ${manifest.version}, ${gitVersion}, image size ${String(metadata.Size)} bytes; offline/network-disabled, UID/mount/exit-status checks passed.\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  if (built) await execute("docker", ["image", "rm", image], { timeout: 30_000 });
}
