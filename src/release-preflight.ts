import { stringify } from "yaml";

import { requireUnusedReleaseVersions } from "./tagging/evidence.ts";
import { parseReleaseInputConfiguration } from "./config/repository.ts";
import type { ReleaseInputConfiguration } from "./config/repository.ts";
import {
  inspectGitTree,
  inspectOnboardingRange,
  inspectPendingRelease,
  inspectRootBaseline,
  inspectStableTags,
  readGitBlob,
  recommendOnboardingCutoff,
} from "./git.ts";
import { collectMergedPullRequests } from "./github-association.ts";
import { GitHubProposalRepository, proposalObject } from "./github-proposals.ts";
import { GitHubReadError, readGitHubBot } from "./github.ts";
import type { GitHubRead } from "./github.ts";
import { deriveReleasePlan } from "./planning/derive-release-plan.ts";
import { readReleaseContents } from "./version-file-inputs.ts";
import { prepareVerifiedRelease, prepareVersionFiles } from "./proposal/prepare.ts";
import { reconcileReleaseProposal } from "./proposal/reconcile.ts";
import type { PullRequestAssociation } from "./snapshot/association.ts";
import { captureReleaseSnapshot } from "./snapshot/capture.ts";
import { onboardingCommits } from "./snapshot/graph.ts";
import { serializeReleaseSnapshot } from "./snapshot/replay.ts";
import { digest } from "./snapshot/runtime-identity.ts";

type Findings = Record<string, { status: "passed" | "blocked" | "unverified"; message: string }>;
interface ActionsApp {
  readonly appId: string;
  readonly botUserId: string;
  readonly hasPrivateKey: boolean;
  readonly installation: string;
  readonly permissions: string;
  readonly slug: string;
  readonly installationToken?: string;
  readonly token?: string;
}
type Bootstrap = Extract<ReleaseInputConfiguration, { schemaVersion: 2 }>["bootstrap"];

export interface PreflightRequest {
  readonly repository: string;
  readonly sourceSha: string;
  readonly candidateSha?: string;
  readonly producerSha: string;
  readonly initialVersion: string;
  readonly configuration: ReleaseInputConfiguration;
  readonly baselineSha?: string;
  readonly onboardingSha?: string;
  readonly token?: string;
  readonly app?: ActionsApp;
}

const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const snapshotPath = ".release-log/inputs.json";
const callerPath = ".github/workflows/rolling-release-caller.yml";
const checksNotRun = {
  appConfiguration: {
    status: "unverified",
    message: "Check App variables and key in a trusted Actions run.",
  },
  appInstallation: {
    status: "unverified",
    message: "Check that the App installation includes this repository.",
  },
  appPermissions: {
    status: "unverified",
    message: "Verify the grants by requesting a scoped token in Actions.",
  },
  appIdentity: {
    status: "unverified",
    message: "Verify the App slug and configured bot user ID in Actions.",
  },
  appDryRun: {
    status: "unverified",
    message: "Run the reviewed manual caller with write disabled.",
  },
} satisfies Findings;

function describeError(error: unknown): string {
  const safeNames = [
    "GitInspectionError",
    "PullRequestAssociationError",
    "ProposalConflictError",
    "ProposalFilesError",
    "ReleasePlanError",
    "ReleaseSnapshotError",
    "VersionFilesError",
    "ChangelogError",
  ];
  return error instanceof GitHubReadError ||
    (error instanceof Error && safeNames.includes(error.name))
    ? error.message.replace(/\p{Cc}/gu, "").slice(0, 2400)
    : "Check the captured inputs and retry the preflight.";
}

function numericId(value: string): number | null {
  const id = Number(value);
  return /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(id) ? id : null;
}

