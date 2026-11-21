import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import type { TestEvent } from "node:test/reporters";

export default async function* reportFiles(events: AsyncIterable<TestEvent>) {
  const tests = new Map<string, number>();
  for await (const { type, data } of events) {
    if (type === "test:pass" && data.details.type === "test" && "entryFile" in data) {
      assert.equal(typeof data.entryFile, "string");
      if (typeof data.entryFile !== "string") throw new Error("Test did not report its entry file");
      const file = relative(process.cwd(), data.entryFile);
      tests.set(file, (tests.get(file) ?? 0) + 1);
    }

    if (
      type === "test:complete" &&
      data.nesting === 0 &&
      data.file &&
      resolve(data.name) === data.file
    ) {
      yield `time\t${relative(process.cwd(), data.file)}\t${Math.ceil(data.details.duration_ms)}\n`;
    }

    if (type === "test:summary" && !data.file && data.success) {
      assert.equal(data.counts.skipped + data.counts.todo, 0, "Tests were skipped or marked TODO");
      assert.equal(
        [...tests.values()].reduce((total, count) => total + count, 0),
        data.counts.tests,
        "File test counts differ from the Node runner total",
      );
      for (const [file, count] of tests) yield `tests\t${file}\t${count}\n`;
    }
  }
}
