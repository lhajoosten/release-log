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
    /root package.json, pyproject.toml, or Cargo.toml/u,
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
    /supported proposal paths/u,
  );
  assert.equal(
    await readFile(join(outside, "pyproject.toml"), "utf8"),
    '[project]\nversion="1.2.3"\n',
  );
});

const uvManifest = '[project]\nname = "Example_Project"\nversion = "1.2.3"\n';
const uvHeader = 'version = 1\nrevision = 5\nrequires-python = ">=3.11"\n';
const uvRoot =
  '[[package]]\nname = "example-project"\nversion = \'1.2.3\' # root\nsource = { virtual = "." }\n';
const uvDependency =
  '[[package]]\nname = "other"\nversion = "1.2.3"\nsource = { registry = "https://pypi.org/simple" }\n';

for (const sourceKind of ["virtual", "editable"]) {
  void test(`uv.lock preserves dependency bytes for a ${sourceKind} root`, async (context) => {
    const path = await directory(context);
    const lock = (uvHeader + uvDependency + uvRoot.replace("virtual", sourceKind)).replaceAll(
      "\n",
      "\r\n",
    );
    await writeFile(join(path, "pyproject.toml"), uvManifest);
    await writeFile(join(path, "uv.lock"), lock);
    const prepared = await prepareReleaseFiles(
      path,
      fixture.serialized,
      fixtureConfiguration,
      version,
    );
    const expected = lock.replace("'1.2.3' # root", "'1.2.4' # root");
    assert.deepEqual(
      prepared.files.find((file) => file.path === "uv.lock"),
      {
        path: "uv.lock",
        before: lock,
        after: expected,
      },
    );
    assert.equal(await readFile(join(path, "uv.lock"), "utf8"), lock);
    assert.equal(await readFile(join(path, "pyproject.toml"), "utf8"), uvManifest);
    await writeReleaseFiles(path, prepared);
    assert.equal(await readFile(join(path, "uv.lock"), "utf8"), expected);
    assert.equal(
      await readFile(join(path, "pyproject.toml"), "utf8"),
      uvManifest.replace("1.2.3", "1.2.4"),
    );
  });
}

for (const { lock, manifest = uvManifest, expected } of [
  {
    lock: uvHeader + uvRoot.replace("1.2.3", "1.2.2"),
    expected: /disagrees.*Regenerate and commit/u,
  },
  { lock: uvHeader + uvDependency, expected: /exactly one matching root/u },
  { lock: uvHeader + uvRoot + uvRoot, expected: /exactly one matching root/u },
  {
    lock: uvHeader + uvRoot.replace('virtual = "."', 'directory = "."'),
    expected: /local or unsupported package source/u,
  },
  {
    lock:
      uvHeader +
      uvRoot +
      uvDependency.replace('registry = "https://pypi.org/simple"', 'editable = "components/other"'),
    expected: /local or unsupported package source/u,
  },
  {
    lock: uvHeader + uvRoot,
    manifest: uvManifest + '[tool.uv.workspace]\nmembers = ["components/*"]\n',
    expected: /without uv workspaces/u,
  },
  {
    lock: uvHeader + '[manifest]\nmembers = ["example-project"]\n' + uvRoot,
    expected: /workspace members are unsupported/u,
  },
  {
    lock: uvHeader + uvRoot,
    manifest: uvManifest + '[tool.uv.sources]\nother = [{ path = "other" }]\n',
    expected: /local path dependencies/u,
  },
  {
    lock: uvHeader + uvRoot,
    manifest: uvManifest + 'dependencies = ["other @ file:///tmp/other"]\n',
    expected: /local path dependencies/u,
  },
  {
    lock: (uvHeader + uvRoot).replace("version = 1", "version = 2"),
    expected: /Unsupported uv.lock format/u,
  },
  {
    lock: (uvHeader + uvRoot).replace("revision = 5", "revision = 99"),
    expected: /Unsupported uv.lock format/u,
  },
  { lock: uvHeader + "[[package]\n", expected: /valid TOML/u },
  {
    lock: uvHeader + uvRoot.replace("version = '1.2.3' # root\n", ""),
    expected: /malformed package entries/u,
  },
  { lock: uvHeader + uvRoot, manifest: null, expected: /requires a root pyproject.toml/u },
  {
    lock: uvHeader + uvRoot,
    manifest: '[tool.poetry]\nname = "Example_Project"\nversion = "1.2.3"\n',
    expected: /static \[project\] name and version/u,
  },
]) {
  void test(`uv.lock rejects ${expected} without writing files`, async (context) => {
    const path = await directory(context);
    const before = new Map([["uv.lock", lock]]);
    if (manifest !== null) before.set("pyproject.toml", manifest);
    for (const [name, value] of before) await writeFile(join(path, name), value);
    await assert.rejects(
      prepareReleaseFiles(path, fixture.serialized, fixtureConfiguration, version),
      expected,
    );
    assert.deepEqual((await readdir(path)).toSorted(), [...before.keys()].toSorted());
    for (const [name, value] of before)
      assert.equal(await readFile(join(path, name), "utf8"), value);
  });
}

