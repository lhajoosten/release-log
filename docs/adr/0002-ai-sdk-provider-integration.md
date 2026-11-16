# AI SDK Core for optional text generation

Status: accepted, 2026-11-16. Implements the provider prerequisite [#80](https://github.com/lhajoosten/release-log/issues/80) for [user-facing release notes #76](https://github.com/lhajoosten/release-log/issues/76). The user selected Vercel AI SDK and requested this ADR.

## Context

Release notes may use an LLM to assist with wording. Release membership, conventional classification, versioning, breaking evidence and the technical changelog must remain deterministic and independent of provider credentials or availability. The project needs a small text-generation boundary rather than its own implementations of several vendor protocols.

Provider choice, hosting and access/billing are separate decisions. Vendor API keys suit explicit CI execution. Open models can run locally or through a hosted service. A subscription may offer access through official agent tooling or API-credit benefits, but it is not an interchangeable credential for every API transport.

## Decision

Use AI SDK Core (`ai`) and its direct OpenAI, Anthropic, Azure and OpenAI-compatible provider packages. Keep a thin project-owned wrapper, exported at `release-log/ai`, for configuration validation, generation limits, safe errors and minimal provenance. Use one non-streaming generation call with instructions and input text; do not expose tools, agent loops or arbitrary provider options.

Select the provider and model explicitly. OpenAI and Azure use Responses with `store: false`; Anthropic uses Messages; compatible endpoints use Chat Completions. Configure compatible endpoints explicitly, including local Ollama. Compatibility is limited to the tested text-generation contract, not every SDK/model capability. No model is selected by default and the wrapper does not benchmark or certify model quality.

Connect directly to the selected provider. Vercel hosting and an AI Gateway account are not required. Do not pass plain model strings to the SDK's gateway-based model resolver. Gateway routing/billing and subscription-backed CLI/SDK execution are deferred to separately reviewed integrations. Never extract session tokens or silently fall back to another endpoint, model or billing mechanism.

Keep credentials runtime-only and separate from serializable configuration. An explicit environment helper accepts `RELEASE_LOG_AI_PROVIDER`, `RELEASE_LOG_AI_MODEL` and only the selected provider's credential. Ignore unrelated SDK endpoint/model environment defaults. Local `.env` files are ignored and loaded explicitly by the invoking process; no application module loads them automatically.

Disable automatic retries and telemetry. Bound input text, output tokens, response bytes, generated-text bytes and total time; support caller cancellation. Return complete text only. Error messages and causes must not disclose credentials, source text or provider bodies. Generated text stays untrusted, and factual/source-coverage checks and retention of reviewed bytes belong to #76. Repeating a provider call is new generation, not deterministic replay.

## Alternatives and consequences

Handwritten HTTP adapters avoid the SDK dependency but duplicate protocol mapping, validation and provider maintenance. Separate vendor SDKs also require a project-owned common interface and more adapter code. AI SDK supplies that common generation API; the wrapper retains only policies that belong to release-log.

Routing everything through AI Gateway could centralize billing and observability, but would add an intermediary, credential and data-disclosure decision. It is unnecessary for direct API keys or a local model endpoint. Subscription-backed agent runtimes add login, installed tooling, tool permissions and process-isolation concerns that do not fit this single-request HTTP boundary.

Exact dependency pins and the lockfile remain part of the trusted tool identity. This dependency change changes the snapshot normalizer identity under the existing policy. Replay prior captured snapshots with their original pinned tool; recapture and review inputs when adopting this revision. AI integration does not relax identity verification.

## Version and strict TypeScript compatibility

AI SDK 7.0.173 and its current providers failed declaration checks under this repository's `exactOptionalPropertyTypes`, including image-interface declarations and tool generics. This change intentionally pins AI SDK 6.0.332 and compatible provider versions. Version 6 also needs the small tracked `@ai-sdk/provider-utils@4.0.66` declaration patch: its `NeverOptional` branch for `never` uses optional `never` properties instead of optional `undefined` properties. This preserves the intended absence of tool output properties under exact optional semantics and makes the SDK's own `ToolSet` constraints consistent.

The patch changes type declarations and matching TypeScript source only; compiled JavaScript is unchanged. Strict optional-property and library declaration checks remain enabled. Package the patch and pnpm workspace settings so offline production installs use the same correction. Reassess the patch and SDK major version on dependency upgrades; remove the patch when upstream declarations pass the repository checks without it.

See the [generation API and configuration guide](../text-generation.md) for the supported contract and verification limits.
