import {
  array,
  invalid,
  isObject,
  object,
  positive,
  sha,
  text,
  unique,
} from "../evidence/schema.ts";

export const defaultReleaseBumps = {
  build: "none",
  chore: "none",
  ci: "none",
  docs: "none",
  feat: "minor",
  fix: "patch",
  perf: "patch",
  refactor: "none",
  revert: "patch",
  style: "none",
  test: "none",
} as const;

type ConventionalType = keyof typeof defaultReleaseBumps;
type NonbreakingBump = (typeof defaultReleaseBumps)[ConventionalType];
type ReleaseBumpOverrides = Readonly<Partial<Record<ConventionalType, NonbreakingBump>>>;

export function isReleaseBumpType(value: string): value is ConventionalType {
  return Object.hasOwn(defaultReleaseBumps, value);
}

function parseReleaseBumps(value: unknown): ReleaseBumpOverrides {
  if (
    !isObject(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return invalid("Expected releaseBumps to be a JSON object.");
  const bumps: Partial<Record<ConventionalType, NonbreakingBump>> = {};
  for (const [type, bump] of Object.entries(value)) {
    if (!isReleaseBumpType(type))
      return invalid("releaseBumps keys must be supported lowercase conventional types.");
    if (bump !== "none" && bump !== "patch" && bump !== "minor")
      return invalid("releaseBumps values must be none, patch, or minor.");
    bumps[type] = bump;
  }
  return bumps;
}

export type ReleaseContextPolicy = "required" | "optional";

export const RELEASE_LOG_REPOSITORY_ID = 1449550207;
const releaseLogRepositories: ReadonlySet<string> = new Set([
  "lhajoosten/release-log",
  "lhajoosten/rolling-release",
]);

export function isReleaseLogRepositoryName(repository: string): boolean {
  return releaseLogRepositories.has(repository);
}

function isReleaseLogRepository(repository: string, repositoryId: unknown): boolean {
  return isReleaseLogRepositoryName(repository) && repositoryId === RELEASE_LOG_REPOSITORY_ID;
}

// Resolve the checked-in self-release config against GitHub’s current slug.
export function resolveProviderConfiguration(
  configuration: ReleaseInputConfiguration,
  repository: string | undefined,
  repositoryId: unknown,
): ReleaseInputConfiguration {
  if (
    repository === undefined ||
    !isReleaseLogRepository(repository, repositoryId) ||
    !isReleaseLogRepository(configuration.repository, configuration.repositoryId)
  )
    return invalid("Self-release requires the trusted provider repository identity.");
  return { ...configuration, repository };
}

export function isReleaseContextPolicy(value: unknown): value is ReleaseContextPolicy {
  return value === "required" || value === "optional";
}

export type ChangelogVerbosity = "detailed" | "concise" | "one-liner";

type CommitMessageRepair = { readonly pullNumber: number; readonly commitSha: string } & (
  | { readonly subject: string }
  | { readonly wrapBody: true }
);

export interface CandidateLandingPin {
  readonly pullNumber: number;
  readonly botUserId: number;
  readonly headSha: string;
  readonly landingSha: string;
  readonly proposalId: string;
  readonly version: string;
  readonly changelogDigest: string;
}

export type PreviousSeriesLanding = Pick<
  CandidateLandingPin,
  "pullNumber" | "botUserId" | "headSha" | "landingSha"
>;

interface FreshSeriesConfiguration {
  readonly id: string;
  readonly previousVersion: string;
  readonly previousChangelogSha256: string;
  readonly previousLandings: readonly PreviousSeriesLanding[];
}

interface ReleaseRepositoryConfiguration {
  readonly repository: string;
  readonly repositoryId: number;
  readonly releaseBranch: string;
  readonly releasePolicy: "release-policy-v1";
  readonly releaseBumps?: ReleaseBumpOverrides;
  readonly freshSeries?: FreshSeriesConfiguration;
  readonly contextPolicy?: ReleaseContextPolicy;
  readonly selfUpgrade?: true;
  readonly githubRelease?: true;
  readonly internalPublication?: true;
  readonly candidateLandings?: readonly CandidateLandingPin[];
  readonly candidateStableNotes?: string;
  readonly adoptedRelease?: {
    readonly pullNumber: number;
    readonly headSha: string;
    readonly landingSha: string;
    readonly commitSha: string;
    readonly tag: string;
  };
  readonly changelog?: {
    readonly verbosity: ChangelogVerbosity;
    readonly format?: "classic" | "compact";
  };
  readonly commitMessageRepairs?: readonly CommitMessageRepair[];
  readonly automationExclusions?: readonly {
    readonly pullNumber: number;
    readonly verificationId: string;
  }[];
}

export type ReleaseInputConfiguration = ReleaseRepositoryConfiguration &
  (
    | { readonly schemaVersion: 1 }
    | {
        readonly schemaVersion: 2;
        readonly bootstrap: {
          readonly baselineSha: string;
          readonly onboardingSha: string;
        };
      }
  );

export function releaseProposalBranch(config: ReleaseInputConfiguration): string {
  return config.freshSeries
    ? `release-log-series/${config.freshSeries.id}/${config.releaseBranch}`
    : `release-log/${config.releaseBranch}`;
}

export function isReservedReleaseBranch(
  headRef: string,
  releaseBranch: string,
  freshSeries: boolean,
): boolean {
  return (
    headRef === `release-log/${releaseBranch}` ||
    (freshSeries && headRef.startsWith("release-log-series/"))
  );
}

function parseFreshSeries(value: unknown): FreshSeriesConfiguration {
  const series = object(
    value,
    ["id", "previousVersion", "previousChangelogSha256", "previousLandings"],
    "freshSeries",
  );
  const id = text(series.id, "fresh series ID", 40);
  const previousVersion = text(series.previousVersion, "previous manifest version", 128);
  const previousChangelogSha256 = text(
    series.previousChangelogSha256,
    "previous changelog SHA-256",
    64,
  );
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(previousVersion) ||
    !/^[a-f0-9]{64}$/u.test(previousChangelogSha256)
  )
    return invalid(
      "freshSeries requires a lowercase series ID, a stable previous version and a full changelog SHA-256.",
    );
  const previousLandings = array(series.previousLandings, 100, "previous series landings")
    .map((entry) => {
      const pin = object(
        entry,
        ["pullNumber", "botUserId", "headSha", "landingSha"],
        "previous series landing",
      );
      return {
        pullNumber: positive(pin.pullNumber, "previous series PR number"),
        botUserId: positive(pin.botUserId, "previous series bot user ID"),
        headSha: sha(pin.headSha),
        landingSha: sha(pin.landingSha),
      };
    })
    .toSorted((left, right) => left.pullNumber - right.pullNumber);
  if (!previousLandings.length)
    return invalid("freshSeries requires the reviewed old release landings.");
  unique(
    previousLandings.map((pin) => pin.pullNumber),
    "previous series PR numbers",
  );
  unique(
    previousLandings.map((pin) => pin.landingSha),
    "previous series landing commits",
  );
  return { id, previousVersion, previousChangelogSha256, previousLandings };
}

export function parseReleaseInputConfiguration(value: unknown): ReleaseInputConfiguration {
  const item = object(
    value,
    [
      "schemaVersion",
      "repository",
      "repositoryId",
      "releaseBranch",
      "releasePolicy",
      ...(isObject(value) && Object.hasOwn(value, "freshSeries") ? ["freshSeries"] : []),
      ...(isObject(value) && Object.hasOwn(value, "releaseBumps") ? ["releaseBumps"] : []),
      ...(isObject(value) && value.schemaVersion === 2 ? ["bootstrap"] : []),
      ...(isObject(value) && Object.hasOwn(value, "contextPolicy") ? ["contextPolicy"] : []),
      ...(isObject(value) && Object.hasOwn(value, "selfUpgrade") ? ["selfUpgrade"] : []),
      ...(isObject(value) && Object.hasOwn(value, "adoptedRelease") ? ["adoptedRelease"] : []),
      ...(isObject(value) && Object.hasOwn(value, "githubRelease") ? ["githubRelease"] : []),
      ...(isObject(value) && Object.hasOwn(value, "internalPublication")
        ? ["internalPublication"]
        : []),
      ...(isObject(value) && Object.hasOwn(value, "candidateLandings")
        ? ["candidateLandings"]
        : []),
      ...(isObject(value) && Object.hasOwn(value, "candidateStableNotes")
        ? ["candidateStableNotes"]
        : []),
      ...(isObject(value) && Object.hasOwn(value, "changelog") ? ["changelog"] : []),
      ...(isObject(value) && Object.hasOwn(value, "commitMessageRepairs")
        ? ["commitMessageRepairs"]
        : []),
      ...(isObject(value) && Object.hasOwn(value, "automationExclusions")
        ? ["automationExclusions"]
        : []),
    ],
    "release configuration",
  );
  const repository = text(item.repository, "repository", 256);
  const releaseBranch = text(item.releaseBranch, "release branch", 1024);

  if (
    (item.schemaVersion !== 1 && item.schemaVersion !== 2) ||
    item.releasePolicy !== "release-policy-v1"
  )
    return invalid("Unsupported release configuration schema or policy revision.");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/u.test(repository) ||
    repository.trim() !== repository ||
    [".", ".."].includes(repository.split("/")[1] ?? "") ||
    !releaseBranch.trim() ||
    /[\0\r\n]/u.test(releaseBranch)
  )
    return invalid("Invalid repository identity or release branch in configuration.");
  if (Object.hasOwn(item, "contextPolicy") && !isReleaseContextPolicy(item.contextPolicy))
    return invalid("Context policy must be required or optional.");

  if (
    Object.hasOwn(item, "selfUpgrade") &&
    (item.selfUpgrade !== true || !isReleaseLogRepository(repository, item.repositoryId))
  )
    return invalid("Self-upgrades require explicit trusted release-log repository identity.");

  if (Object.hasOwn(item, "githubRelease") && item.githubRelease !== true)
    return invalid("Omit githubRelease or explicitly enable it with true.");

  const contextPolicy = isReleaseContextPolicy(item.contextPolicy) ? item.contextPolicy : undefined;
  let changelog: ReleaseRepositoryConfiguration["changelog"];

  if (Object.hasOwn(item, "changelog")) {
    const options = object(
      item.changelog,
      [
        "verbosity",
        ...(isObject(item.changelog) && Object.hasOwn(item.changelog, "format") ? ["format"] : []),
      ],
      "changelog configuration",
    );
    const verbosity = options.verbosity;

    if (verbosity !== "detailed" && verbosity !== "concise" && verbosity !== "one-liner")
      return invalid("Changelog verbosity must be detailed, concise or one-liner.");

    const format = options.format;
    if (Object.hasOwn(options, "format") && format !== "classic" && format !== "compact")
      return invalid("Changelog format must be classic or compact.");

    changelog = { verbosity, ...(format === "classic" || format === "compact" ? { format } : {}) };
  }

  let automationExclusions: ReleaseRepositoryConfiguration["automationExclusions"];

  if (Object.hasOwn(item, "automationExclusions")) {
    automationExclusions = array(
      item.automationExclusions,
      100,
      "trusted automation exclusion pins",
    )
      .map((entry) => {
        const pin = object(entry, ["pullNumber", "verificationId"], "automation exclusion pin");
        const verificationId = text(pin.verificationId, "verification ID", 64);

        if (!/^[a-f0-9]{64}$/u.test(verificationId))
          return invalid("Exclusion pins require complete lowercase verification digests.");

        return { pullNumber: positive(pin.pullNumber, "exclusion PR number"), verificationId };
      })
      .toSorted((left, right) => left.pullNumber - right.pullNumber);

    if (automationExclusions.length === 0)
      return invalid("Omit automationExclusions rather than supply an empty authority list.");

    unique(
      automationExclusions.map((pin) => pin.pullNumber),
      "exclusion PR numbers",
    );
    unique(
      automationExclusions.map((pin) => pin.verificationId),
      "exclusion verification IDs",
    );
  }

  let commitMessageRepairs: ReleaseRepositoryConfiguration["commitMessageRepairs"];
  if (Object.hasOwn(item, "commitMessageRepairs")) {
    commitMessageRepairs = array(item.commitMessageRepairs, 100, "trusted commit message repairs")
      .map((entry) => {
        const wrapBody = isObject(entry) && Object.hasOwn(entry, "wrapBody");
        const repair = object(
          entry,
          ["pullNumber", "commitSha", wrapBody ? "wrapBody" : "subject"],
          "commit message repair",
        );
        const target = {
          pullNumber: positive(repair.pullNumber, "repair PR number"),
          commitSha: sha(repair.commitSha),
        };
        if (wrapBody) {
          if (repair.wrapBody !== true) return invalid("A body wrap must explicitly be true.");
          return { ...target, wrapBody: true } as const;
        }
        const subject = text(repair.subject, "replacement commit subject", 100);
        if (subject.trim() !== subject || !/^(?:docs|ci): [^\r\n\0]+$/u.test(subject))
          return invalid(
            "A commit message repair requires a single non-breaking docs or ci subject.",
          );
        return { ...target, subject };
      })
      .toSorted((left, right) =>
        left.commitSha < right.commitSha ? -1 : left.commitSha === right.commitSha ? 0 : 1,
      );

    if (commitMessageRepairs.length === 0)
      return invalid("Omit commitMessageRepairs rather than supply an empty repair list.");
    unique(
      commitMessageRepairs.map(({ commitSha }) => commitSha),
      "repair commit IDs",
    );
  }

  let adoptedRelease: ReleaseRepositoryConfiguration["adoptedRelease"];
  if (Object.hasOwn(item, "adoptedRelease")) {
    const pin = object(
      item.adoptedRelease,
      ["pullNumber", "headSha", "landingSha", "commitSha", "tag"],
      "adopted release",
    );
    const tag = text(pin.tag, "adopted release tag", 64);
    const commitSha = sha(pin.commitSha);
    const landingSha = sha(pin.landingSha);
    if (commitSha === landingSha || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag))
      return invalid(
        "An adopted release requires a distinct reviewed commit and stable version tag.",
      );
    adoptedRelease = {
      pullNumber: positive(pin.pullNumber, "superseded PR number"),
      headSha: sha(pin.headSha),
      landingSha,
      commitSha,
      tag,
    };
  }

  if (
    Object.hasOwn(item, "internalPublication") &&
    (item.internalPublication !== true ||
      !isReleaseLogRepository(repository, item.repositoryId) ||
      releaseBranch !== "main" ||
      item.selfUpgrade !== true ||
      item.githubRelease !== true ||
      automationExclusions !== undefined)
  )
    return invalid(
      "Internal publication requires the trusted Release Log self-release configuration.",
    );

  let candidateLandings: readonly CandidateLandingPin[] | undefined;
  if (Object.hasOwn(item, "candidateLandings")) {
    if (item.internalPublication !== true)
      return invalid("Candidate landings require internal publication.");
    candidateLandings = array(item.candidateLandings, 30, "verified candidate landings").map(
      (entry) => {
        const pin = object(
          entry,
          [
            "pullNumber",
            "botUserId",
            "headSha",
            "landingSha",
            "proposalId",
            "version",
            "changelogDigest",
          ],
          "candidate landing",
        );
        const proposalId = text(pin.proposalId, "candidate proposal ID", 64);
        const changelogDigest = text(pin.changelogDigest, "candidate changelog digest", 64);
        const version = text(pin.version, "candidate version", 128);
        if (
          !/^[a-f0-9]{64}$/u.test(proposalId) ||
          !/^[a-f0-9]{64}$/u.test(changelogDigest) ||
          !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
        )
          return invalid("Invalid candidate proposal, version, or changelog identity.");
        return {
          pullNumber: positive(pin.pullNumber, "candidate PR number"),
          botUserId: positive(pin.botUserId, "candidate bot user ID"),
          headSha: sha(pin.headSha),
          landingSha: sha(pin.landingSha),
          proposalId,
          version,
          changelogDigest,
        };
      },
    );
    if (!candidateLandings.length) return invalid("Omit an empty candidate landing list.");
    unique(
      candidateLandings.map(({ pullNumber }) => pullNumber),
      "candidate PR numbers",
    );
    unique(
      candidateLandings.map(({ landingSha }) => landingSha),
      "candidate landing commits",
    );
  }

  let candidateStableNotes: string | undefined;
  if (Object.hasOwn(item, "candidateStableNotes")) {
    if (!candidateLandings) return invalid("Stable notes recovery requires a candidate landing.");
    candidateStableNotes = text(item.candidateStableNotes, "verified stable notes", 60 * 1024);
  }

  let freshSeries: FreshSeriesConfiguration | undefined;
  if (Object.hasOwn(item, "freshSeries")) {
    if (
      item.schemaVersion !== 2 ||
      isReleaseLogRepository(repository, item.repositoryId) ||
      adoptedRelease !== undefined ||
      automationExclusions !== undefined ||
      item.selfUpgrade === true ||
      item.internalPublication === true
    )
      return invalid(
        "freshSeries requires consumer schema 2 with no adopted boundary, self-release or separate exclusion configuration.",
      );
    freshSeries = parseFreshSeries(item.freshSeries);
  }

  const common: ReleaseRepositoryConfiguration = {
    repository,
    repositoryId: positive(item.repositoryId, "repository ID"),
    releaseBranch,
    releasePolicy: "release-policy-v1",
    ...(freshSeries === undefined ? {} : { freshSeries }),
    ...(Object.hasOwn(item, "releaseBumps")
      ? { releaseBumps: parseReleaseBumps(item.releaseBumps) }
      : {}),
    ...(contextPolicy === undefined ? {} : { contextPolicy }),
    ...(item.selfUpgrade === true ? { selfUpgrade: true } : {}),
    ...(item.githubRelease === true ? { githubRelease: true } : {}),
    ...(item.internalPublication === true ? { internalPublication: true } : {}),
    ...(candidateLandings === undefined ? {} : { candidateLandings }),
    ...(candidateStableNotes === undefined ? {} : { candidateStableNotes }),
    ...(adoptedRelease === undefined ? {} : { adoptedRelease }),
    ...(changelog === undefined ? {} : { changelog }),
    ...(commitMessageRepairs === undefined ? {} : { commitMessageRepairs }),
    ...(automationExclusions === undefined ? {} : { automationExclusions }),
  };

  if (item.schemaVersion === 2) {
    const bootstrap = object(
      item.bootstrap,
      ["baselineSha", "onboardingSha"],
      "trusted onboarding record",
    );

    return {
      ...common,
      schemaVersion: 2,
      bootstrap: {
        baselineSha: sha(bootstrap.baselineSha),
        onboardingSha: sha(bootstrap.onboardingSha),
      },
    };
  }

  return { ...common, schemaVersion: 1 };
}
