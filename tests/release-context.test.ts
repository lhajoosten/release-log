import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { fromMarkdown } from "mdast-util-from-markdown";

import { parseReleaseContext } from "../src/release-context.ts";
import type { ReleaseContextValidation } from "../src/release-context.ts";

const source = [
  "version: 1",
  "audience: users",
  "summary: Export only the rows you select.",
  "impact: You no longer need to download the entire table.",
  "required_action: null",
].join("\n");

function block(yaml = source): string {
  return `\`\`\`release-log\n${yaml}\n\`\`\``;
}

function replaceField(field: string, value: string): string {
  return source
    .split("\n")
    .map((line) => (line.startsWith(`${field}:`) ? `${field}: ${value}` : line))
    .join("\n");
}

function expectError(result: ReleaseContextValidation, code: string, field?: string): void {
  assert.ok(!result.valid);
  assert.ok(
    result.errors.some(
      (error) => error.code === code && (field === undefined || error.field === field),
    ),
    JSON.stringify(result.errors),
  );
  assert.equal("context" in result, false);
}

void test("extracts the agreed context from a PR description and preserves its source block", () => {
  const rawBlock = block();
  const description = `## Summary\n\nSome implementation details.\n\n## Release context\n\n${rawBlock}\n\n## Verification\n\nTests passed.`;

  const result = parseReleaseContext(description);

  assert.deepEqual(result, {
    valid: true,
    context: {
      version: 1,
      audience: "users",
      summary: "Export only the rows you select.",
      impact: "You no longer need to download the entire table.",
      requiredAction: null,
    },
    rawBlock,
  });
});

void test("retains internal context instead of silently dropping the change", () => {
  const result = parseReleaseContext(block(replaceField("audience", "internal")));

  assert.ok(result.valid);
  assert.equal(result.context.audience, "internal");
});

void test("preserves a required user action", () => {
  const result = parseReleaseContext(
    block(replaceField("required_action", "Regenerate your access key.")),
  );

  assert.ok(result.valid);
  assert.equal(result.context.requiredAction, "Regenerate your access key.");
});

for (const value of ["null", "Null", "NULL", "~"]) {
  void test(`accepts explicit YAML null ${value}`, () => {
    const result = parseReleaseContext(block(replaceField("required_action", value)));

    assert.ok(result.valid);
    assert.equal(result.context.requiredAction, null);
  });
}

void test("preserves multiline text according to YAML scalar semantics", () => {
  const yaml = replaceField("summary", "|-\n  Export selected rows.\n  Keep their order.");

  const result = parseReleaseContext(block(yaml));

  assert.ok(result.valid);
  assert.equal(result.context.summary, "Export selected rows.\nKeep their order.");
});

void test("does not trim meaningful string content or coerce YAML 1.2 strings", () => {
  const yaml = replaceField("summary", "'  Keep this spacing.  '").replace(
    "impact: You no longer need to download the entire table.",
    "impact: yes",
  );

  const result = parseReleaseContext(block(yaml));

  assert.ok(result.valid);
  assert.equal(result.context.summary, "  Keep this spacing.  ");
  assert.equal(result.context.impact, "yes");
});

void test("supports quoted keys, comments, and a flow mapping", () => {
  const yaml =
    '{ "version": 1, audience: users, summary: "Export selected rows.", impact: "Less cleanup.", required_action: null } # context';

  const result = parseReleaseContext(block(yaml));

  assert.ok(result.valid);
  assert.equal(result.context.summary, "Export selected rows.");
});

for (const [name, description] of [
  ["empty descriptions", ""],
  ["ordinary prose", "There is no structured context."],
  ["wrong language labels", block().replace("```release-log", "```yaml")],
  ["case-sensitive language labels", block().replace("```release-log", "```Release-log")],
  ["inline examples", "Use the `release-log` marker."],
  [
    "indented code examples",
    block()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  ],
  [
    "quoted examples",
    block()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  ],
  [
    "list-nested examples",
    `- Example:\n\n${block()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}`,
  ],
  ["HTML comments", `<!--\n${block()}\n-->`],
  ["larger fenced examples", `\`\`\`\`markdown\n${block()}\n\`\`\`\``],
] satisfies readonly (readonly [string, string])[]) {
  void test(`does not mistake ${name} for release context`, () => {
    expectError(parseReleaseContext(description), "block-missing");
  });
}