async function checkApp(
  app: ActionsApp | undefined,
  findings: Findings,
  read: GitHubRead,
): Promise<number | null> {
  if (!app) return null;
  const botUserId = numericId(app.botUserId);
  const missing = [
    ...(numericId(app.appId) === null ? ["numeric RELEASE_APP_ID"] : []),
    ...(botUserId === null ? ["numeric RELEASE_BOT_USER_ID"] : []),
    ...(!app.hasPrivateKey ? ["RELEASE_APP_PRIVATE_KEY"] : []),
  ];
  findings.appConfiguration =
    missing.length > 0
      ? { status: "blocked", message: `Set ${missing.join(", ")} in the caller repository.` }
      : { status: "passed", message: "The caller supplied the App ID, bot ID and private key." };
  if (app.installation === "skipped") return null;
  if (app.installation !== "success") {
    findings.appInstallation = {
      status: "blocked",
      message:
        "The App could not mint a token for this repository. Check the App ID/key pair, installation status and repository selection in the token step.",
    };
    return null;
  }
  findings.appInstallation = {
    status: "passed",
    message: "The App minted a repository-scoped token.",
  };
  const permissionsPassed = app.permissions === "success" && !!app.token?.trim();
  findings.appPermissions = permissionsPassed
    ? {
        status: "passed",
        message:
          "GitHub granted the requested Contents and Pull requests write permissions to the scoped token.",
      }
    : {
        status: "blocked",
        message:
          "Check Contents and Pull requests write grants and approve pending permission changes on the installation, then retry token minting.",
      };

  if (botUserId === null) return null;
  try {
    const identityToken = app.installationToken ?? app.token;
    if (!identityToken)
      throw new GitHubReadError("The GitHub App installation token is unavailable.");
    const identity = await readGitHubBot(app.slug, identityToken, read);
    if (identity !== botUserId) {
      findings.appIdentity = {
        status: "blocked",
        message:
          "RELEASE_BOT_USER_ID differs from the bot account reported for the installed App. Update the variable and rerun.",
      };
      return null;
    }
    findings.appIdentity = {
      status: "passed",
      message: "The installed App slug resolves to the configured bot user ID.",
    };
    return permissionsPassed ? botUserId : null;
  } catch {
    findings.appIdentity = {
      status: "unverified",
      message:
        "GitHub did not return a verifiable bot account for the installed App. Check its slug and rerun.",
    };
    return null;
  }
}

function callerPreview(configuration: ReleaseInputConfiguration, producerSha: string): string {
  const workflow = {
    name: "Rolling release caller",
    on: {
      workflow_dispatch: null,
      pull_request_target: {
        types: ["closed"],
        branches: [configuration.releaseBranch.replace(/[+!\]]/gu, "\\$&")],
      },
    },
    permissions: { contents: "read", "pull-requests": "read" },
    jobs: {
      release: {
        if: "github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true",
        uses: `lhajoosten/rolling-release/.github/workflows/rolling-release.yml@${producerSha}`,
        with: {
          "tool-sha": producerSha,
          "release-branch": configuration.releaseBranch,
          "app-id": "${{ vars.RELEASE_APP_ID }}",
          "bot-user-id": "${{ vars.RELEASE_BOT_USER_ID }}",
          write: false,
          configuration: JSON.stringify(configuration),
        },
        secrets: { "app-private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}" },
      },
    },
  };
  return stringify(workflow, { lineWidth: 0 });
}

async function checkSetupState(api: GitHubProposalRepository, freshSeries: boolean): Promise<void> {
  if (freshSeries) await requireUnusedReleaseVersions(api);
  else await checkInitialTags(api);

  const proposals = await api.pulls();
  if (proposals.length > 0 || (await api.ref("heads", api.headRef, true)))
    throw new GitHubReadError(
      `A reserved release branch or proposal already exists${proposals.length ? ` (PRs ${proposals.map(({ number }) => `#${number}`).join(", ")})` : ""}. Follow the proposal review or recovery path with its recorded boundary.`,
    );
}