const npmManifest = '{"name":"example","version":"1.2.3"}\n';
const npmLockV3 = String.raw`{
  "name": "example",
  "version": "1.2.3",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/other": { "version": "1.2.3", "resolved": "https://registry.example/other.tgz" },
    "": { "name": "example", "ver\u0073ion": "1.2.3" }
  }
}
`;

for (const [path, original, expected] of [
  [
    "npm-shrinkwrap.json",
    '{"version":"1.2.3","lockfileVersion":1,"dependencies":{"other":{"version":"1.2.3"}}}\n',
    '{"version":"1.2.4","lockfileVersion":1,"dependencies":{"other":{"version":"1.2.3"}}}\n',
  ],
  ...[2, 3].map((format) => {
    const lock = npmLockV3
      .replace('"lockfileVersion": 3', `"lockfileVersion": ${format}`)
      .replaceAll("\n", "\r\n");
    return [
      "package-lock.json",
      lock,
      lock
        .replace('"version": "1.2.3"', '"version": "1.2.4"')
        .replace(String.raw`"ver\u0073ion": "1.2.3"`, String.raw`"ver\u0073ion": "1.2.4"`),
    ] as const;
  }),
] as const) {
  void test(`npm release updates root version mirrors only for ${path}: ${original.match(/"lockfileVersion":\s*\d/u)?.[0]}`, async (context) => {
    const dir = await directory(context);
    await writeFile(join(dir, "package.json"), npmManifest);
    await writeFile(join(dir, path), original);
    const prepared = await prepareReleaseFiles(
      dir,
      fixture.serialized,
      fixtureConfiguration,
      version,
    );
    assert.deepEqual(
      prepared.files.find((file) => file.path === path),
      {
        path,
        before: original,
        after: expected,
      },
    );
    assert.equal(await readFile(join(dir, path), "utf8"), original);
    await writeReleaseFiles(dir, prepared);
    assert.equal(await readFile(join(dir, path), "utf8"), expected);
    assert.equal(
      await readFile(join(dir, "package.json"), "utf8"),
      npmManifest.replace("1.2.3", "1.2.4"),
    );
  });
}

for (const { lock, extraLock = false, manifest = npmManifest, expected } of [
  {
    lock: npmLockV3.replace('"version": "1.2.3"', '"version": "1.2.2"'),
    expected: /root version must match.*Regenerate/u,
  },
  {
    lock: npmLockV3.replace(String.raw`"ver\u0073ion": "1.2.3"`, '"version":"1.2.2"'),
    expected: /root version must match/u,
  },
  { lock: npmLockV3.replace('"": {', '"not-root": {'), expected: /root version must match/u },
  {
    lock: npmLockV3.replace('"lockfileVersion": 3', '"lockfileVersion": 99'),
    expected: /requires npm lockfile format/u,
  },
  { lock: npmLockV3.replace('"": {', '"": {}, "": {'), expected: /exactly one root package/u },
  {
    lock: npmLockV3.replace('"version": "1.2.3"', '"version": "1.2.3", "version": "1.2.3"'),
    expected: /exactly one version/u,
  },
  { lock: "not JSON", expected: /must be valid JSON/u },
  { lock: npmLockV3, extraLock: true, expected: /one authoritative npm lockfile/u },
  { lock: npmLockV3, manifest: null, expected: /requires a root package.json/u },
]) {
  void test(`npm release rejects ${expected} before writing files`, async (context) => {
    const dir = await directory(context);
    const before = new Map([["package-lock.json", lock]]);
    if (manifest !== null) before.set("package.json", manifest);
    if (extraLock) before.set("npm-shrinkwrap.json", lock);
    for (const [path, contents] of before) await writeFile(join(dir, path), contents);
    await assert.rejects(
      prepareReleaseFiles(dir, fixture.serialized, fixtureConfiguration, version),
      expected,
    );
    assert.deepEqual((await readdir(dir)).toSorted(), [...before.keys()].toSorted());
    for (const [path, contents] of before)
      assert.equal(await readFile(join(dir, path), "utf8"), contents);
  });
}
