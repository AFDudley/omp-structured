/**
 * Constrained-decoding wire injection.
 *
 * omp's `SimpleStreamOptions` (packages/ai/src/types.ts) has no first-class
 * `response_format`/structured-output field for ANY api family - the real
 * cross-provider completion path never builds one. The documented,
 * first-class extension point for this is `onPayload` (`SimpleStreamOptions
 * .onPayload` / packages/ai README "onPayload" section): a hook invoked with
 * the exact request payload immediately before it is sent, whose return
 * value replaces that payload. Every built-in provider except `devin-agent`
 * honors it.
 *
 * This module injects the provider-native structured-output field for EVERY
 * omp `api` discriminant that has one, keyed off the exact same
 * `KnownApi` union omp itself switches on
 * (`@oh-my-pi/pi-catalog/types.ts`):
 *
 *   openai-completions       -> response_format: {type:"json_schema", json_schema:{name,schema,strict}}
 *   openai-responses          |
 *   openai-codex-responses    |-> text: {format: {type:"json_schema", name, schema, strict}}
 *   azure-openai-responses    |   (all three share the literal ResponseCreateParamsStreaming wire
 *                                  shape - verified in openai-responses-wire.ts / azure-openai-responses.ts)
 *   openrouter                -> ambiguous at the api-discriminant level (see below); detected
 *                                 structurally from the payload's own shape
 *   anthropic-messages        -> output_config.format: {type:"json_schema", schema}
 *   bedrock-converse-stream   -> outputConfig.textFormat: {type:"json_schema", structure:{jsonSchema:{schema, name}}}
 *                                 (schema is a JSON-encoded STRING here, not a nested object - see below)
 *   google-generative-ai      |
 *   google-vertex              |-> config.{responseMimeType:"application/json", responseJsonSchema: schema}
 *   google-gemini-cli          -> request.generationConfig.{responseMimeType:"application/json", responseJsonSchema: schema}
 *   ollama-chat               -> format: schema (top-level, Ollama's own documented structured-output field)
 *
 * Families with no documented structured-output wire field at all -
 * `cursor-agent`, `gitlab-duo-agent`, `devin-agent` (agentic/terminal-driving
 * transports, not a JSON completion API), plus the SDK-internal `mock` api -
 * throw {@link UnsupportedApiError} rather than silently sending an
 * unconstrained request. See this repo's README for which of the mappings
 * above are live-verified against a real backend versus schema-verified only
 * (asserted by src/payload-injection.test.ts against the exact wire shape
 * read from the installed `@oh-my-pi/pi-ai@18.2.8` provider source).
 *
 * --- Why `onPayload`'s SECOND argument (the resolved `model`) is not used to
 * key any of this ---
 *
 * `onPayload`'s signature is `(payload: unknown, model?: Model<Api>) => ...`
 * (packages/ai/src/types.ts). One might expect `model.api` on that second
 * argument to always equal the api this module was built for. It does NOT
 * for `openrouter`: `packages/ai/src/stream.ts` resolves an `openrouter`
 * model's per-request options via `castApi<"openai-responses">(...)` or
 * `castApi<"openai-completions">(...)` depending on
 * `$env.PI_OPENROUTER_RESPONSES`, and `castApi` is a **type-only** cast
 * (`api as OptionsForApi<Api>`) - `model.api` on the actual runtime object
 * passed to `onPayload` is still the literal string `"openrouter"` either
 * way. So the two possible wire shapes cannot be told apart from `model.api`
 * at all; `injectOpenRouter` below detects the shape structurally from the
 * payload's own top-level keys instead (`input` => Responses wire, `messages`
 * => Completions wire - the two shapes never share either key).
 *
 * --- Why Google's injection lands on `payload.config`, not top-level
 * `generationConfig` ---
 *
 * `packages/ai/src/providers/google-shared.ts`'s `onPayload` call
 * (`streamGoogleGenAI`) fires on the SDK-shaped `GenerateContentParameters`
 * object (`{model, contents, config}`) *before* `paramsToWireBody(params)`
 * later lifts `params.config`'s fields onto the literal `generationConfig`
 * wire key that actually reaches the REST API. Injecting onto
 * `payload.config` is therefore what actually reaches the wire as
 * `generationConfig.{responseMimeType,responseJsonSchema}`; injecting a
 * top-level `generationConfig` key directly would be silently dropped by
 * `paramsToWireBody`, which never reads it. `google-vertex` shares this exact
 * code path (`google-vertex.ts` calls the same `streamGoogleGenAI`/
 * `buildGoogleGenerateContentParams`), so it gets the same treatment.
 * `google-gemini-cli` is NOT routed through `google-shared.ts` (its
 * `CloudCodeAssistRequest` body has a distinct `{project, model, request:
 * {generationConfig, ...}}` top-level shape - see
 * `providers/google-gemini-cli.ts`'s own `onPayload` call site), so it gets
 * its own injector that reaches into `payload.request.generationConfig`.
 *
 * `responseJsonSchema` (not the older, OpenAPI-3.0-subset `responseSchema`)
 * is used because it is the field documented to accept an arbitrary JSON
 * Schema (`$ref`, `oneOf`, etc.) - the caller-supplied schema this CLI is
 * given is exactly that, not a hand-restricted OpenAPI subset.
 *
 * --- Bedrock's `schema` field is a JSON string, not a nested object ---
 *
 * Per AWS's own structured-output documentation
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html,
 * "JSON Schema output format" > "Converse API" example), the Converse API's
 * `outputConfig.textFormat.structure.jsonSchema.schema` field is a
 * JSON-encoded STRING (`"schema": "{\"type\": \"object\", ...}"`), unlike
 * every other provider in this module where `schema` is a nested object.
 * This is asserted explicitly in payload-injection.test.ts.
 */

