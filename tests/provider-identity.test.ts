import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseReleaseInputConfiguration,
  resolveProviderConfiguration,
} from "../src/config/repository.ts";
import { capturedVerificationConfiguration } from "../src/proposal/verification.ts";
import { readToolPin, updateToolPins } from "../src/proposal/tool-pins.ts";

const providerConfiguration = {
  schemaVersion: 2,
  repository: "lhajoosten/rolling-release",
  repositoryId: 1449550207,
  releaseBranch: "main",
  releasePolicy: "release-policy-v1",
  contextPolicy: "required",
  selfUpgrade: true,
  githubRelease: true,
  internalPublication: true,
  changelog: { verbosity: "concise", format: "compact" },
  bootstrap: { baselineSha: "a".repeat(40), onboardingSha: "b".repeat(40) },
};

void test("provider self-release configuration accepts the prepared repository slug", () => {
  assert.deepEqual(parseReleaseInputConfiguration(providerConfiguration), providerConfiguration);
  assert.equal(
    parseReleaseInputConfiguration({
      ...providerConfiguration,
      repository: "lhajoosten/release-log",
    }).repository,
    "lhajoosten/release-log",
  );
});

void test("provider self-release configuration keeps the stable repository ID binding", () => {
  assert.throws(
    () =>
      parseReleaseInputConfiguration({
        ...providerConfiguration,
        repositoryId: 1,
      }),
    /Self-upgrades require explicit trusted release-log repository identity/u,
  );
  assert.throws(
    () =>
      parseReleaseInputConfiguration({
        ...providerConfiguration,
        repository: "lhajoosten/another-project",
      }),
    /Self-upgrades require explicit trusted release-log repository identity/u,
  );
});

void test("runtime authority uses the canonical slug while historical replay keeps its captured identity", () => {
  const captured = parseReleaseInputConfiguration({
    ...providerConfiguration,
    repository: "lhajoosten/release-log",
  });
  const current = resolveProviderConfiguration(
    captured,
    providerConfiguration.repository,
    providerConfiguration.repositoryId,
  );
  assert.equal(current.repository, providerConfiguration.repository);
  assert.deepEqual(
    capturedVerificationConfiguration(JSON.stringify({ configuration: captured }), current),
    captured,
  );
  assert.deepEqual(
    capturedVerificationConfiguration(
      JSON.stringify({
        configuration: {
          ...captured,
          bootstrap: { ...providerConfiguration.bootstrap, baselineSha: "c".repeat(40) },
        },
      }),
      current,
    ),
    current,
  );
  assert.throws(() => resolveProviderConfiguration(captured, current.repository, 1));
});

void test("caller pin updates preserve the reviewed provider slug", () => {
  const previous = "a".repeat(40);
  const next = "b".repeat(40);
  for (const repository of ["lhajoosten/release-log", "lhajoosten/rolling-release"]) {
    const caller = `jobs:\n  release:\n    uses: ${repository}/.github/workflows/rolling-release.yml@${previous}\n    with:\n      tool-sha: ${previous}\n`;
    const updated = updateToolPins(caller, next);
    assert.equal(readToolPin(updated), next);
    assert.equal(updated, caller.replaceAll(previous, next));
  }
});