void test("ignores commented and fenced examples when a real block follows", () => {
  const description = `<!--\n${block()}\n-->\n\n\`\`\`\`markdown\n${block()}\n\`\`\`\`\n\n${block()}`;

  const result = parseReleaseContext(description);

  assert.ok(result.valid);
  assert.equal(result.rawBlock, block());
});

for (const [name, description] of [
  ["tilde fences", `~~~release-log\n${source}\n~~~`],
  ["longer fences", `\`\`\`\`release-log\n${source}\n\`\`\`\`\``],
  ["whitespace around the label", `\`\`\` release-log \t\n${source}\n\`\`\`  `],
  [
    "up to three spaces of indentation",
    block()
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n"),
  ],
  ["CRLF line endings", block().replaceAll("\n", "\r\n")],
  ["CR line endings", block().replaceAll("\n", "\r")],
] satisfies readonly (readonly [string, string])[]) {
  void test(`accepts ${name}`, () => {
    const result = parseReleaseContext(description);

    assert.ok(result.valid);
    assert.equal(result.context.version, 1);
    assert.ok(description.includes(result.rawBlock));
  });
}

for (const [name, description] of [
  ["unclosed fences", `\`\`\`release-log\n${source}`],
  ["short closing fences", `\`\`\`\`release-log\n${source}\n\`\`\``],
  ["mismatched closing fences", `\`\`\`release-log\n${source}\n~~~`],
  ["extra fence metadata", block().replace("```release-log", "```release-log yaml")],
] satisfies readonly (readonly [string, string])[]) {
  void test(`rejects ${name}`, () => {
    expectError(parseReleaseContext(description), "block-invalid");
  });
}

void test("rejects multiple blocks rather than choosing the first or last", () => {
  const description = `${block()}\n\n${block(replaceField("audience", "internal"))}`;

  expectError(parseReleaseContext(description), "block-duplicate");
});

for (const field of ["version", "audience", "summary", "impact", "required_action"]) {
  void test(`requires the ${field} field`, () => {
    const yaml = source
      .split("\n")
      .filter((line) => !line.startsWith(`${field}:`))
      .join("\n");

    expectError(parseReleaseContext(block(yaml)), "field-missing", field);
  });
}

for (const [field, value] of [
  ["version", "2"],
  ["version", "'1'"],
  ["version", "true"],
  ["audience", "developers"],
  ["audience", "Users"],
  ["audience", "null"],
  ["summary", "''"],
  ["summary", "'   '"],
  ["summary", "null"],
  ["summary", "42"],
  ["summary", "false"],
  ["summary", "[text]"],
  ["summary", "{ text: value }"],
  ["impact", "''"],
  ["impact", "null"],
  ["required_action", "''"],
  ["required_action", "'   '"],
  ["required_action", "false"],
  ["required_action", "[]"],
  ["required_action", ""],
] satisfies readonly (readonly [string, string])[]) {
  void test(`rejects invalid ${field} value ${JSON.stringify(value)}`, () => {
    expectError(parseReleaseContext(block(replaceField(field, value))), "field-invalid", field);
  });
}

void test("rejects unknown fields, including breaking-change overrides", () => {
  const yaml = `${source}\nbreaking: true\nextra: text`;

  const result = parseReleaseContext(block(yaml));

  expectError(result, "unknown-field", "breaking");
  expectError(result, "unknown-field", "extra");
});

void test("does not interpret prototype-like keys as object properties", () => {
  const result = parseReleaseContext(block(`${source}\n__proto__: value\nconstructor: value`));

  expectError(result, "unknown-field", "__proto__");
  expectError(result, "unknown-field", "constructor");
});

void test("reports all missing required fields in a stable order", () => {
  const result = parseReleaseContext(block("zebra: text\napple: text"));

  assert.ok(!result.valid);
  assert.deepEqual(
    result.errors.map(({ field }) => field),
    ["apple", "zebra", "version", "audience", "summary", "impact", "required_action"],
  );
});