export type JsonSchema = Record<string, unknown>;

export type ConstrainedOnPayload = (payload: unknown) => Record<string, unknown> | undefined;

/** Wire-body object shape guard; narrows an onPayload argument to a plain object. Canonical guard for this package. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Api` values with no documented structured-output wire field (agentic/terminal transports, plus the SDK's own `mock` provider). */
const UNSUPPORTED_APIS = ["cursor-agent", "gitlab-duo-agent", "devin-agent", "mock"] as const;

export class UnsupportedApiError extends Error {
  constructor(api: string) {
    super(
      `Constrained decoding is not implemented for api "${api}": it has no documented structured-output ` +
        `wire field (verified against @oh-my-pi/pi-ai@18.2.8's provider source; see src/payload-injection.ts). ` +
        "Sending an unconstrained request would silently drop the schema contract, so this throws instead of falling back.",
    );
    this.name = "UnsupportedApiError";
  }
}

const RESPONSE_FORMAT_NAME = "response";

/** openai-completions (vLLM and any OpenAI Chat Completions-compatible endpoint). Live-verified against real vLLM. */
function injectOpenAICompletionsResponseFormat(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  return {
    ...payload,
    response_format: {
      type: "json_schema",
      json_schema: { name: RESPONSE_FORMAT_NAME, schema, strict: true },
    },
  };
}

/** anthropic-messages (Claude API). Live-verified against real Anthropic. */
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

/** openai-responses / openai-codex-responses / azure-openai-responses: shared `ResponseCreateParamsStreaming` wire shape. Schema-verified only (no live creds for any of the three). */
function injectOpenAIResponsesTextFormat(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const existingText = isJsonObject(payload.text) ? payload.text : {};
  return {
    ...payload,
    text: {
      ...existingText,
      format: { type: "json_schema", name: RESPONSE_FORMAT_NAME, schema, strict: true },
    },
  };
}

/** openrouter: structural detection of the two wire shapes it can produce - see header doc. Schema-verified only. */
function injectOpenRouter(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  if ("input" in payload) return injectOpenAIResponsesTextFormat(payload, schema);
  return injectOpenAICompletionsResponseFormat(payload, schema);
}

