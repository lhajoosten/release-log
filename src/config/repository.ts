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

export type ReleaseContextPolicy = "required" | "optional";

export function isReleaseContextPolicy(value: unknown): value is ReleaseContextPolicy {
  return value === "required" || value === "optional";
}

export type ChangelogVerbosity = "detailed" | "concise" | "one-liner";

interface ReleaseRepositoryConfiguration {
  readonly repository: string;
  readonly repositoryId: number;
  readonly releaseBranch: string;
  readonly releasePolicy: "release-policy-v1";
  readonly contextPolicy?: ReleaseContextPolicy;
  readonly selfUpgrade?: true;
  readonly githubRelease?: true;
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

export function parseReleaseInputConfiguration(value: unknown): ReleaseInputConfiguration {
  const item = object(
    value,
    [
      "schemaVersion",
      "repository",
      "repositoryId",
      "releaseBranch",
      "releasePolicy",
      ...(isObject(value) && value.schemaVersion === 2 ? ["bootstrap"] : []),
      ...(isObject(value) && Object.hasOwn(value, "contextPolicy") ? ["contextPolicy"] : []),
      ...(isObject(value) && Object.hasOwn(value, "selfUpgrade") ? ["selfUpgrade"] : []),
      ...(isObject(value) && Object.hasOwn(value, "adoptedRelease") ? ["adoptedRelease"] : []),
      ...(isObject(value) && Object.hasOwn(value, "githubRelease") ? ["githubRelease"] : []),
      ...(isObject(value) && Object.hasOwn(value, "changelog") ? ["changelog"] : []),
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
    (item.selfUpgrade !== true ||
      repository !== "lhajoosten/release-log" ||
      item.repositoryId !== 1449550207)
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

  const common: ReleaseRepositoryConfiguration = {
    repository,
    repositoryId: positive(item.repositoryId, "repository ID"),
    releaseBranch,
    releasePolicy: "release-policy-v1",
    ...(contextPolicy === undefined ? {} : { contextPolicy }),
    ...(item.selfUpgrade === true ? { selfUpgrade: true } : {}),
    ...(item.githubRelease === true ? { githubRelease: true } : {}),
    ...(adoptedRelease === undefined ? {} : { adoptedRelease }),
    ...(changelog === undefined ? {} : { changelog }),
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
