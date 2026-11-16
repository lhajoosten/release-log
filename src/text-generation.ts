import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import {
  parseTextGenerationConfiguration,
  textGenerationConfigurationFromEnvironment,
  TextGenerationError,
} from "./ai-configuration.ts";
import type { TextGenerationConfiguration } from "./ai-configuration.ts";

export {
  TextGenerationError,
  parseTextGenerationConfiguration,
  textGenerationConfigurationFromEnvironment,
};
export type { TextGenerationConfiguration, TextGenerationErrorCode } from "./ai-configuration.ts";

export interface TextGenerationRequest {
  readonly instructions: string;
  readonly input: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TextGenerationResult {
  readonly text: string;
  readonly provider: TextGenerationConfiguration["provider"];
  readonly model: string;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
}

export type TextGenerator = (request: TextGenerationRequest) => Promise<TextGenerationResult>;

const maximumInputBytes = 1024 * 1024;
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumOutputBytes = 256 * 1024;

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function tokenCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function boundedResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new TextGenerationError("authentication-failed");
    if (response.status === 429) throw new TextGenerationError("rate-limited");
    throw new TextGenerationError("provider-failed");
  }
  if (!response.body) throw new TextGenerationError("output-invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel();
        throw new TextGenerationError("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    headers: response.headers,
  });
}

function modelFor(
  configuration: TextGenerationConfiguration,
  apiKey: string | undefined,
  transport: typeof fetch,
): LanguageModel {
  const { provider, model } = configuration;
  if (provider !== "openai-compatible" && (apiKey === undefined || !apiKey.trim()))
    throw new TextGenerationError("authentication-failed");
  if (apiKey !== undefined && (!apiKey.trim() || /[\r\n]/u.test(apiKey)))
    throw new TextGenerationError("authentication-failed");

  // Explicit keys and base URLs prevent SDK environment defaults from selecting another destination.
  if (provider === "openai" && apiKey !== undefined)
    return createOpenAI({
      apiKey,
      baseURL: "https://api.openai.com/v1",
      fetch: transport,
    }).responses(model);
  if (provider === "anthropic" && apiKey !== undefined)
    return createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1", fetch: transport })(
      model,
    );
  if (provider === "azure" && apiKey !== undefined)
    return createAzure({
      apiKey,
      baseURL: `https://${configuration.resourceName}.openai.azure.com/openai/v1`,
      apiVersion: "v1",
      fetch: transport,
    }).responses(model);

  if (provider !== "openai-compatible") throw new TextGenerationError("authentication-failed");
  return createOpenAICompatible({
    name: "release-log-compatible",
    baseURL: configuration.baseURL,
    ...(apiKey === undefined ? {} : { apiKey }),
    fetch: transport,
  }).chatModel(model);
}

export function createTextGenerator(
  selected: TextGenerationConfiguration,
  credentials: { readonly apiKey?: string } = {},
  transport: typeof fetch = fetch,
): TextGenerator {
  const configuration = parseTextGenerationConfiguration(selected);
  const boundedFetch: typeof fetch = async (url, init) => {
    try {
      return await boundedResponse(await transport(url, { ...init, redirect: "error" }));
    } catch (error) {
      if (error instanceof TextGenerationError) throw error;
      throw new TextGenerationError("provider-failed");
    }
  };
  const model = modelFor(configuration, credentials.apiKey, boundedFetch);

  return async (request) => {
    const maxOutputTokens = request.maxOutputTokens ?? 4096;
    const timeoutMs = request.timeoutMs ?? 60_000;
    if (
      typeof request.instructions !== "string" ||
      !request.instructions.trim() ||
      typeof request.input !== "string" ||
      !request.input.trim() ||
      Buffer.byteLength(request.instructions, "utf8") + Buffer.byteLength(request.input, "utf8") >
        maximumInputBytes ||
      !boundedInteger(maxOutputTokens, 32_768) ||
      !boundedInteger(timeoutMs, 120_000)
    )
      throw new TextGenerationError("request-invalid");

    if (request.signal?.aborted) throw new TextGenerationError("cancelled");
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cancel = () => controller.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    const aborted = Promise.withResolvers<never>();
    const onAbort = () =>
      aborted.reject(new TextGenerationError(timedOut ? "timed-out" : "cancelled"));
    controller.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await Promise.race([
        generateText({
          model,
          system: request.instructions,
          prompt: request.input,
          maxOutputTokens,
          maxRetries: 0,
          abortSignal: controller.signal,
          experimental_telemetry: { isEnabled: false },
          ...(configuration.provider === "openai" || configuration.provider === "azure"
            ? { providerOptions: { openai: { store: false } } }
            : {}),
        }),
        aborted.promise,
      ]);
      if (controller.signal.aborted)
        throw new TextGenerationError(timedOut ? "timed-out" : "cancelled");
      if (
        result.finishReason !== "stop" ||
        !result.text.trim() ||
        Buffer.byteLength(result.text, "utf8") > maximumOutputBytes ||
        result.content.some((part) => part.type !== "text" && part.type !== "reasoning")
      )
        throw new TextGenerationError("output-invalid");

      return {
        text: result.text,
        provider: configuration.provider,
        model: configuration.model,
        usage: {
          inputTokens: tokenCount(result.usage.inputTokens),
          outputTokens: tokenCount(result.usage.outputTokens),
        },
      };
    } catch (error) {
      if (controller.signal.aborted)
        throw new TextGenerationError(timedOut ? "timed-out" : "cancelled");
      if (error instanceof TextGenerationError) throw error;
      // SDK errors can contain keys, source text and raw provider bodies. Never retain them as causes.
      throw new TextGenerationError("output-invalid");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
}

export function createTextGeneratorFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  transport: typeof fetch = fetch,
): TextGenerator {
  const configuration = textGenerationConfigurationFromEnvironment(environment);
  const keyName = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    azure: "AZURE_API_KEY",
    "openai-compatible": "RELEASE_LOG_AI_API_KEY",
  }[configuration.provider];
  const apiKey = environment[keyName];
  return createTextGenerator(configuration, apiKey === undefined ? {} : { apiKey }, transport);
}