/** google-generative-ai / google-vertex: onPayload sees the SDK-shaped GenerateContentParameters - see header doc. Schema-verified only. */
function injectGoogleGenerateContentConfig(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const existingConfig = isJsonObject(payload.config) ? payload.config : {};
  return {
    ...payload,
    config: {
      ...existingConfig,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  };
}

/** google-gemini-cli: distinct {project, model, request:{generationConfig}} wire shape - see header doc. Schema-verified only. */
function injectGoogleGeminiCliGenerationConfig(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const existingRequest = isJsonObject(payload.request) ? payload.request : {};
  const existingGenerationConfig = isJsonObject(existingRequest.generationConfig) ? existingRequest.generationConfig : {};
  return {
    ...payload,
    request: {
      ...existingRequest,
      generationConfig: {
        ...existingGenerationConfig,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      },
    },
  };
}

/** ollama-chat: Ollama's own documented top-level `format` field (a raw JSON Schema object, or the string "json"). Schema-verified only. */
function injectOllamaFormat(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  return { ...payload, format: schema };
}

/** bedrock-converse-stream: Converse API `outputConfig.textFormat` - see header doc for the stringified-schema caveat. Schema-verified only. */
function injectBedrockOutputConfig(payload: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  return {
    ...payload,
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: { name: RESPONSE_FORMAT_NAME, schema: JSON.stringify(schema) },
        },
      },
    },
  };
}

type Injector = (payload: Record<string, unknown>, schema: JsonSchema) => Record<string, unknown>;

/** Every `KnownApi` value with a documented structured-output wire field. Exhaustive: 11 of the 14 `KnownApi` entries; the remaining 3 (`cursor-agent`, `gitlab-duo-agent`, `devin-agent`) are in {@link UNSUPPORTED_APIS}. */
const INJECTORS: Record<string, Injector> = {
  "openai-completions": injectOpenAICompletionsResponseFormat,
  "anthropic-messages": injectAnthropicOutputFormat,
  "openai-responses": injectOpenAIResponsesTextFormat,
  "openai-codex-responses": injectOpenAIResponsesTextFormat,
  "azure-openai-responses": injectOpenAIResponsesTextFormat,
  openrouter: injectOpenRouter,
  "google-generative-ai": injectGoogleGenerateContentConfig,
  "google-vertex": injectGoogleGenerateContentConfig,
  "google-gemini-cli": injectGoogleGeminiCliGenerationConfig,
  "ollama-chat": injectOllamaFormat,
  "bedrock-converse-stream": injectBedrockOutputConfig,
};

/**
 * Build the `onPayload` hook that constrains a completion to `schema` for
 * `api`. Throws {@link UnsupportedApiError} synchronously for any api with no
 * documented structured-output field so the caller fails before ever making
 * a network request. Keyed exactly off the resolved model's `api`
 * discriminant, matching how omp itself dispatches (`packages/ai/src/stream.ts`).
 */
export function buildConstrainedOnPayload(api: string, schema: JsonSchema): ConstrainedOnPayload {
  if ((UNSUPPORTED_APIS as readonly string[]).includes(api)) throw new UnsupportedApiError(api);
  const inject = INJECTORS[api];
  if (!inject) throw new UnsupportedApiError(api);
  return (payload: unknown) => (isJsonObject(payload) ? inject(payload, schema) : undefined);
}

// ─── pinned decoding: temperature + seed wire injection ──────────────────────
//
// Same mechanism and the same `KnownApi` discriminant as the structured-output
// injectors above: omp's `SimpleStreamOptions` carries a cross-provider
// `temperature` but NO `seed` for any family, and even `temperature` is dropped
// by the anthropic provider for models that deprecated sampling params
// (`compat.supportsSamplingParams === false`), so a caller pinning a judge's
// decoding cannot rely on `SimpleStreamOptions`. Injecting both onto the exact
// outgoing wire body via `onPayload` is the one mechanism that both reaches the
// provider AND is inspectable on the wire. Where a family's request wire has no
// seed field at all, {@link apiSupportsSeed} is false and the CLI fails loud
// naming the provider rather than silently dropping the pin.

/** Places a single numeric decoding field (`temperature`/`seed`) onto a wire body. */
type NumberInjector = (payload: Record<string, unknown>, value: number) => Record<string, unknown>;

/** The pinned decoding controls a caller can set. `undefined` means unset (not pinned). */
export interface DecodingRequest {
  temperature: number | undefined;
  seed: number | undefined;
}

/** A pinned decoding control the resolved provider/model cannot honor. Thrown so the CLI fails loud (never sends an unpinned request). */
export class UnhonorableDecodingError extends Error {
  constructor(api: string, setting: "temperature" | "seed", reason: string) {
    super(
      `The resolved provider/model cannot honor a pinned --${setting} (api "${api}"): ${reason}. ` +
        "Refusing to send the request: a pinned decoding setting silently dropped is not pinned " +
        "(see docs and src/payload-injection.ts).",
    );
    this.name = "UnhonorableDecodingError";
  }
}

