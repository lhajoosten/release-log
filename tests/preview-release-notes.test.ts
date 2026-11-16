import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/preview-release-notes.ts");
const sourceURL = "https://github.com/example/project/pull/1";
const internalURL = "https://github.com/example/project/pull/2";
const fixture = `# Changelog

<!-- release-log:pending:v1 sha256:fixture -->

## v0.2.0

### Features

- Export selected rows. ([#1](${sourceURL}))

<details>
<summary>Internal maintenance</summary>

- Update tooling. ([#2](${internalURL}))

</details>

<!-- release-log:pending:end -->

## v0.1.0

Previous release.
`;

void test("tracked preview command selects real changelog evidence offline without credentials or network", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-notes-preview-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const changelog = join(directory, "CHANGELOG.md");
  const prelude = join(directory, "offline.mjs");
  await writeFile(changelog, fixture);
  await writeFile(
    prelude,
    "globalThis.fetch = () => { throw new Error('Unexpected network request'); };\n",
  );
  const environment = {
    ...process.env,
    RELEASE_LOG_AI_PROVIDER: "",
    RELEASE_LOG_AI_MODEL: "",
    OPENAI_API_KEY: "",
  };
  for (const args of [[], ["v0.2.0"], ["v0.1.0"]]) {
    const result = await execute(
      process.execPath,
      ["--import", prelude, script, ...args, "--dry-run", "--changelog", changelog],
      {
        cwd: root,
        env: environment,
        timeout: 10000,
      },
    );
    assert.match(result.stderr, /offline dry-run, no provider call/u);
    if (args[0] === "v0.1.0") assert.equal(result.stdout, "## v0.1.0\n\nPrevious release.\n");
    else {
      assert.match(result.stdout, /^## v0\.2\.0\n/u);
      assert.ok(result.stdout.includes(sourceURL) && result.stdout.includes(internalURL));
      assert.doesNotMatch(result.stdout, /release-log:pending|Previous release/u);
    }
  }
  assert.equal(await readFile(changelog, "utf8"), fixture);
  for (const args of [["v9.0.0"], ["--unknown"], ["v0.2.0", "v0.1.0"], ["--changelog"]])
    await assert.rejects(
      execute(process.execPath, [script, "--dry-run", ...args], {
        cwd: root,
        env: environment,
        timeout: 10000,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 1,
    );
});

void test("preview generates with controlled HTTP, allows internal-reference omission, and rejects unsafe drafts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-notes-generation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const changelog = join(directory, "CHANGELOG.md");
  const prelude = join(directory, "provider.mjs");
  const requestPath = join(directory, "request.json");
  await writeFile(changelog, fixture);
  await writeFile(
    prelude,
    `
    import { writeFile } from 'node:fs/promises';
    globalThis.fetch = async (_url, init) => {
      await writeFile(process.env.PREVIEW_REQUEST_PATH, init.body);
      return Response.json({
        id: 'fixture-response', created_at: 1, model: 'fixture-model',
        output: [{ type: 'message', id: 'fixture-message', role: 'assistant', content: [
          { type: 'output_text', text: process.env.PREVIEW_RESPONSE, annotations: [] },
        ] }], usage: { input_tokens: 10, output_tokens: 20 },
      });
    };
  `,
  );
  const notes = `## v0.2.0\n\nExport selected rows. ([#1](${sourceURL}))`;
  for (const [text, expected] of [
    [notes, null],
    ["No source references.", /dropped source references/u],
    [notes + "\n[Extra](https://unsupported.example.com)", /unsupported source URLs/u],
    [notes + "\n<script>alert(1)</script>", /unsupported Markdown/u],
  ] as const) {
    const run = execute(
      process.execPath,
      ["--import", prelude, script, "v0.2.0", "--changelog", changelog],
      {
        cwd: root,
        timeout: 10000,
        env: {
          ...process.env,
          RELEASE_LOG_AI_PROVIDER: "openai",
          RELEASE_LOG_AI_MODEL: "fixture-model",
          OPENAI_API_KEY: "synthetic-secret",
          RELEASE_LOG_AI_BASE_URL: undefined,
          AZURE_RESOURCE_NAME: undefined,
          PREVIEW_REQUEST_PATH: requestPath,
          PREVIEW_RESPONSE: text,
        },
      },
    );
    if (expected === null) {
      const result = await run;
      assert.match(result.stdout, /Draft for human review/u);
      assert.ok(result.stdout.includes(notes));
      assert.doesNotMatch(result.stdout, /synthetic-secret|Update tooling/u);
      const sent = await readFile(requestPath, "utf8");
      assert.ok(sent.includes("Export selected rows") && sent.includes("Update tooling"));
      assert.doesNotMatch(sent, /Previous release|synthetic-secret/u);
    } else
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof Error &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          expected.test(error.stderr) &&
          "stdout" in error &&
          error.stdout === "",
      );
  }
  assert.equal(await readFile(changelog, "utf8"), fixture);
});