async function checkInitialTags(api: GitHubProposalRepository): Promise<void> {
  for (let page = 1; page <= 10; page++) {
    const { data, next } = await api.request(`/tags?per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length > 100 || (next && data.length !== 100))
      throw new GitHubReadError(
        "GitHub returned an incomplete tag listing. Retry before selecting a baseline.",
      );
    for (const item of data) {
      const tag = proposalObject(item).name;
      if (typeof tag !== "string")
        throw new GitHubReadError("GitHub returned an invalid tag listing.");
      if (stableTag.test(tag))
        throw new GitHubReadError(
          `Stable tag ${tag} already exists. Follow the established-release adoption or recovery path.`,
        );
    }
    if (!next) break;
    if (page === 10)
      throw new GitHubReadError(
        "Tag discovery exceeded ten pages. Review existing release history.",
      );
  }
}

export async function preflightRelease(request: PreflightRequest, read: GitHubRead = fetch) {
  const { repository, sourceSha, candidateSha, producerSha } = request;
  const baseConfig = parseReleaseInputConfiguration(request.configuration);
  const fixedRange = baseConfig.schemaVersion === 2 ? baseConfig.bootstrap : null;
  const requestedCutoff = fixedRange?.onboardingSha ?? request.onboardingSha;
  if (request.initialVersion !== "0.1.0" || !/^[a-f0-9]{40}$/u.test(producerSha))
    throw new GitHubReadError(
      "Initialization requires version 0.1.0 and a reviewed 40-character producer SHA.",
    );
  const version = { kind: "bootstrap", initialVersion: request.initialVersion } as const;
  const findings: Findings = { ...checksNotRun };
  const readOnly: GitHubRead = (url, options) => {
    if (options.method !== "GET" || options.body !== undefined)
      throw new GitHubReadError("Initialization only allows read requests.");
    return read(url, options);
  };
  const captures = new Map<string, ReturnType<typeof inspectGitTree>>();
  function tree(sha: string) {
    const cached = captures.get(sha) ?? inspectGitTree(repository, sha);
    captures.set(sha, cached);
    return cached;
  }
  async function contents(sha: string, versionOnly = false) {
    const { entries } = await tree(sha);
    return readReleaseContents(async (path) => {
      if (versionOnly && (path === "CHANGELOG.md" || path === snapshotPath)) return null;
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = entries.get(parts.slice(0, index).join("/"));
        if (parent && parent.type !== "tree")
          throw new GitHubReadError("Version input directories must be ordinary Git trees.");
      }
      const entry = entries.get(path);
      if (!entry) return null;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new GitHubReadError("Version inputs must be ordinary tracked files.");
      try {
        return await readGitBlob(repository, entry.sha);
      } catch (error) {
        throw new GitHubReadError(`Could not read ${path}. ${describeError(error)}`);
      }
    }, !versionOnly && baseConfig.selfUpgrade);
  }
  async function checkFiles(sha: string, stage: string) {
    try {
      const input = await contents(sha, true);
      const files = prepareVersionFiles(input, {
        currentVersion: baseConfig.freshSeries?.previousVersion ?? null,
        nextVersion: version.initialVersion,
      });
      findings[stage] = {
        status: "passed",
        message: `Compatible version files at ${sha}: ${files.map(({ path }) => path).join(", ")}.`,
      };
      return true;
    } catch (error) {
      findings[stage] = {
        status: "blocked",
        message: `${describeError(error)} Review version files at ${sha} with producer ${producerSha}.`,
      };
      return false;
    }
  }

  const [sourceCompatible, , botUserId] = await Promise.all([
    checkFiles(sourceSha, "sourceFiles"),
    candidateSha ? checkFiles(candidateSha, "candidateFiles") : null,
    checkApp(request.app, findings, readOnly),
  ]);
  const token = botUserId !== null ? request.app?.token : request.token;
  const api = token?.trim()
    ? new GitHubProposalRepository(baseConfig, botUserId ?? 1, token, readOnly)
    : null;

  let baselineSha: string | null = fixedRange?.baselineSha ?? request.baselineSha ?? null;
  let rangeReview: {
    bootstrap: Bootstrap;
    includedCommits: readonly string[];
    commitOnlyEvidence: readonly string[];
    landings: { number: number; sha: string; verification: "legacy-eligible" | "strict" }[];
  } | null = null;
  let caller: string | null = null;
  const configAt = (bootstrap: Bootstrap) =>
    parseReleaseInputConfiguration({ ...baseConfig, schemaVersion: 2, bootstrap });

  try {
    const local = await tree(sourceSha);
    const tags = await inspectStableTags(repository);
    if (baseConfig.adoptedRelease || tags.length > 0)
      throw new GitHubReadError(
        `An established release${tags.length ? ` (${tags[0]})` : ""} was found. Follow the established-release adoption or recovery path.`,
      );
    if (!baseConfig.freshSeries && local.entries.has(snapshotPath))
      throw new GitHubReadError(
        "The source already contains a release capture. Review or recover its recorded release boundary.",
      );
    if (local.entries.has(callerPath) && !fixedRange)
      throw new GitHubReadError(
        "The source already contains the standard rolling caller. Rerun its trusted manual preflight or use its reviewed configuration.",
      );
    if (baseConfig.automationExclusions || baseConfig.selfUpgrade)
      throw new GitHubReadError(
        "Use the existing release review or recovery workflow for exclusions and self-upgrade configurations.",
      );

    baselineSha ??= await inspectRootBaseline(repository, sourceSha);
    const baseline = { kind: "bootstrap", commitSha: baselineSha } as const;
    const range = await inspectPendingRelease(repository, baseline, sourceSha);
    if (requestedCutoff !== undefined) {
      try {
        await inspectOnboardingRange(repository, range, requestedCutoff);
      } catch (error) {
        throw new GitHubReadError(
          `Invalid onboarding range with cutoff ${requestedCutoff}. ${describeError(error)}`,
        );
      }
    }
    if (!api || !token) {
      findings.history = {
        status: "unverified",
        message:
          "Provide a repository/PR read token as GITHUB_TOKEN to verify the branch, existing release state and PR associations.",
      };
    } else {
      await api.verifyRepository();
      const checkSource = async () => {
        if ((await api.ref("heads", baseConfig.releaseBranch)) !== sourceSha)
          throw new GitHubReadError(
            `The release branch moved or differs from captured source ${sourceSha}. Fetch the current source and review again.`,
          );
      };
      await checkSource();
      await checkSetupState(api, baseConfig.freshSeries !== undefined);

      const collect = (onboardingSha: string) =>
        collectMergedPullRequests(
          {
            repository: baseConfig.repository,
            releaseBranch: baseConfig.releaseBranch,
            localRepository: repository,
            range,
            token,
            onboardingSha,
            ...(baseConfig.freshSeries ? { freshSeries: baseConfig.freshSeries } : {}),
          },
          readOnly,
        );
      const review = (association: PullRequestAssociation, onboardingSha: string) => {
        const bootstrap = { baselineSha: baseline.commitSha, onboardingSha };
        const configuration = configAt(bootstrap);
        const historical = onboardingCommits(
          {
            ...association,
            bootstrapCommits: association.bootstrapCommits ?? [],
          },
          configuration,
        );
        return {
          bootstrap,
          includedCommits: range.commitShas,
          commitOnlyEvidence: association.bootstrapCommits?.map(({ sha }) => sha) ?? [],
          landings: association.pullRequests.map((pull) => ({
            number: pull.number,
            sha: pull.mergeCommitSha,
            verification: pull.landedCommits.every(({ sha }) => historical.has(sha))
              ? ("legacy-eligible" as const)
              : ("strict" as const),
          })),
        };
      };

      let onboardingSha = requestedCutoff ?? baselineSha;
      let association: PullRequestAssociation;
      try {
        association = await collect(onboardingSha);
      } catch (error) {
        if (
          fixedRange ||
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "unassociated-commit"
        )
          throw error;
        let cutoff: string;
        let proposed: PullRequestAssociation;
        try {
          const discovery = await collect(sourceSha);
          cutoff = await recommendOnboardingCutoff(
            repository,
            range,
            discovery.bootstrapCommits?.map(({ sha }) => sha) ?? [],
          );
          proposed = await collect(cutoff);
        } catch (discoveryError) {
          throw new GitHubReadError(
            `${describeError(error)} Cutoff discovery also failed. ${describeError(discoveryError)}`,
          );
        }
        if (cutoff === onboardingSha) throw error;
        rangeReview = review(proposed, cutoff);
        if (requestedCutoff !== undefined)
          throw new GitHubReadError(
            `${describeError(error)} Review the proposed cutoff ${cutoff} and its full range before rerunning with it.`,
          );
        association = proposed;
        onboardingSha = cutoff;
      }

      rangeReview = review(association, onboardingSha);
      const configuration = configAt(rangeReview.bootstrap);
      const snapshot = await captureReleaseSnapshot(association, configuration);
      deriveReleasePlan(snapshot, version);
      await checkSource();
      findings.history = {
        status: "passed",
        message: fixedRange
          ? "The fixed bootstrap range passed collection and snapshot validation."
          : "Review the exact proposed range before recording the onboarding cutoff.",
      };
      if (sourceCompatible) {
        try {
          prepareVerifiedRelease(snapshot, version, await contents(sourceSha));
          findings.preparation = {
            status: "passed",
            message: "The captured source passed read-only release preparation.",
          };
        } catch (error) {
          findings.preparation = { status: "blocked", message: describeError(error) };
        }
      }
      if (
        findings.preparation?.status === "passed" &&
        request.app &&
        request.app.token &&
        botUserId !== null &&
        fixedRange
      ) {
        try {
          const result = await reconcileReleaseProposal(
            {
              configuration,
              automation: { schemaVersion: 1, botUserId },
              token: request.app.token,
              snapshot: await serializeReleaseSnapshot(snapshot),
              version,
              write: false,
            },
            readOnly,
          );
          if (result.outcome !== "would-create")
            throw new GitHubReadError(
              "A new initial proposal was not prepared. Review existing release state.",
            );
          await checkSetupState(api, baseConfig.freshSeries !== undefined);
          await checkSource();
          findings.appDryRun = {
            status: "passed",
            message:
              "App-backed preparation would create the initial proposal. Review this run before explicitly enabling writes.",
          };
        } catch (error) {
          findings.appDryRun = {
            status: "blocked",
            message: `App-backed proposal preparation failed. ${describeError(error)}`,
          };
        }
      }
      if (
        !request.app &&
        !fixedRange &&
        (sourceCompatible || findings.candidateFiles?.status === "passed") &&
        findings.preparation?.status !== "blocked" &&
        findings.candidateFiles?.status !== "blocked"
      )
        caller = callerPreview(configuration, producerSha);
    }
  } catch (error) {
    findings.history = {
      status: "blocked",
      message: `${describeError(error)} Review baseline ${baselineSha ?? "(unresolved)"} and source ${sourceSha}.`,
    };
  }

  const blocked = Object.values(findings).some(({ status }) => status === "blocked");
  const reportFindings: Findings = {};
  for (const key of Object.keys(findings).toSorted()) {
    const finding = findings[key];
    if (!finding) continue;
    let { message } = finding;
    for (const secret of [request.token, request.app?.token, request.app?.installationToken])
      if (secret) message = message.replaceAll(secret, "[redacted]");
    reportFindings[key] = { ...finding, message };
  }
  return {
    status:
      blocked || (request.app && findings.appDryRun?.status !== "passed")
        ? "blocked"
        : findings.appDryRun?.status === "passed"
          ? "ready"
          : "unverified",
    repository: baseConfig.repository,
    repositoryId: baseConfig.repositoryId,
    releaseBranch: baseConfig.releaseBranch,
    producerSha,
    sourceSha,
    candidateSha: candidateSha ?? null,
    initialVersion: version.initialVersion,
    inputId: digest({
      configuration: rangeReview === null ? baseConfig : configAt(rangeReview.bootstrap),
      baselineSha,
      requestedCutoff: requestedCutoff ?? null,
      producerSha,
      sourceSha,
      version,
      candidateSha: candidateSha ?? null,
      appId: numericId(request.app?.appId ?? ""),
      botUserId: numericId(request.app?.botUserId ?? ""),
    }),
    baseline: { sha: baselineSha, boundary: "exclusive" },
    onboarding: { requestedSha: requestedCutoff ?? null, boundary: "inclusive" },
    rangeReview,
    findings: reportFindings,
    caller,
  };
}