function injectFlat(key: string): NumberInjector {
  return (payload, value) => ({ ...payload, [key]: value });
}

/** Places `value` at `payload[outer][inner]`, preserving any existing sibling keys under `outer`. */
function injectNested(outer: string, inner: string): NumberInjector {
  return (payload, value) => {
    const existing = isJsonObject(payload[outer]) ? payload[outer] : {};
    return { ...payload, [outer]: { ...existing, [inner]: value } };
  };
}

/** Places `value` at `payload[a][b][c]` (google-gemini-cli's `request.generationConfig.*` shape). */
function injectNested2(a: string, b: string, c: string): NumberInjector {
  return (payload, value) => {
    const outer = isJsonObject(payload[a]) ? payload[a] : {};
    const middle = isJsonObject(outer[b]) ? outer[b] : {};
    return { ...payload, [a]: { ...outer, [b]: { ...middle, [c]: value } } };
  };
}

/** Where each api family carries `temperature` on its wire body. Every supported api HAS a temperature field; whether a given MODEL still accepts it (anthropic/OpenAI models that deprecated sampling params) is `model.compat.supportsSamplingParams`, decided by the caller — see cli.ts. */
const TEMPERATURE_INJECTORS: Record<string, NumberInjector> = {
  "openai-completions": injectFlat("temperature"),
  "anthropic-messages": injectFlat("temperature"),
  "openai-responses": injectFlat("temperature"),
  "openai-codex-responses": injectFlat("temperature"),
  "azure-openai-responses": injectFlat("temperature"),
  openrouter: injectFlat("temperature"),
  "google-generative-ai": injectNested("config", "temperature"),
  "google-vertex": injectNested("config", "temperature"),
  "google-gemini-cli": injectNested2("request", "generationConfig", "temperature"),
  "ollama-chat": injectNested("options", "temperature"),
  "bedrock-converse-stream": injectNested("inferenceConfig", "temperature"),
};

/** Where each api family carries a sampling `seed`, or `null` when its request wire has no seed field. `openrouter` is `null` on purpose: its wire shape is chosen at runtime from `PI_OPENROUTER_RESPONSES` and the Responses shape has no seed, so a seed cannot be statically guaranteed to reach the provider — the honest choice is to fail loud rather than sometimes drop it. */
const SEED_INJECTORS: Record<string, NumberInjector | null> = {
  "openai-completions": injectFlat("seed"),
  "anthropic-messages": null,
  "openai-responses": null,
  "openai-codex-responses": null,
  "azure-openai-responses": null,
  openrouter: null,
  "google-generative-ai": injectNested("config", "seed"),
  "google-vertex": injectNested("config", "seed"),
  "google-gemini-cli": injectNested2("request", "generationConfig", "seed"),
  "ollama-chat": injectNested("options", "seed"),
  "bedrock-converse-stream": null,
};

/** True iff `api`'s request wire has a `temperature` field at all (every supported api does). */
export function apiSupportsTemperature(api: string): boolean {
  return api in TEMPERATURE_INJECTORS;
}

/** True iff `api`'s request wire has a `seed` field this CLI can inject onto. */
export function apiSupportsSeed(api: string): boolean {
  return SEED_INJECTORS[api] != null;
}

/**
 * Build an `onPayload` hook that injects the pinned decoding controls onto the
 * exact outgoing wire body for `api`. Throws {@link UnhonorableDecodingError}
 * synchronously if a SET control has no wire field for this api, so the caller
 * fails before any network request. Temperature's per-MODEL honorability
 * (anthropic/OpenAI sampling-param deprecation) is the caller's check (cli.ts);
 * this function only knows the api-level wire shape.
 */
