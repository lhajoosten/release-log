import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseEventNumber } from "../src/controller/event.ts";

void test("manual retry requires a safe PR number and dispatch from main", (t) => {
  for (const key of ["ROLLING_RELEASE_RETRY_PR", "GITHUB_EVENT_NAME", "GITHUB_REF"]) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  process.env.ROLLING_RELEASE_RETRY_PR = "123";
  process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  process.env.GITHUB_REF = "refs/heads/main";
  assert.equal(releaseEventNumber({}), 123);
  for (const invalid of ["0", "-1", "1.0", "1;echo", "9007199254740992"]) {
    process.env.ROLLING_RELEASE_RETRY_PR = invalid;
    assert.throws(() => releaseEventNumber({}));
  }
  process.env.ROLLING_RELEASE_RETRY_PR = "123";
  process.env.GITHUB_REF = "refs/heads/other";
  assert.throws(() => releaseEventNumber({}), /manual dispatch from main/u);
  process.env.GITHUB_REF = "refs/heads/main";
  process.env.GITHUB_EVENT_NAME = "pull_request_target";
  assert.throws(() => releaseEventNumber({}), /manual dispatch from main/u);
  process.env.ROLLING_RELEASE_RETRY_PR = "";
  assert.equal(releaseEventNumber({ action: "closed", pull_request: { number: 8 } }), 8);
  assert.throws(() => releaseEventNumber({ action: "opened", pull_request: { number: 8 } }));
});
