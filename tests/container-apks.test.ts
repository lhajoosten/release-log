import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readApkLock, stageContainerApks } from "../scripts/container-apks.ts";

const repository = "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/";
const bytes = Buffer.from("synthetic APK transport fixture; actual signatures are checked by apk");
const pin = {
  file: "fixture-1.0-r0.apk",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const lock = { schemaVersion: 1, repository, packages: [pin] };

void test("APK lock rejects unapproved repositories, traversal, malformed hashes and duplicate/oversized closures", () => {
  assert.deepEqual(readApkLock(lock), [pin]);
  for (const value of [
    null,
    {},
    { ...lock, schemaVersion: 2 },
    { ...lock, repository: "https://attacker.invalid/" },
    { ...lock, packages: [] },
    { ...lock, packages: [null] },
    { ...lock, packages: [pin, pin] },
    {
      ...lock,
      packages: Array.from({ length: 65 }, (_, i) => ({ ...pin, file: `pkg${i}-1.apk` })),
    },
  ])
    assert.throws(() => readApkLock(value));
  for (const file of [
    "../fixture-1.apk",
    "/fixture-1.apk",
    "folder/fixture-1.apk",
    "--option.apk",
    "fixture.apk",
    "fixture-1.apk?query",
    "fixture-1.apk\n",
  ])
    assert.throws(() => readApkLock({ ...lock, packages: [{ ...pin, file }] }));
  for (const sha256 of ["", "invalid", "A".repeat(64), "a".repeat(63)])
    assert.throws(() => readApkLock({ ...lock, packages: [{ ...pin, sha256 }] }));
});

void test("APK staging uses fixed repository bytes and refuses HTTP/hash failures without accepting a package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-apk-staging-"));
  try {
    const calls: string[] = [];
    const request = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      calls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return new Response(bytes);
    });
    const target = join(directory, "valid");
    await stageContainerApks(target, readApkLock(lock));
    assert.deepEqual(calls, [repository + pin.file]);
    assert.deepEqual(await readFile(join(target, pin.file)), bytes);
    request.mock.mockImplementation(async () => new Response("modified package"));
    const tampered = join(directory, "tampered");
    await assert.rejects(stageContainerApks(tampered, [pin]), /checksum mismatch/u);
    assert.deepEqual(await readdir(tampered), []);
    request.mock.mockImplementation(async () => new Response("missing", { status: 404 }));
    const missing = join(directory, "missing");
    await assert.rejects(stageContainerApks(missing, [pin]), /HTTP 404/u);
    assert.deepEqual(await readdir(missing), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
