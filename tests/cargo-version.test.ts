import assert from "node:assert/strict";
import { test } from "node:test";
import { updateCargoVersions } from "../src/release/cargo-version.ts";

const plan = { currentVersion: "1.2.3", nextVersion: "2.0.0" };
const root = `[workspace]
members = ["crates/cli", "crates/core"]

[workspace.package]
version = "1.2.3"
`;
const cli = `[package]
name = "upkeep-cli"
version.workspace = true

[target.'cfg(unix)'.build-dependencies.renamed]
package = "upkeep-core"
path = "../core"
version = '^1.2.3' # keep
`;
const core = `package = { name = "upkeep-core", version.workspace = true }
`;
const lock = `version = 4

[[package]]
name = "upkeep-cli"
version = "1.2.3"
dependencies = [
 "upkeep-core 1.2.3",
 "upkeep-core 1.2.3 (registry+https://github.com/rust-lang/crates.io-index)",
]

[[package]]
name = "upkeep-core"
version = "1.2.3"

[[package]]
name = "upkeep-core"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abcdef"
`;
const workspace = {
  "Cargo.toml": root,
  "crates/cli/Cargo.toml": cli,
  "crates/core/Cargo.toml": core,
  "Cargo.lock": lock,
} as const;

void test("Cargo edits aliased target path requirements and only local lockfile versions and references", () => {
  const cargo = updateCargoVersions(workspace, plan);
  assert.deepEqual(cargo?.files, [
    { path: "Cargo.toml", before: root, after: root.replace("1.2.3", "2.0.0") },
    { path: "crates/cli/Cargo.toml", before: cli, after: cli.replace("^1.2.3", "^2.0.0") },
    {
      path: "Cargo.lock",
      before: lock,
      after: lock
        .replace(/version = "1\.2\.3"(?=\ndependencies|\n\n)/gu, 'version = "2.0.0"')
        .replace('"upkeep-core 1.2.3"', '"upkeep-core 2.0.0"'),
    },
  ]);
});

void test("Cargo rejects independent versions, undiscovered workspace members, and stale lockfiles", () => {
  assert.throws(
    () =>
      updateCargoVersions(
        {
          ...workspace,
          "crates/core/Cargo.toml": core.replace("version.workspace = true", 'version = "1.2.3"'),
        },
        plan,
      ),
    /must inherit the shared workspace version/u,
  );
  assert.throws(
    () =>
      updateCargoVersions(
        { ...workspace, "Cargo.toml": root.replace("crates/core", "crates/*") },
        plan,
      ),
    /explicit repository-relative workspace member directories/u,
  );
  assert.throws(
    () =>
      updateCargoVersions(
        { ...workspace, "Cargo.lock": lock.replace('version = "1.2.3"', 'version = "1.2.2"') },
        plan,
      ),
    /needs one local upkeep-cli entry at 1.2.3/u,
  );
});
