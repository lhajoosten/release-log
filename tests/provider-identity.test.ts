import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReleaseInputConfiguration } from "../src/config/repository.ts";

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
