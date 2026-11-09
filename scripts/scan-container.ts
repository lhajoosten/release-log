import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const scannerPins = {
  syft: {
    version: "1.57.0",
    sha256: "9c077a7d43029b3b13e98a8db720661e700c4d58db6352153a06395ae4a2a704",
  },
  grype: {
    version: "0.121.2",
    sha256: "9c8965ced9df657e5e851c14021bae838802f711edd7a48f9bc3c923a8d28f12",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a scanner JSON object.");
  return value;
}

export function checkInventory(value: unknown) {
  const inventory = record(value);
  if (!Array.isArray(inventory.artifacts)) throw new Error("Missing SBOM artifacts.");
  const packages = inventory.artifacts.map(record);
  const node = packages.find((pkg) => pkg.name === "node" && pkg.type === "binary");
  if (
    !node ||
    typeof node.version !== "string" ||
    !packages.some((pkg) => pkg.type === "deb") ||
    !packages.some((pkg) => pkg.type === "npm" && pkg.name === "@commitlint/lint")
  )
    throw new Error(
      "Incomplete inventory: require Debian, Node binary and production npm packages.",
    );
  const nodeVersion = node.version;
  if (
    !Array.isArray(node.cpes) ||
    !node.cpes.some(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.cpe === "string" &&
        item.cpe.startsWith(`cpe:2.3:a:nodejs:node.js:${nodeVersion}:`),
    )
  )
    throw new Error("Incomplete inventory: Node binary requires a matching vulnerability CPE.");
  return { packageCount: packages.length, nodeVersion };
}

export function summarizeMatches(value: unknown) {
  const report = record(value);
  if (!Array.isArray(report.matches)) throw new Error("Missing vulnerability matches.");
  const counts: Record<string, number> = {};
  let blocked = false;
  for (const item of report.matches) {
    const vulnerability = record(record(item).vulnerability);
    const severity = vulnerability.severity;
    if (
      typeof vulnerability.id !== "string" ||
      typeof severity !== "string" ||
      !["Negligible", "Low", "Medium", "High", "Critical", "Unknown"].includes(severity)
    )
      throw new Error("Malformed vulnerability match.");
    counts[severity] = (counts[severity] ?? 0) + 1;
    if (["High", "Critical", "Unknown"].includes(severity)) blocked = true;
  }
  return { counts, blocked };
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary file content.");
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function installScanner(name: keyof typeof scannerPins, directory: string) {
  const pin = scannerPins[name];
  const url = `https://github.com/anchore/${name}/releases/download/v${pin.version}/${name}_${pin.version}_linux_amd64.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
    throw new Error(`${name} archive checksum mismatch; refusing to execute.`);
  const archive = join(directory, `${name}.tar.gz`);
  await writeFile(archive, bytes);
  await execute("tar", ["-xzf", archive, "--directory", directory, name], { timeout: 10_000 });
  return join(directory, name);
}

export async function scanContainer(image: string, output: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Container security scanning currently requires Linux x86-64.");
  const destination = resolve(output);
  // Refuse existing evidence directories so a failed rerun cannot look like an old success.
  await mkdir(destination, { recursive: false });
  const directory = await mkdtemp(join(tmpdir(), "release-container-security-"));
  const environment = {
    PATH: process.env.PATH,
    HOME: directory,
    TMPDIR: directory,
    XDG_CACHE_HOME: join(directory, "cache"),
  };
  async function run(file: string, args: string[], timeout = 120_000) {
    return execute(file, args, {
      cwd: directory,
      env: environment,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  async function save(name: string, value: unknown) {
    await writeFile(join(destination, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  try {
    const inspected: unknown = JSON.parse(
      (await run("docker", ["image", "inspect", image])).stdout,
    );
    if (!Array.isArray(inspected) || inspected.length !== 1)
      throw new Error("Expected one local image.");
    const metadata = record(inspected[0]);
    if (
      typeof metadata.Id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(metadata.Id) ||
      metadata.Os !== "linux" ||
      metadata.Architecture !== "amd64"
    )
      throw new Error("Expected a local Linux/amd64 image with an immutable SHA-256 identity.");
    await save("image.json", metadata);
    const archive = join(directory, "image.tar");
    await run("docker", ["image", "save", "--output", archive, metadata.Id]);
    const archiveSha256 = await digest(archive);
    const [syft, grype] = await Promise.all([
      installScanner("syft", directory),
      installScanner("grype", directory),
    ]);
    const syftConfig = join(directory, "syft.json");
    const grypeConfig = join(directory, "grype.json");
    await writeFile(syftConfig, JSON.stringify({ "check-for-app-update": false }));
    await writeFile(
      grypeConfig,
      JSON.stringify({
        "check-for-app-update": false,
        "external-sources": { enable: false },
        db: {
          "cache-dir": join(directory, "db"),
          "auto-update": false,
          "validate-age": true,
          "max-allowed-built-age": "120h",
          "validate-by-hash-on-start": true,
        },
      }),
    );
    await save("scanner-pins.json", scannerPins);
    await writeFile(
      join(destination, "syft-version.json"),
      (await run(syft, ["version", "-o", "json"])).stdout,
    );
    await writeFile(
      join(destination, "grype-version.json"),
      (await run(grype, ["version", "-o", "json"])).stdout,
    );
    const sbomPath = join(destination, "sbom.syft.json");
    const catalog = await run(
      syft,
      [
        "scan",
        `docker-archive:${archive}`,
        "--config",
        syftConfig,
        "--scope",
        "squashed",
        "-o",
        `syft-json=${sbomPath}`,
      ],
      300_000,
    );
    await writeFile(join(destination, "catalog.log"), catalog.stderr);
    const inventory = checkInventory(JSON.parse(await readFile(sbomPath, "utf8")));
    const update = await run(grype, ["db", "update", "--config", grypeConfig], 300_000);
    await writeFile(join(destination, "database-update.log"), update.stdout + update.stderr);
    const database: unknown = JSON.parse(
      (await run(grype, ["db", "status", "--config", grypeConfig, "-o", "json"])).stdout,
    );
    await save("database.json", database);
    const reportPath = join(destination, "vulnerabilities.json");
    const scan = await run(
      grype,
      [`sbom:${sbomPath}`, "--config", grypeConfig, "-o", `json=${reportPath}`],
      300_000,
    );
    await writeFile(join(destination, "scan.log"), scan.stderr);
    const findings = summarizeMatches(JSON.parse(await readFile(reportPath, "utf8")));
    const evidence = {
      scannedAt: new Date().toISOString(),
      imageId: metadata.Id,
      repoDigests: metadata.RepoDigests,
      archiveSha256,
      sbomSha256: await digest(sbomPath),
      reportSha256: await digest(reportPath),
      scanners: scannerPins,
      database,
      inventory,
      ...findings,
      policy:
        "Fail on High, Critical or Unknown severity, including unfixed findings; no repository ignore rules.",
    };
    await save("evidence.json", evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (findings.blocked)
      throw new Error(`Container vulnerability gate failed; review ${reportPath}.`);
  } catch (error) {
    await save("failure.json", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--image" || !args[1] || args[2] !== "--output" || !args[3])
    throw new Error(
      "Usage: node scripts/scan-container.ts --image LOCAL_IMAGE --output NEW_DIRECTORY",
    );
  await scanContainer(args[1], args[3]);
}
