import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planVersionFiles } from "../src/release/version-files.ts";

void test("plans shared Cargo updates without changing the source or external lock entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-version-"));
  try {
    await mkdir(join(root, "crates", "cli"), { recursive: true });
    await mkdir(join(root, "crates", "core"), { recursive: true });
    const manifest =
      '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.2.3"\n';
    const cli =
      '[package]\nname = "widget-cli"\nversion.workspace = true\n\n[dependencies]\nwidget-core = { path = "../core", version = "^1.2.3" }\n';
    const core = '[package]\nname = "widget-core"\nversion.workspace = true\n';
    const lock =
      'version = 4\n\n[[package]]\nname = "widget-cli"\nversion = "1.2.3"\ndependencies = [\n "widget-core 1.2.3",\n "widget-core 1.2.3 (registry+https://github.com/rust-lang/crates.io-index)",\n]\n\n[[package]]\nname = "widget-core"\nversion = "1.2.3"\n\n[[package]]\nname = "widget-core"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abcdef"\n';
    await Promise.all(
      [
        ["Cargo.toml", manifest],
        ["crates/cli/Cargo.toml", cli],
        ["crates/core/Cargo.toml", core],
        ["Cargo.lock", lock],
      ].map(([path, content]) => writeFile(join(root, path!), content!)),
    );
    const changes = await planVersionFiles(root, "1.2.3", "1.3.0");
    assert.equal(changes.get("Cargo.toml"), manifest.replace("1.2.3", "1.3.0"));
    assert.equal(changes.get("crates/cli/Cargo.toml"), cli.replace("1.2.3", "1.3.0"));
    assert.equal(
      changes.get("Cargo.lock"),
      lock
        .replace(/version = "1\.2\.3"(?=\ndependencies|\n\n)/gu, 'version = "1.3.0"')
        .replace('"widget-core 1.2.3"', '"widget-core 1.3.0"'),
    );
    assert.equal(await readFile(join(root, "Cargo.lock"), "utf8"), lock);
    await assert.rejects(planVersionFiles(root, "1.2.2", "1.3.0"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("plans pnpm shared workspace members and local dependency ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-pnpm-"));
  try {
    await mkdir(join(root, "packages", "core"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      '{"name":"root","version":"1.2.3","private":true,"dependencies":{"core":"^1.2.3"}}\n',
    );
    await writeFile(
      join(root, "packages/core/package.json"),
      '{"name":"core","version":"1.2.3"}\n',
    );
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      core:\n        specifier: ^1.2.3\n        version: link:packages/core\n  packages/core: {}\n',
    );
    const files = await planVersionFiles(root, "1.2.3", "1.3.0");
    assert.equal(
      files.get("package.json"),
      '{"name":"root","version":"1.3.0","private":true,"dependencies":{"core":"^1.3.0"}}\n',
    );
    assert.equal(files.get("packages/core/package.json"), '{"name":"core","version":"1.3.0"}\n');
    assert.match(String(files.get("pnpm-lock.yaml")), /specifier: \^1\.3\.0/u);
    assert.match(String(files.get("pnpm-lock.yaml")), /version: link:packages\/core/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("plans Bun text lock workspaces while preserving external resolutions", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-bun-"));
  try {
    await mkdir(join(root, "packages", "core"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      '{"name":"root","version":"1.2.3","workspaces":["packages/*"],"dependencies":{"core":"^1.2.3"}}\n',
    );
    await writeFile(
      join(root, "packages/core/package.json"),
      '{"name":"core","version":"1.2.3"}\n',
    );
    await writeFile(
      join(root, "bun.lock"),
      '{\n  // a fixture\n  "lockfileVersion": 1,\n  "workspaces": {"": {"name":"root","version":"1.2.3","dependencies":{"core":"^1.2.3"}}, "packages/core": {"name":"core","version":"1.2.3"}},\n  "packages": {"external": ["external@1.2.3", "sha512-example"]},\n}\n',
    );
    const files = await planVersionFiles(root, "1.2.3", "1.3.0");
    const lock = JSON.parse(String(files.get("bun.lock")));
    assert.equal(lock.workspaces[""].dependencies.core, "^1.3.0");
    assert.equal(lock.workspaces["packages/core"].version, "1.3.0");
    assert.deepEqual(lock.packages.external, ["external@1.2.3", "sha512-example"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("bootstrap omits unchanged Node workspace lockfiles", async (t) => {
  for (const lockPath of [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "bun.lock",
    "pnpm-lock.yaml",
  ]) {
    const root = await mkdtemp(join(tmpdir(), "release-node-bootstrap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manifest = '{"name":"root","version":"0.1.0","workspaces":["."]}\n';
    await writeFile(join(root, "package.json"), manifest);
    let lock: string;
    if (lockPath === "bun.lock") {
      lock =
        '{\n  // preserve this comment\n  "lockfileVersion": 1,\n  "workspaces": {"": {"name":"root","version":"0.1.0"}},\n}\n';
    } else if (lockPath === "pnpm-lock.yaml") {
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
      lock = 'lockfileVersion: "9.0"\nimporters:\n  .: {}\n';
    } else {
      lock = `${JSON.stringify({ name: "root", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "root", version: "0.1.0" } } }, null, 2)}\n`;
    }
    await writeFile(join(root, lockPath), lock);
    const changes = await planVersionFiles(root, null, "0.1.0");
    assert.equal(changes.has(lockPath), false, lockPath);
    assert.equal(await readFile(join(root, lockPath), "utf8"), lock, lockPath);
  }
});

void test("rejects symlinked pnpm configuration and lockfiles before reading them", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-pnpm-link-"));
  try {
    await writeFile(
      join(root, "package.json"),
      '{"name":"root","version":"1.2.3","workspaces":["."]}',
    );
    await symlink("/etc/passwd", join(root, "pnpm-workspace.yaml"));
    await assert.rejects(planVersionFiles(root, "1.2.3", "1.3.0"), /Unsafe workspace input/u);
    await rm(join(root, "pnpm-workspace.yaml"));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    await symlink("/etc/passwd", join(root, "pnpm-lock.yaml"));
    await assert.rejects(planVersionFiles(root, "1.2.3", "1.3.0"), /Unsafe workspace input/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("npm v2 workspace dependency mirrors remain consistent with packages entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npm-mirrors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootPackage = { name: "root", version: "1.2.3", workspaces: ["pkgs/*"] };
  const core = {
    name: "core",
    version: "1.2.3",
    dependencies: { leaf: "^1.2.3", external: "1.2.3" },
  };
  const leaf = { name: "leaf", version: "1.2.3" };
  await writeFile(join(root, "package.json"), JSON.stringify(rootPackage));
  for (const pkg of [core, leaf]) {
    await mkdir(join(root, "pkgs", pkg.name), { recursive: true });
    await writeFile(join(root, "pkgs", pkg.name, "package.json"), JSON.stringify(pkg));
  }
  const lock = {
    name: "root",
    version: "1.2.3",
    lockfileVersion: 2,
    packages: {
      "": rootPackage,
      "pkgs/core": core,
      "pkgs/leaf": leaf,
      "node_modules/core": { resolved: "pkgs/core", link: true },
      "node_modules/leaf": { resolved: "pkgs/leaf", link: true },
    },
    dependencies: {
      core: { version: "file:pkgs/core", requires: { leaf: "^1.2.3", external: "1.2.3" } },
      leaf: { version: "file:pkgs/leaf" },
      external: { version: "1.2.3" },
    },
  };
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  const changes = await planVersionFiles(root, "1.2.3", "1.3.0");
  const text = changes.get("package-lock.json");
  assert.equal(typeof text, "string");
  const result: unknown = JSON.parse(String(text));
  assert.ok(typeof result === "object" && result !== null && "dependencies" in result);
  assert.deepEqual(result.dependencies, {
    core: { version: "file:pkgs/core", requires: { leaf: "^1.3.0", external: "1.2.3" } },
    leaf: { version: "file:pkgs/leaf" },
    external: { version: "1.2.3" },
  });
});
