/**
 * Constrained-decoding wire injection.
 *
 * omp's `SimpleStreamOptions` (packages/ai/src/types.ts) has no first-class
 * `response_format` field for any API family — the real cross-provider
 * completion path (`stream.ts` / `openai-completions.ts` / `anthropic.ts`)
 * never builds one. The documented, first-class extension point for this is
 * `onPayload` (SimpleStreamOptions.onPayload / packages/ai README "onPayload"
 * section): a hook invoked with the exact wire body immediately before it is
 * sent, whose return value replaces that body. Every built-in provider except
 * `devin-agent` honors it (packages/ai CHANGELOG: "Fixed OpenAI Completions,
 * Amazon Bedrock, and Cursor providers ignoring onPayload replacement
 * payloads").
 *
 * This module injects the provider-native structured-output field onto that
 * wire body for the two API families exercised end-to-end against real
 * backends (see scripts/acceptance.sh):
 *
 *   - "openai-completions" (vLLM, and any OpenAI Chat Completions-compatible
 *     endpoint): `response_format: { type: "json_schema", json_schema: {...} }`,
 *     the OpenAI Structured Outputs / vLLM guided-decoding field.
 *   - "anthropic-messages" (Claude API): `output_config.format: { type:
 *     "json_schema", schema }`, Anthropic's GA structured-outputs field
 *     (https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
 *     No beta header is required for the GA field.
 *
 * Any other `Api` value throws `UnsupportedApiError` rather than silently
 * sending an unconstrained request — see the HARD RULES in this repo's
 * README: no discretionary tool-call fallback, no faking constrained decode.
 */

export type JsonSchema = Record<string, unknown>;

export type ConstrainedOnPayload = (payload: unknown) => Record<string, unknown> | undefined;

const SUPPORTED_APIS = ["openai-completions", "anthropic-messages"] as const;
export type SupportedApi = (typeof SUPPORTED_APIS)[number];

export class UnsupportedApiError extends Error {
  constructor(api: string) {
    super(
      `Constrained decoding is not implemented for api "${api}". ` +
        `Supported: ${SUPPORTED_APIS.join(", ")}. ` +
        "See src/payload-injection.ts for the exact wire fields each one needs.",
    );
    this.name = "UnsupportedApiError";
  }
}

function isSupportedApi(api: string): api is SupportedApi {
  return (SUPPORTED_APIS as readonly string[]).includes(api);
}

/** Narrows an onPayload argument to a plain wire-body object; canonical guard for this package. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function injectOpenAIResponseFormat(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  return {
    ...payload,
    response_format: {
      type: "json_schema",
      json_schema: { name: "response", schema, strict: true },
    },
  };
}

function injectAnthropicOutputFormat(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const existingOutputConfig = isJsonObject(payload.output_config) ? payload.output_config : {};
  return {
    ...payload,
    output_config: {
      ...existingOutputConfig,
      format: { type: "json_schema", schema },
    },
  };
}

/**
 * Build the `onPayload` hook that constrains a completion to `schema` for
 * `api`. Throws {@link UnsupportedApiError} synchronously for any other api
 * so the caller fails before ever making a network request.
 */
export function buildConstrainedOnPayload(api: string, schema: JsonSchema): ConstrainedOnPayload {
  if (!isSupportedApi(api)) throw new UnsupportedApiError(api);
  const inject = api === "openai-completions" ? injectOpenAIResponseFormat : injectAnthropicOutputFormat;
  return (payload: unknown) => (isJsonObject(payload) ? inject(payload, schema) : undefined);
}