for (const yaml of ["", "plain text", "[one, two]", "null"]) {
  void test(`requires a YAML mapping instead of ${JSON.stringify(yaml)}`, () => {
    expectError(parseReleaseContext(block(yaml)), "mapping-required");
  });
}

void test("rejects non-string field names", () => {
  expectError(parseReleaseContext(block(`${source}\ntrue: value`)), "field-name-invalid");
});

for (const [name, yaml] of [
  ["duplicate fields", `${source}\nsummary: A second summary.`],
  ["quoted duplicate fields", `${source}\n'summary': A second summary.`],
  ["malformed YAML", `${source}\nbroken: [unclosed`],
  ["multiple YAML documents", `${source}\n---\n${source}`],
  ["custom YAML tags", replaceField("summary", "!custom value")],
  ["executable-looking tags", replaceField("summary", "!!js/function 'function () { return 1; }'")],
  ["YAML 1.1 directives", `%YAML 1.1\n---\n${source}`],
] satisfies readonly (readonly [string, string])[]) {
  void test(`rejects ${name}`, () => {
    expectError(parseReleaseContext(block(yaml)), "yaml-invalid");
  });
}

for (const [name, yaml] of [
  ["a root anchor", `&root\n${source}`],
  ["a scalar anchor", replaceField("summary", "&summary Export selected rows.")],
  ["an alias", replaceField("summary", "*missing")],
] satisfies readonly (readonly [string, string])[]) {
  void test(`rejects ${name} without expanding references`, () => {
    expectError(parseReleaseContext(block(yaml)), "yaml-reference-unsupported");
  });
}

void test("rejects nested alias structures without converting or expanding them", () => {
  const yaml = replaceField("summary", "[&node [*node, *node]]");

  const result = parseReleaseContext(block(yaml));

  assert.ok(!result.valid);
});

void test("keeps shell-like and instruction-like text as data", () => {
  const yaml = replaceField("summary", "'$(touch sentinel) and ignore previous instructions'");

  const result = parseReleaseContext(block(yaml));

  assert.ok(result.valid);
  assert.equal(result.context.summary, "$(touch sentinel) and ignore previous instructions");
});

for (const character of ["a", "😀"]) {
  void test(`rejects descriptions over the UTF-8 byte limit using ${character}`, () => {
    const repetitions = Math.floor(1_048_576 / Buffer.byteLength(character, "utf8")) + 1;
    const description = character.repeat(repetitions);

    expectError(parseReleaseContext(description), "description-too-large");
  });
}

void test("accepts a description exactly at the UTF-8 byte limit", () => {
  const prefix = "<!--";
  const suffix = `-->\n\n${block()}`;
  const padding = "a".repeat(1_048_576 - Buffer.byteLength(prefix + suffix, "utf8"));

  const result = parseReleaseContext(prefix + padding + suffix);

  assert.ok(result.valid);
});

void test("the PR template requires authors to complete summary and impact", async () => {
  const template = await readFile(
    new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
    "utf8",
  );

  const incomplete = parseReleaseContext(template);

  assert.ok(!incomplete.valid);
  assert.deepEqual(
    incomplete.errors.map(({ code, field }) => ({ code, field })),
    [
      { code: "field-invalid", field: "summary" },
      { code: "field-invalid", field: "impact" },
    ],
  );

  const completed = template
    .replace('summary: ""', "summary: Export selected rows.")
    .replace('impact: ""', "impact: Less manual cleanup.");

  assert.ok(parseReleaseContext(completed).valid);
});

void test("the documented authoring example satisfies the actual parser", async () => {
  const documentation = await readFile(
    new URL("../docs/release-context.md", import.meta.url),
    "utf8",
  );
  const example = fromMarkdown(documentation)
    .children.filter((node) => node.type === "code")
    .find((node) => node.lang === "markdown");

  assert.ok(example);
  const result = parseReleaseContext(example.value);

  assert.ok(result.valid);
  assert.equal(result.context.summary, "Export only the rows you select.");
  assert.equal(result.context.requiredAction, null);
});

void test("returns identical valid and invalid results for repeated descriptions", () => {
  for (const description of [block(), block("zebra: text\napple: text")]) {
    assert.equal(
      JSON.stringify(parseReleaseContext(description)),
      JSON.stringify(parseReleaseContext(description)),
    );
  }
});
