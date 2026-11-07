import { fileURLToPath } from "node:url";

import lint from "@commitlint/lint";
import load from "@commitlint/load";
import { parse } from "@commitlint/parse";
import type { LintOptions } from "@commitlint/types";

const policy = await load(
  {},
  {
    file: fileURLToPath(new URL("../commitlint.config.mjs", import.meta.url)),
  },
);

// Commitlint exposes loaded parser options as unknown. Validate the supported
// preset shape rather than asserting a type or silently discarding new options.
function isParserOptions(value: unknown): value is NonNullable<LintOptions["parserOpts"]> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("headerPattern" in value) ||
    !(value.headerPattern instanceof RegExp)
  ) {
    return false;
  }

  return Object.entries(value).every(([key, option]: [string, unknown]) => {
    if (["headerPattern", "breakingHeaderPattern", "revertPattern"].includes(key)) {
      return option instanceof RegExp;
    }

    if (
      ["headerCorrespondence", "noteKeywords", "revertCorrespondence", "issuePrefixes"].includes(
        key,
      )
    ) {
      return Array.isArray(option) && option.every((item: unknown) => typeof item === "string");
    }

    return false;
  });
}

const parserOptions = policy.parserPreset?.parserOpts;

if (!isParserOptions(parserOptions)) {
  throw new Error("The configured conventional parser preset has unsupported options.");
}

const lintOptions: LintOptions = {
  defaultIgnores: false,
  plugins: policy.plugins,
  parserOpts: parserOptions,
};

export interface MessageIssue {
  readonly rule: string;
  readonly message: string;
}

export interface ConventionalMetadata {
  readonly raw: string;
  readonly type: string;
  readonly scope: string | null;
  readonly description: string;
  readonly breaking: boolean;
  readonly breakingChanges: readonly string[];
}

export type MessageValidation =
  | {
      readonly valid: true;
      readonly commit: ConventionalMetadata;
      readonly warnings: readonly MessageIssue[];
    }
  | {
      readonly valid: false;
      readonly errors: readonly MessageIssue[];
      readonly warnings: readonly MessageIssue[];
    };

export async function validateConventionalMessage(message: string): Promise<MessageValidation> {
  if (message.trim().length === 0) {
    return {
      valid: false,
      errors: [{ rule: "message-empty", message: "A conventional message must not be empty." }],
      warnings: [],
    };
  }

  const report = await lint(message, policy.rules, lintOptions);
  const warnings = report.warnings.map(({ name, message: text }) => ({
    rule: name,
    message: text,
  }));

  if (!report.valid) {
    return {
      valid: false,
      errors: report.errors.map(({ name, message: text }) => ({ rule: name, message: text })),
      warnings,
    };
  }

  const parsed = await parse(message, undefined, lintOptions.parserOpts);

  if (typeof parsed.type !== "string" || typeof parsed.subject !== "string") {
    throw new Error(
      "The configured parser did not produce a type and subject for a valid message.",
    );
  }

  const breakingChanges = parsed.notes
    .filter(({ title }) => title === "BREAKING CHANGE" || title === "BREAKING-CHANGE")
    .map(({ text }) => text);

  return {
    valid: true,
    commit: {
      raw: message,
      type: parsed.type,
      scope: typeof parsed.scope === "string" ? parsed.scope : null,
      description: parsed.subject,
      breaking: breakingChanges.length > 0,
      breakingChanges,
    },
    warnings,
  };
}
