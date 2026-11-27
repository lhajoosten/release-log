import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planPythonWorkspace } from "../src/release/python-workspace.ts";
import { updateUvRequirements, uvSources } from "../src/release/python-requirements.ts";

void test("uv member sources inherit root declarations and shadow normalized names", () => {
  const root = "[tool.uv.sources]\nBeta_Pkg = { workspace = true }\ngamma = { workspace = true }\n";
  const member =
    '[project]\ndependencies = ["beta.pkg>=1.2.3", "gamma>=1.2.3", "delta>=1.2.3"]\n[tool.uv.sources]\nGAMMA = { index = "external" }\n';
  assert.equal(
    updateUvRequirements(
      member,
      new Set(["beta-pkg", "gamma", "delta"]),
      "1.2.3",
      "1.3.0",
      uvSources(root),
    ),
    member.replace("beta.pkg>=1.2.3", "beta.pkg>=1.3.0"),
  );
});

void test("uv handles source arrays and rejects ambiguous versioned requirements", () => {
  const names = new Set(["beta"]);
  const member = '[project]\ndependencies = ["beta>=1.2.3"]\n';
  const allLocal = uvSources("[tool.uv.sources]\nbeta = [{ workspace = true }]\n");
  assert.equal(
    updateUvRequirements(member, names, "1.2.3", "1.3.0", allLocal),
    member.replace("1.2.3", "1.3.0"),
  );
  const mixed = uvSources(
    '[tool.uv.sources]\nbeta = [{ workspace = true }, { index = "external" }]\n',
  );
  assert.throws(
    () => updateUvRequirements(member, names, "1.2.3", "1.3.0", mixed),
    /Ambiguous uv workspace sources/u,
  );
  const externalOverride = `${member}[tool.uv.sources]\nBETA = [{ index = "external" }]\n`;
  assert.equal(
    updateUvRequirements(externalOverride, names, "1.2.3", "1.3.0", mixed),
    externalOverride,
  );
  const unversioned = member.replace(">=1.2.3", "");
  assert.equal(updateUvRequirements(unversioned, names, "1.2.3", "1.3.0", mixed), unversioned);
  for (const qualifier of [
    'marker = "sys_platform == \\\"linux\\\""',
    'extra = "test"',
    'group = "dev"',
  ]) {
    const conditional = uvSources(`[tool.uv.sources]\nbeta = { workspace = true, ${qualifier} }\n`);
    assert.throws(
      () => updateUvRequirements(member, names, "1.2.3", "1.3.0", conditional),
      /Ambiguous uv workspace sources/u,
    );
  }
});

void test("uv shared workspace updates each member and the matching lock entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "python-workspace-"));
  try {
    await mkdir(join(root, "packages/alpha"), { recursive: true });
    await mkdir(join(root, "packages/beta"), { recursive: true });
    const rootManifest =
      '[tool.uv.workspace]\nmembers = ["packages/*"]\n[dependency-groups]\ndev = ["beta>=1.2.3", "other==1.2.3"] # retain 1.2.3\n[tool.uv.sources]\nbeta = { workspace = true }\n';
    await writeFile(join(root, "pyproject.toml"), rootManifest);
    await writeFile(
      join(root, "packages/alpha/pyproject.toml"),
      '[project]\nname = "alpha"\nversion = "1.2.3"\n',
    );
    await writeFile(
      join(root, "packages/beta/pyproject.toml"),
      '[project]\nname = "beta"\nversion = "1.2.3"\n',
    );
    const lock =
      'version = 1\n\n[[package]]\nname = "alpha"\nversion = "1.2.3"\nsource = { editable = "packages/alpha" }\n\n[[package]]\nname = "beta"\nversion = "1.2.3"\nsource = { editable = "packages/beta" }\n';
    await writeFile(join(root, "uv.lock"), lock);
    const files = await planPythonWorkspace(root, "1.2.3", "1.3.0");
    assert.equal(files?.size, 4);
    assert.equal(
      files?.get("pyproject.toml"),
      rootManifest.replace('"beta>=1.2.3"', '"beta>=1.3.0"'),
    );
    assert.match(files?.get("packages/alpha/pyproject.toml") ?? "", /version = "1.3.0"/u);
    assert.equal(files?.get("uv.lock"), lock.replaceAll('version = "1.2.3"', 'version = "1.3.0"'));
    assert.equal(await readFile(join(root, "uv.lock"), "utf8"), lock);
    await assert.rejects(
      planPythonWorkspace(root, "1.2.4", "1.3.0"),
      /match the captured current version/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("uv updates only sourced workspace requirements and preserves unrelated same versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "uv-local-deps-"));
  try {
    await mkdir(join(root, "packages/alpha"), { recursive: true });
    await mkdir(join(root, "packages/beta"), { recursive: true });
    await writeFile(
      join(root, "pyproject.toml"),
      '[tool.uv.workspace]\nmembers = ["packages/*"]\n[tool.uv.sources]\nBETA = { workspace = true }\n',
    );
    const alpha =
      '[project]\nname = "alpha"\nversion = "1.2.3" # keep 1.2.3 note\ndependencies = ["beta>=1.2.3", "other==1.2.3"]\n';
    await writeFile(join(root, "packages/alpha/pyproject.toml"), alpha);
    await writeFile(
      join(root, "packages/beta/pyproject.toml"),
      '[project]\nname = "beta"\nversion = "1.2.3"\n',
    );
    const lock =
      'version = 1\n\n[[package]]\nname = "alpha"\nversion = "1.2.3"\nsource = { editable = "packages/alpha" }\n[package.metadata]\nrequires-dist = [{ name = "beta", editable = "packages/beta", specifier = ">=1.2.3" }, { name = "other", specifier = "==1.2.3" }]\n\n[[package]]\nname = "beta"\nversion = "1.2.3"\nsource = { editable = "packages/beta" }\n\n[[package]]\nname = "beta"\nversion = "1.2.3"\nsource = { registry = "https://example.invalid" }\n';
    await writeFile(join(root, "uv.lock"), lock);
    const files = await planPythonWorkspace(root, "1.2.3", "1.3.0");
    assert.match(
      files?.get("packages/alpha/pyproject.toml") ?? "",
      /version = "1.3.0" # keep 1.2.3 note/u,
    );
    assert.match(
      files?.get("packages/alpha/pyproject.toml") ?? "",
      /"beta>=1.3.0", "other==1.2.3"/u,
    );
    assert.match(
      files?.get("uv.lock") ?? "",
      /editable = "packages\/beta", specifier = ">=1.3.0"/u,
    );
    assert.match(files?.get("uv.lock") ?? "", /name = "other", specifier = "==1.2.3"/u);
    assert.match(
      files?.get("uv.lock") ?? "",
      /name = "beta"\nversion = "1.2.3"\nsource = \{ registry/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