export function buildDecodingOnPayload(api: string, decoding: DecodingRequest): ConstrainedOnPayload {
  const steps: Array<(payload: Record<string, unknown>) => Record<string, unknown>> = [];
  if (decoding.temperature !== undefined) {
    const inject = TEMPERATURE_INJECTORS[api];
    if (!inject) throw new UnhonorableDecodingError(api, "temperature", "this api has no temperature wire field");
    const value = decoding.temperature;
    steps.push(payload => inject(payload, value));
  }
  if (decoding.seed !== undefined) {
    const inject = SEED_INJECTORS[api];
    if (!inject) throw new UnhonorableDecodingError(api, "seed", "this api's request wire has no seed field");
    const value = decoding.seed;
    steps.push(payload => inject(payload, value));
  }
  return (payload: unknown) => {
    if (!isJsonObject(payload)) return undefined;
    let body = payload;
    for (const step of steps) body = step(body);
    return body;
  };
}

// ─── truthful output budget: read the number actually on the wire ────────────

/** The resolved output-token budget as it actually appears on the outgoing wire body — the real number sent, including any provider-SDK fallback/clamp the caller never set (e.g. anthropic's OAuth clamp to CLAUDE_CODE_MAX_OUTPUT_TOKENS). `value` is `undefined` only when the wire genuinely carries no output cap. `field` names the wire key inspected. */
export interface WireBudget {
  value: number | undefined;
  field: string;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nested(payload: Record<string, unknown>, outer: string, inner: string): number | undefined {
  return isJsonObject(payload[outer]) ? readNumber(payload[outer][inner]) : undefined;
}

/** Read the output-token budget field from `payload` for `api`. This is the ground-truth "budget actually sent": whatever the SDK put on the wire after its own resolution, so "source=unset" can never hide a provider fallback cap. */
export function readWireBudget(api: string, payload: Record<string, unknown>): WireBudget {
  switch (api) {
    case "anthropic-messages":
      return { value: readNumber(payload.max_tokens), field: "max_tokens" };
    case "openai-completions":
      return {
        value: readNumber(payload.max_tokens) ?? readNumber(payload.max_completion_tokens),
        field: "max_tokens/max_completion_tokens",
      };
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      return { value: readNumber(payload.max_output_tokens), field: "max_output_tokens" };
    case "openrouter":
      return "input" in payload
        ? { value: readNumber(payload.max_output_tokens), field: "max_output_tokens" }
        : {
            value: readNumber(payload.max_tokens) ?? readNumber(payload.max_completion_tokens),
            field: "max_tokens/max_completion_tokens",
          };
    case "google-generative-ai":
    case "google-vertex":
      return { value: nested(payload, "config", "maxOutputTokens"), field: "config.maxOutputTokens" };
    case "google-gemini-cli": {
      const request = isJsonObject(payload.request) ? payload.request : {};
      return {
        value: nested(request, "generationConfig", "maxOutputTokens"),
        field: "request.generationConfig.maxOutputTokens",
      };
    }
    case "ollama-chat":
      return { value: nested(payload, "options", "num_predict"), field: "options.num_predict" };
    case "bedrock-converse-stream":
      return { value: nested(payload, "inferenceConfig", "maxTokens"), field: "inferenceConfig.maxTokens" };
    default:
      return { value: undefined, field: "(unknown api)" };
  }
}

/** The pinned decoding controls as they actually sit on the outgoing wire body for `api` — the symmetric read of {@link buildDecodingOnPayload}'s writes, so "the decoding reaching the provider" is inspectable (stderr log) rather than merely trusted. */
export function readWireDecoding(api: string, payload: Record<string, unknown>): DecodingRequest {
  switch (api) {
    case "openai-completions":
      return { temperature: readNumber(payload.temperature), seed: readNumber(payload.seed) };
    case "anthropic-messages":
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
    case "openrouter":
      return { temperature: readNumber(payload.temperature), seed: readNumber(payload.seed) };
    case "google-generative-ai":
    case "google-vertex":
      return { temperature: nested(payload, "config", "temperature"), seed: nested(payload, "config", "seed") };
    case "google-gemini-cli": {
      const request = isJsonObject(payload.request) ? payload.request : {};
      return {
        temperature: nested(request, "generationConfig", "temperature"),
        seed: nested(request, "generationConfig", "seed"),
      };
    }
    case "ollama-chat":
      return { temperature: nested(payload, "options", "temperature"), seed: nested(payload, "options", "seed") };
    case "bedrock-converse-stream":
      return { temperature: nested(payload, "inferenceConfig", "temperature"), seed: undefined };
    default:
      return { temperature: undefined, seed: undefined };
  }
}
