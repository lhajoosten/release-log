export type TextGenerationConfiguration =
  | { readonly provider: "openai"; readonly model: string }
  | { readonly provider: "anthropic"; readonly model: string }
  | { readonly provider: "azure"; readonly model: string; readonly resourceName: string }
  | { readonly provider: "openai-compatible"; readonly model: string; readonly baseURL: string };

export type TextGenerationErrorCode =
  | "configuration-invalid"
  | "request-invalid"
  | "authentication-failed"
  | "rate-limited"
  | "provider-failed"
  | "timed-out"
  | "cancelled"
  | "output-invalid"
  | "response-too-large";

const messages: Record<TextGenerationErrorCode, string> = {
  "configuration-invalid":
    "AI configuration requires an explicit supported provider, model and provider settings.",
  "request-invalid":
    "AI generation requires nonempty instructions/input and supported size, token and timeout limits.",
  "authentication-failed":
    "AI provider authentication failed; check the selected provider's credentials and permissions.",
  "rate-limited": "AI provider rate or quota limit reached; no automatic retry was made.",
  "provider-failed": "AI provider request failed; no automatic retry or fallback was made.",
  "timed-out": "AI generation exceeded its time limit; no partial output was accepted.",
  cancelled: "AI generation was cancelled; no partial output was accepted.",
  "output-invalid": "AI provider returned empty, incomplete, unsupported or invalid output.",
  "response-too-large":
    "AI provider response exceeded the byte limit; no partial output was accepted.",
};

export class TextGenerationError extends Error {
  readonly code: TextGenerationErrorCode;

  constructor(code: TextGenerationErrorCode) {
    super(messages[code]);
    this.name = "TextGenerationError";
    this.code = code;
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

export function parseTextGenerationConfiguration(value: unknown): TextGenerationConfiguration {
  if (!isRecord(value)) throw new TextGenerationError("configuration-invalid");

  const object: Record<string, unknown> = value;
  const { provider, model } = object;
  const keys = Object.keys(object).toSorted().join(",");
  if (!identifier(model)) throw new TextGenerationError("configuration-invalid");

  if ((provider === "openai" || provider === "anthropic") && keys === "model,provider")
    return { provider, model };

  if (
    provider === "azure" &&
    keys === "model,provider,resourceName" &&
    typeof object.resourceName === "string" &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(object.resourceName)
  )
    return { provider, model, resourceName: object.resourceName };

  if (
    provider === "openai-compatible" &&
    keys === "baseURL,model,provider" &&
    typeof object.baseURL === "string" &&
    object.baseURL.length <= 2048
  ) {
    let url: URL;
    try {
      url = new URL(object.baseURL);
    } catch {
      throw new TextGenerationError("configuration-invalid");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TextGenerationError("configuration-invalid");

    return { provider, model, baseURL: url.href.replace(/\/+$/u, "") };
  }

  throw new TextGenerationError("configuration-invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textGenerationConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): TextGenerationConfiguration {
  const provider = environment.RELEASE_LOG_AI_PROVIDER;
  const model = environment.RELEASE_LOG_AI_MODEL;
  const baseURL = environment.RELEASE_LOG_AI_BASE_URL;
  const resourceName = environment.AZURE_RESOURCE_NAME;
  if (
    (baseURL !== undefined && provider !== "openai-compatible") ||
    (resourceName !== undefined && provider !== "azure")
  )
    throw new TextGenerationError("configuration-invalid");

  return parseTextGenerationConfiguration({
    provider,
    model,
    ...(provider === "azure" ? { resourceName } : {}),
    ...(provider === "openai-compatible" ? { baseURL } : {}),
  });
}
