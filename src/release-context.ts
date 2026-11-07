import { fromMarkdown } from "mdast-util-from-markdown";
import { isAlias, isMap, isNode, isScalar, parseDocument } from "yaml";
import type { YAMLMap } from "yaml";

const maximumDescriptionBytes = 1024 * 1024;
const fieldNames = new Set(["version", "audience", "summary", "impact", "required_action"]);

export interface ReleaseContextV1 {
  readonly version: 1;
  readonly audience: "users" | "internal";
  readonly summary: string;
  readonly impact: string;
  readonly requiredAction: string | null;
}

export type ReleaseContextIssueCode =
  | "description-too-large"
  | "block-missing"
  | "block-duplicate"
  | "block-invalid"
  | "yaml-invalid"
  | "mapping-required"
  | "yaml-reference-unsupported"
  | "field-name-invalid"
  | "unknown-field"
  | "field-missing"
  | "field-invalid";

export interface ReleaseContextIssue {
  readonly code: ReleaseContextIssueCode;
  readonly message: string;
  readonly field?: string;
}

interface InvalidReleaseContext {
  readonly valid: false;
  readonly errors: readonly ReleaseContextIssue[];
}

export type ReleaseContextValidation =
  | {
      readonly valid: true;
      readonly context: ReleaseContextV1;
      readonly rawBlock: string;
    }
  | InvalidReleaseContext;

type FieldResult<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly error: ReleaseContextIssue };

function failure(code: ReleaseContextIssueCode, message: string): InvalidReleaseContext {
  return { valid: false, errors: [{ code, message }] };
}

function hasReference(node: unknown): boolean {
  return isAlias(node) || (isNode(node) && "anchor" in node && node.anchor !== undefined);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAudience(value: unknown): value is ReleaseContextV1["audience"] {
  return value === "users" || value === "internal";
}

function isRequiredAction(value: unknown): value is string | null {
  return value === null || isText(value);
}

function isVersion(value: unknown): value is 1 {
  return value === 1;
}

function readField<T>(
  mapping: YAMLMap,
  field: string,
  accepts: (value: unknown) => value is T,
  expectation: string,
): FieldResult<T> {
  if (!mapping.has(field)) {
    return {
      valid: false,
      error: { code: "field-missing", message: `Add the required ${field} field.`, field },
    };
  }

  const node = mapping.get(field, true);

  if (!isScalar(node) || (node.value === null && !node.source?.trim()) || !accepts(node.value)) {
    return {
      valid: false,
      error: {
        code: "field-invalid",
        message: `The ${field} field must be ${expectation}.`,
        field,
      },
    };
  }

  return { valid: true, value: node.value };
}

export function parseReleaseContext(description: string): ReleaseContextValidation {
  if (Buffer.byteLength(description, "utf8") > maximumDescriptionBytes) {
    return failure("description-too-large", "The PR description must not exceed 1 MiB in UTF-8.");
  }

  const blocks = fromMarkdown(description)
    .children.filter((node) => node.type === "code")
    .filter((node) => node.lang === "release-log");
  const [block] = blocks;

  if (block === undefined) {
    return failure("block-missing", "Add exactly one top-level release-log fenced code block.");
  }

  if (blocks.length !== 1) {
    return failure("block-duplicate", "Keep exactly one top-level release-log fenced code block.");
  }

  const start = block.position?.start.offset;
  const end = block.position?.end.offset;

  if (start === undefined || end === undefined) {
    throw new Error("The Markdown parser did not provide source positions for a code block.");
  }

  const rawBlock = description.slice(start, end);
  const lines = rawBlock.split(/\r\n|\n|\r/u);
  const fence = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})[\t ]*release-log[\t ]*$/u)?.[1];

  if (block.meta || fence === undefined) {
    return failure(
      "block-invalid",
      "Use the literal release-log label without extra fence metadata.",
    );
  }

  const closingFence = new RegExp(`^ {0,3}${fence.charAt(0)}{${fence.length},}[\\t ]*$`, "u");

  if (lines.length < 2 || !closingFence.test(lines.at(-1) ?? "")) {
    return failure("block-invalid", "Close the release-log block with a matching code fence.");
  }

  const document = parseDocument(block.value.replace(/\r\n|\r/gu, "\n"), {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  const problems = [...document.errors, ...document.warnings];

  if (problems.length > 0) {
    return {
      valid: false,
      errors: problems.map(({ code, linePos }) => ({
        code: "yaml-invalid",
        message: `Invalid release-context YAML (${code})${linePos?.[0] ? ` at YAML line ${linePos[0].line}` : ""}.`,
      })),
    };
  }

  if (document.directives?.yaml.version !== "1.2") {
    return failure("yaml-invalid", "Use YAML 1.2 rather than an older YAML directive.");
  }

  const mapping = document.contents;

  if (!isMap(mapping)) {
    return failure("mapping-required", "The release-log block must contain one YAML mapping.");
  }

  if (
    hasReference(mapping) ||
    mapping.items.some(({ key, value }) => hasReference(key) || hasReference(value))
  ) {
    return failure(
      "yaml-reference-unsupported",
      "Write release-context values without anchors or aliases.",
    );
  }

  const errors: ReleaseContextIssue[] = [];
  const unknownFields: string[] = [];

  for (const { key } of mapping.items) {
    if (!isScalar(key) || typeof key.value !== "string") {
      errors.push({
        code: "field-name-invalid",
        message: "Release-context field names must be strings.",
      });
    } else if (!fieldNames.has(key.value)) {
      unknownFields.push(key.value);
    }
  }

  for (const field of unknownFields.toSorted()) {
    errors.push({
      code: "unknown-field",
      message: `Remove unknown field ${JSON.stringify(field)}.`,
      field,
    });
  }

  const version = readField(
    mapping,
    "version",
    isVersion,
    "the number 1 (the supported schema version)",
  );
  const audience = readField(mapping, "audience", isAudience, "users or internal");
  const summary = readField(mapping, "summary", isText, "nonempty text");
  const impact = readField(mapping, "impact", isText, "nonempty text");
  const requiredAction = readField(
    mapping,
    "required_action",
    isRequiredAction,
    "nonempty instructions or an explicit null",
  );

  for (const result of [version, audience, summary, impact, requiredAction]) {
    if (!result.valid) {
      errors.push(result.error);
    }
  }

  if (
    !version.valid ||
    !audience.valid ||
    !summary.valid ||
    !impact.valid ||
    !requiredAction.valid ||
    errors.length > 0
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    context: {
      version: version.value,
      audience: audience.value,
      summary: summary.value,
      impact: impact.value,
      requiredAction: requiredAction.value,
    },
    rawBlock,
  };
}
