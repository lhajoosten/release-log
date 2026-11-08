import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseReleaseInputConfiguration } from "../src/release-snapshot.ts";
import type { ReleaseInputConfiguration } from "../src/release-snapshot.ts";

export interface RehearsalOptions {
  readonly configuration: ReleaseInputConfiguration;
  readonly sourceSha: string;
  readonly baseline:
    | { readonly kind: "bootstrap"; readonly commitSha: string }
    | { readonly kind: "released"; readonly tag: string; readonly currentVersion: string };
  readonly repositoryDirectory: string;
  readonly outputDirectory: string;
}
export type RehearsalCommand = (
  args: readonly string[],
  phase: "collect" | "offline",
) => Promise<string>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function parsedObject(value: string): Record<string, unknown> {
  const result: unknown = JSON.parse(value);
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new Error("CLI returned an invalid rehearsal result.");
  return Object.fromEntries(Object.entries(result));
}

export async function rehearseRelease(
  options: RehearsalOptions,
  execute: RehearsalCommand,
): Promise<void> {
  const config = parseReleaseInputConfiguration(options.configuration);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.sourceSha))
    throw new Error("Rehearsal requires a captured full source SHA.");
  const baseline = options.baseline;
  if (
    baseline.kind === "bootstrap"
      ? !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseline.commitSha)
      : !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(baseline.tag) ||
        baseline.tag !== `v${baseline.currentVersion}`
  )
    throw new Error(
      "Select an explicit bootstrap SHA or a released tag matching the current version.",
    );
  const temporary = await mkdtemp(join(tmpdir(), "release-rehearsal-"));
  try {
    const configPath = join(temporary, "configuration.json");
    const snapshotPath = join(temporary, "snapshot.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const snapshot = await execute(
      [
        "collect",
        "--config",
        configPath,
        "--repository",
        options.repositoryDirectory,
        "--source",
        options.sourceSha,
        ...(baseline.kind === "bootstrap"
          ? ["--bootstrap-sha", baseline.commitSha]
          : ["--baseline-tag", baseline.tag]),
      ],
      "collect",
    );
    await writeFile(snapshotPath, snapshot, { mode: 0o600 });
    const args = [
      "--config",
      configPath,
      "--snapshot",
      snapshotPath,
      ...(baseline.kind === "bootstrap"
        ? ["--initial-version", "0.1.0"]
        : ["--current-version", baseline.currentVersion]),
    ];
    const planJSON = await execute(["plan", ...args], "offline");
    const plan = parsedObject(planJSON);
    if (
      plan.sourceCommitSha !== options.sourceSha ||
      typeof plan.snapshotId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(plan.snapshotId) ||
      typeof plan.release !== "boolean"
    )
      throw new Error("Rehearsal plan does not match the captured source/snapshot identity.");
    const changelog = await execute(["render", ...args], "offline");
    const preparation = parsedObject(
      await execute(
        ["prepare", ...args, "--repository", options.repositoryDirectory, "--dry-run"],
        "offline",
      ),
    );
    if (
      preparation.mode !== "dry-run" ||
      !Array.isArray(preparation.files) ||
      JSON.stringify(preparation.plan) !== JSON.stringify(plan)
    )
      throw new Error("Rehearsal preparation must be dry-run and match the validated plan.");
    const files = preparation.files.map((file: unknown) => {
      if (
        typeof file !== "object" ||
        file === null ||
        !("path" in file) ||
        typeof file.path !== "string" ||
        !("after" in file) ||
        typeof file.after !== "string" ||
        !["package.json", "pyproject.toml", "CHANGELOG.md", ".release-log/inputs.json"].includes(
          file.path,
        )
      )
        throw new Error("Rehearsal returned an unsupported proposal output.");
      return { path: file.path, sha256: digest(file.after) };
    });
    if (
      (await execute(["plan", ...args], "offline")) !== planJSON ||
      (await execute(["render", ...args], "offline")) !== changelog
    )
      throw new Error("Offline replay changed the plan or changelog; rehearsal failed.");
    await mkdir(options.outputDirectory);
    await writeFile(
      join(options.outputDirectory, "plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
    );
    await writeFile(
      join(options.outputDirectory, "changelog.md"),
      changelog || "No releasable changes; no proposal or publication is authorized.\n",
    );
    await writeFile(
      join(options.outputDirectory, "evidence.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: "read-only-rehearsal",
          repository: config.repository,
          sourceSha: options.sourceSha,
          baseline,
          onboardingSha:
            config.schemaVersion === 2 && baseline.kind === "bootstrap"
              ? config.bootstrap.onboardingSha
              : null,
          snapshotId: plan.snapshotId,
          snapshotSha256: digest(snapshot),
          replayStable: true,
          files,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing rehearsal environment value: ${name}.`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (environment("GITHUB_REF") !== "refs/heads/main")
      throw new Error("Run rehearsals from trusted main only.");
    const mode = environment("REHEARSAL_MODE");
    if (mode !== "bootstrap" && mode !== "released")
      throw new Error("Unsupported rehearsal baseline mode.");
    const cli = environment("RELEASE_LOG_CLI");
    const token = environment("GITHUB_TOKEN");
    const execute = promisify(execFile);
    const configJSON = await readFile(
      join(environment("GITHUB_WORKSPACE"), "release-log.config.json"),
      "utf8",
    );

    if (Buffer.byteLength(configJSON, "utf8") > 1024 * 1024)
      throw new Error("Rehearsal configuration exceeds 1 MiB.");

    let value: unknown;

    try {
      value = JSON.parse(configJSON);
    } catch {
      throw new Error("Rehearsal configuration must be valid JSON.");
    }

    const configuration = parseReleaseInputConfiguration(value);

    if (
      configuration.repository !== environment("GITHUB_REPOSITORY") ||
      configuration.repositoryId !== Number(environment("GITHUB_REPOSITORY_ID")) ||
      configuration.releaseBranch !== "main"
    )
      throw new Error(
        "Rehearsal configuration must match the trusted repository identity and main branch.",
      );

    if (
      mode === "bootstrap" &&
      (configuration.schemaVersion !== 2 ||
        configuration.bootstrap.baselineSha !== environment("REHEARSAL_BASELINE"))
    )
      throw new Error(
        "Bootstrap rehearsal must use the baseline and fixed onboarding record from release-log.config.json.",
      );

    await rehearseRelease(
      {
        configuration,
        sourceSha: environment("GITHUB_SHA"),
        repositoryDirectory: environment("GITHUB_WORKSPACE"),
        outputDirectory: environment("REHEARSAL_OUTPUT"),
        baseline:
          mode === "bootstrap"
            ? { kind: "bootstrap", commitSha: environment("REHEARSAL_BASELINE") }
            : {
                kind: "released",
                tag: environment("REHEARSAL_BASELINE"),
                currentVersion: environment("REHEARSAL_CURRENT_VERSION"),
              },
      },
      async (args, phase) => {
        try {
          const result = await execute(process.execPath, [cli, ...args], {
            timeout: 360_000,
            maxBuffer: 128 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              ...(phase === "collect" ? { GITHUB_TOKEN: token } : {}),
            },
          });
          return result.stdout;
        } catch (error) {
          const stderr =
            error instanceof Error && "stderr" in error && typeof error.stderr === "string"
              ? error.stderr
              : "";
          const diagnostic = stderr
            .split("\n")
            .find(
              (line) =>
                line.startsWith("release-log: ") && line.length <= 2048 && !line.includes(token),
            );
          throw new Error(
            `Packaged CLI ${args[0] ?? "operation"} failed; no release was attempted. ${diagnostic?.replace(/\p{Cc}/gu, "") ?? "Check the explicit baseline, historical metadata, permissions, and supported version files."}`,
            { cause: error },
          );
        }
      },
    );
    console.log(
      "Read-only release rehearsal passed; review the preview artifact. No release is authorized or published.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release rehearsal failed.");
    process.exitCode = 1;
  }
}
