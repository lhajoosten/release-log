# Optional text generation

The `release-log/ai` library export implements [#80](https://github.com/lhajoosten/release-log/issues/80) using AI SDK Core and direct provider packages. The [architecture decision](adr/0002-ai-sdk-provider-integration.md) records why. This is the provider prerequisite for [#76](https://github.com/lhajoosten/release-log/issues/76); it does not generate release notes, add notes to proposals or publish content.

## Local configuration

Copy `.env.example` to `.env`, which is already ignored by Git, and set:

```dotenv
RELEASE_LOG_AI_PROVIDER=openai
RELEASE_LOG_AI_MODEL=your-model-id
OPENAI_API_KEY=your-project-api-key
```

Replace both placeholders locally. Choose a model available to your API project. There is no default model or automatic model discovery. `OPENAI_LLM_MODEL` is not used. These variables are needed only for explicit text generation; ordinary release commands neither require them nor load the generation module.

Use a restricted project API key with Model capabilities Request and Responses API Write permissions. Model-list access is unnecessary because the model is explicit. Your project/account must also permit the selected model. API charges and provider data-handling terms apply. Do not paste keys into issues, source files, generated configuration, logs or snapshots.

The library does not load `.env` files or read the process environment implicitly. The explicit helper takes an environment map. After `pnpm build`, a local invocation can opt in to both environment loading and a potentially billable provider request:

```sh
node --env-file=.env --input-type=module <<'JS'
import { createTextGeneratorFromEnvironment } from 'release-log/ai';

const generate = createTextGeneratorFromEnvironment(process.env);
const result = await generate({
  instructions: 'Explain the supplied change without inventing benefits.',
  input: 'Synthetic example: CSV export now retains the selected rows.',
  maxOutputTokens: 256,
});
console.log(result.text);
JS
```

This example sends only its instructions and synthetic input to the configured provider. A future release-notes caller must explicitly decide which captured evidence it sends. Merely building, importing the module or creating a generator makes no network request.

## Supported providers

Set only the settings for the selected provider. Keys are separate from the serializable configuration returned by `textGenerationConfigurationFromEnvironment()`.

| `RELEASE_LOG_AI_PROVIDER` | Model setting                               | Credential                        | Additional setting                                       | API                                         |
| ------------------------- | ------------------------------------------- | --------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `openai`                  | `RELEASE_LOG_AI_MODEL`: model ID            | `OPENAI_API_KEY`                  | None; fixed OpenAI endpoint                              | Responses, storage disabled                 |
| `anthropic`               | `RELEASE_LOG_AI_MODEL`: model ID            | `ANTHROPIC_API_KEY`               | None; fixed Anthropic endpoint                           | Messages                                    |
| `azure`                   | `RELEASE_LOG_AI_MODEL`: deployment name     | `AZURE_API_KEY`                   | `AZURE_RESOURCE_NAME`: resource DNS label                | Azure OpenAI v1 Responses, storage disabled |
| `openai-compatible`       | `RELEASE_LOG_AI_MODEL`: endpoint's model ID | Optional `RELEASE_LOG_AI_API_KEY` | Required `RELEASE_LOG_AI_BASE_URL`, including API prefix | Chat Completions                            |

Azure support here is API-key authentication against an Azure OpenAI resource, not all Foundry endpoints or Entra authentication. Those can be added when required. An unknown provider or incompatible extra configuration fails before generation. Ambient SDK variables such as `OPENAI_BASE_URL` are not used.

For an already installed local Ollama server with an already downloaded local model:

```dotenv
RELEASE_LOG_AI_PROVIDER=openai-compatible
RELEASE_LOG_AI_MODEL=your-installed-local-model
RELEASE_LOG_AI_BASE_URL=http://localhost:11434/v1
```

No API key is sent if `RELEASE_LOG_AI_API_KEY` is absent. Configuring `OPENAI_API_KEY` does not cause it to be forwarded to a compatible endpoint. HTTPS endpoints are supported; plain HTTP is permitted only for explicit loopback hosts (`localhost`, `127.0.0.1`, `[::1]`). URLs with credentials, queries or fragments are rejected and redirects are not followed. The API prefix is explicit; the wrapper does not guess `/v1` or probe endpoints.

The chosen endpoint and model determine where inference happens. A local Ollama server may itself route a cloud model externally; this wrapper cannot establish that a model runs locally. Open weights do not imply free hosting. Only select an endpoint/model whose data handling and access you intend to use.

## Library contract

`createTextGenerator(configuration, credentials?, transport?)` validates configuration and returns an async function. Credentials are `{ apiKey }`, required for vendor providers and optional for compatible endpoints. The optional transport is a `fetch` implementation for controlled integration tests; use the default native fetch for ordinary requests. `createTextGeneratorFromEnvironment(environment, transport?)` is the convenience equivalent.

The request contains `instructions`, `input`, optional `maxOutputTokens`, optional `timeoutMs` and optional `signal`. Instructions and input remain separate system/user text. Input text cannot configure tools, provider options, endpoints or credentials. The response contains raw `text`, configured `provider` and `model`, and `usage.inputTokens` / `usage.outputTokens` as numbers or null when unavailable. Usage is provider-reported, not billing reconciliation. Model/deployment provenance records the requested selection, not an immutable model revision or guarantee of repeatable prose.

Limits:

- Instructions and input must be nonempty and together at most 1 MiB in UTF-8.
- Requested output tokens default to 4096, configurable from 1 to 32768. A provider/model may impose narrower limits.
- Total execution time defaults to 60 seconds, configurable from 1 to 120000 milliseconds. Deadline and caller cancellation abort the request; no partial result is accepted.
- HTTP responses are read with a 2 MiB byte limit before SDK parsing. Generated text is at most 256 KiB in UTF-8.
- There is one generation call, zero automatic retries, no fallback, no model tools, no streaming and no enabled SDK telemetry.

Success requires a normal stop and nonempty text. Truncation, refusal, unexpected tool/file/source content and invalid payloads fail. Optional reasoning is not returned. Raw provider bodies, headers and SDK errors are not part of the result. The application does not print generated text automatically.

`TextGenerationError` has a fixed safe message and one of these codes: `configuration-invalid`, `request-invalid`, `authentication-failed`, `rate-limited`, `provider-failed`, `timed-out`, `cancelled`, `output-invalid`, `response-too-large`. Provider errors are not retained as causes because they can contain secrets or source text. A rate-limit response may also indicate exhausted quota; the wrapper does not invent a distinction or automatically spend more on another provider.

## Review and replay boundary

Successful generation validates transport/output shape, not factual accuracy. Returned text is untrusted and must not be executed, treated as an authoritative release decision or rendered as trusted HTML. Membership, type, bump, breaking status and source coverage remain outside this component. No release evidence is collected automatically.

Another call may produce different bytes. Retaining generated bytes and binding them to snapshot/proposal identities, refresh/staleness handling, audience rules and human review belong to #76. Nothing in this API changes proposal ownership, approval, tagging or publication behavior. Ordinary deterministic commands work without credentials and do not import this module.

## Verification

Tests run the real AI SDK provider adapters against synthetic HTTP responses. They check requests/authentication for all supported adapters, configuration errors, missing credentials, bounds, empty/malformed/truncated/refused output, provider errors without retries, cancellation, deadlines and inert hostile text. Tests need no real API key, model server or paid request. Packaged integration tests exercise the exported library after an offline production installation, including its tracked declaration patch.

Live provider/model quality, account/model access, Azure tenancy configuration and a real Ollama installation require separately identified live verification. Fixture success does not prove those external conditions.
