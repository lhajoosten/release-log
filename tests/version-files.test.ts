import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createReleasePlan } from "../src/release-plan.ts";
import { prepareReleaseFiles, writeReleaseFiles } from "../src/proposal-files.ts";
import {
  updatePackageVersion,
  updatePyprojectVersion,
  VersionFilesError,
} from "../src/version-files.ts";
import { fixtureConfiguration, releaseFixture } from "./release-fixture.ts";

const version = { kind: "released", currentVersion: "1.2.3" } as const;
async function directory(context: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "release-version-files-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const fixture = await releaseFixture([{ title: "fix(api): retain keys" }]);
const plan = await createReleasePlan(fixture.serialized, fixtureConfiguration, version);

for (const source of [
  '{\r\n  "name": "example", "version" : "1.2.3",\r\n  "nested": { "version": "9.8.7" }\r\n}\r\n',
  '{"note":"version", "ver\\u0073ion":"1.2.3", "scripts":{"build":"do not execute"}}',
]) {
  void test("package.json changes only the root version token", () => {
    const result = updatePackageVersion(source, plan);
    assert.equal(result.version, "1.2.3");
    assert.equal(result.content, source.replace('"1.2.3"', '"1.2.4"'));
  });
}

for (const source of [
  '# keep\r\n[project]\r\nname="example"\r\nversion = "1.2.3" # comment\r\n[tool.other]\r\nversion="9.8.7"\r\n',
  "[tool.poetry]\nname = 'example'\nversion = '1.2.3' # retain quote style\n",
  'project.version = "1.2.3"\nproject.name="example"\n',
  '"project"."version" = "1.2.3"\n',
  'project = { name = "example", version = "1.2.3" }\n',
  'tool = { poetry = { version = "1.2.3" } }\n',
  '[project]\nversion = """1.2.3"""\n',
  "[project]\nversion = '''1.2.3'''\n",
  '[project]\nversion="1.2.3"\n[tool.poetry]\nversion="1.2.3"\n[build-system]\nbuild-backend="never.execute.this"\n',
]) {
  void test(`pyproject.toml preserves unrelated bytes for ${JSON.stringify(source)}`, () => {
    const result = updatePyprojectVersion(source, plan);
    assert.equal(result.version, "1.2.3");
    assert.equal(result.content, source.replaceAll("1.2.3", "1.2.4"));
  });
}

void test("invalid, duplicate, missing, nonstring, mismatched, and dynamic versions are rejected", () => {
  for (const source of [
    "{invalid",
    "{}",
    '{"version":123}',
    '{"version":"1.2.3","version":"1.2.3"}',
    '{"version":"2.0.0"}',
  ])
    assert.throws(() => updatePackageVersion(source, plan), VersionFilesError);
  for (const source of [
    '[project\nversion="1.2.3"',
    '[project]\nname="example"\n',
    "[project]\nversion=123\n",
    '[project]\nversion="2.0.0"\n',
    '[project]\nversion="1.2.3"\nversion="1.2.3"\n',
    '[project]\ndynamic=["version"]\n',
    '[project]\ndynamic=["version"]\n[tool.poetry]\nversion="1.2.3"\n',
    '[[project]]\nversion="1.2.3"\n',
    '[tool.other]\nversion="1.2.3"\n',
  ])
    assert.throws(() => updatePyprojectVersion(source, plan), VersionFilesError);
});

for (const mode of ["node", "python", "both"] as const) {
  void test(`preparation and opt-in writes support ${mode} repositories without requiring the other manifest`, async (context) => {
    const path = await directory(context);
    const packageJSON = '{ "version" : "1.2.3", "nested": {"version":"unchanged"} }\n';
    const pyproject = '# keep\n[project]\nversion = "1.2.3" # keep\n';
    if (mode !== "python") await writeFile(join(path, "package.json"), packageJSON);
    if (mode !== "node") await writeFile(join(path, "pyproject.toml"), pyproject);
    const before = await readdir(path);
    const prepared = await prepareReleaseFiles(
      path,
      fixture.serialized,
      fixtureConfiguration,
      version,
    );
    assert.deepEqual(await readdir(path), before);
    if (mode !== "python")
      assert.equal(await readFile(join(path, "package.json"), "utf8"), packageJSON);
    if (mode !== "node")
      assert.equal(await readFile(join(path, "pyproject.toml"), "utf8"), pyproject);
    assert.deepEqual(
      prepared.files.map((file) => file.path),
      [
        ...(mode !== "python" ? ["package.json"] : []),
        ...(mode !== "node" ? ["pyproject.toml"] : []),
        "CHANGELOG.md",
        ".release-log/inputs.json",
      ],
    );
    await writeReleaseFiles(path, prepared);
    if (mode !== "python")
      assert.equal(
        await readFile(join(path, "package.json"), "utf8"),
        packageJSON.replace('"1.2.3"', '"1.2.4"'),
      );
    if (mode !== "node")
      assert.equal(
        await readFile(join(path, "pyproject.toml"), "utf8"),
        pyproject.replace('"1.2.3"', '"1.2.4"'),
      );
    assert.equal(
      await readFile(join(path, ".release-log/inputs.json"), "utf8"),
      fixture.serialized,
    );
    await assert.rejects(writeReleaseFiles(path, prepared), /changed after preparation/u);
  });
}

void test("missing/dynamic/mismatched manifests and stale preparations fail before any writes", async (context) => {
  const path = await directory(context);
  await assert.rejects(
    prepareReleaseFiles(path, fixture.serialized, fixtureConfiguration, version),
    /root package.json or pyproject.toml/u,
  );
  await writeFile(join(path, "package.json"), '{"version":"1.2.3"}');
  await writeFile(join(path, "pyproject.toml"), '[project]\nversion="2.0.0"\n');
  await assert.rejects(
    prepareReleaseFiles(path, fixture.serialized, fixtureConfiguration, version),
    /must match/u,
  );
  assert.equal(await readFile(join(path, "package.json"), "utf8"), '{"version":"1.2.3"}');
  await writeFile(join(path, "pyproject.toml"), '[project]\nversion="1.2.3"\n');
  const prepared = await prepareReleaseFiles(
    path,
    fixture.serialized,
    fixtureConfiguration,
    version,
  );
  await writeFile(join(path, "pyproject.toml"), '# human edit\n[project]\nversion="1.2.3"\n');
  await assert.rejects(writeReleaseFiles(path, prepared), /changed after preparation/u);
  assert.equal(await readFile(join(path, "package.json"), "utf8"), '{"version":"1.2.3"}');
});

void test("bootstrap requires matching Node/Python and matching Python mirror values", async (context) => {
  const path = await directory(context);
  const bootstrap = await releaseFixture([{ title: "feat(api): export rows" }], null);
  const config = { kind: "bootstrap", initialVersion: "0.1.0" } as const;
  await writeFile(join(path, "package.json"), '{"version":"0.0.0"}');
  await writeFile(join(path, "pyproject.toml"), '[project]\nversion="0.1.0"\n');
  await assert.rejects(
    prepareReleaseFiles(path, bootstrap.serialized, fixtureConfiguration, config),
    /versions disagree/u,
  );
  await writeFile(
    join(path, "pyproject.toml"),
    '[project]\nversion="0.0.0"\n[tool.poetry]\nversion="0.1.0"\n',
  );
  await assert.rejects(
    prepareReleaseFiles(path, bootstrap.serialized, fixtureConfiguration, config),
    /fields disagree/u,
  );
  await writeFile(join(path, "pyproject.toml"), '[project]\nversion="0.0.0"\n');
  const prepared = await prepareReleaseFiles(
    path,
    bootstrap.serialized,
    fixtureConfiguration,
    config,
  );
  assert.equal(prepared.plan.nextVersion, "0.1.0");
  assert.ok(
    prepared.files
      .find((file) => file.path === "pyproject.toml")
      ?.after.includes('version="0.1.0"'),
  );
});

void test("unimplemented root-version lockfile mirrors block preparation without writes", async (context) => {
  for (const lock of ["package-lock.json", "npm-shrinkwrap.json", "uv.lock"]) {
    const path = await directory(context);
    await writeFile(join(path, "pyproject.toml"), '[project]\nversion="1.2.3"\n');
    await writeFile(join(path, lock), "unmanaged lockfile\n");
    await assert.rejects(
      prepareReleaseFiles(path, fixture.serialized, fixtureConfiguration, version),
      /root-version mirror adapter/u,
    );
    assert.equal(
      await readFile(join(path, "pyproject.toml"), "utf8"),
      '[project]\nversion="1.2.3"\n',
    );
    assert.deepEqual((await readdir(path)).toSorted(), [lock, "pyproject.toml"].toSorted());
  }
});

void test("no-release plans preserve manifests and produce no files", async (context) => {
  const path = await directory(context);
  const noRelease = await releaseFixture([{ title: "docs(api): explain keys" }]);
  const pyproject = '[project]\nversion="1.2.3"\n';
  await writeFile(join(path, "pyproject.toml"), pyproject);
  const prepared = await prepareReleaseFiles(
    path,
    noRelease.serialized,
    fixtureConfiguration,
    version,
  );
  assert.deepEqual(prepared.files, []);
  await writeReleaseFiles(path, prepared);
  assert.equal(await readFile(join(path, "pyproject.toml"), "utf8"), pyproject);
  assert.equal(updatePyprojectVersion(pyproject, prepared.plan).content, pyproject);
  assert.equal(
    updatePackageVersion('{"version":"1.2.3"}', prepared.plan).content,
    '{"version":"1.2.3"}',
  );
});

void test("symlinked manifests and out-of-allowlist writes are rejected", async (context) => {
  const path = await directory(context);
  const outside = await directory(context);
  await writeFile(join(outside, "pyproject.toml"), '[project]\nversion="1.2.3"\n');
  await symlink(join(outside, "pyproject.toml"), join(path, "pyproject.toml"));
  await assert.rejects(
    prepareReleaseFiles(path, fixture.serialized, fixtureConfiguration, version),
    /symlinks/u,
  );
  await assert.rejects(
    Reflect.apply(writeReleaseFiles, undefined, [
      path,
      { plan, files: [{ path: "../outside", before: null, after: "bad" }] },
    ]),
    /fixed proposal output paths/u,
  );
  assert.equal(
    await readFile(join(outside, "pyproject.toml"), "utf8"),
    '[project]\nversion="1.2.3"\n',
  );
});
