import { describe, expect, test } from "bun:test";
import {
  apiSupportsSeed,
  apiSupportsTemperature,
  buildConstrainedOnPayload,
  buildDecodingOnPayload,
  readWireBudget,
  readWireDecoding,
  UnhonorableDecodingError,
  UnsupportedApiError,
} from "./payload-injection.js";

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

describe("openai-completions (live-verified against real vLLM)", () => {
  test("merges response_format onto the flat chat-completions body", () => {
    const onPayload = buildConstrainedOnPayload("openai-completions", SCHEMA);
    const result = onPayload({ model: "qwen3.8", messages: [] });
    expect(result).toEqual({
      model: "qwen3.8",
      messages: [],
      response_format: { type: "json_schema", json_schema: { name: "response", schema: SCHEMA, strict: true } },
    });
  });
});

describe("anthropic-messages (live-verified against real Anthropic)", () => {
  test("merges output_config.format without clobbering an existing output_config.effort", () => {
    const onPayload = buildConstrainedOnPayload("anthropic-messages", SCHEMA);
    const result = onPayload({ model: "claude-sonnet-5", messages: [], output_config: { effort: "medium" } });
    expect(result).toEqual({
      model: "claude-sonnet-5",
      messages: [],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    });
  });
});

describe("openai-responses family (schema-verified only: no live creds for any of the three)", () => {
  for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
    test(`${api}: merges text.format onto the Responses-API body without clobbering text.verbosity`, () => {
      const onPayload = buildConstrainedOnPayload(api, SCHEMA);
      const result = onPayload({ model: "gpt-5", input: [], text: { verbosity: "low" } });
      expect(result).toEqual({
        model: "gpt-5",
        input: [],
        text: {
          verbosity: "low",
          format: { type: "json_schema", name: "response", schema: SCHEMA, strict: true },
        },
      });
    });
  }
});

describe("openrouter (schema-verified only): the wire shape is structurally ambiguous at the api-discriminant level", () => {
  test("a payload carrying `input` (the Responses shape) gets text.format", () => {
    const onPayload = buildConstrainedOnPayload("openrouter", SCHEMA);
    const result = onPayload({ model: "anthropic/claude", input: [] });
    expect(result).toEqual({
      model: "anthropic/claude",
      input: [],
      text: { format: { type: "json_schema", name: "response", schema: SCHEMA, strict: true } },
    });
  });

  test("a payload carrying `messages` (the Completions shape) gets response_format", () => {
    const onPayload = buildConstrainedOnPayload("openrouter", SCHEMA);
    const result = onPayload({ model: "anthropic/claude", messages: [] });
    expect(result).toEqual({
      model: "anthropic/claude",
      messages: [],
      response_format: { type: "json_schema", json_schema: { name: "response", schema: SCHEMA, strict: true } },
    });
  });
});

describe("google-generative-ai / google-vertex (schema-verified only)", () => {
  for (const api of ["google-generative-ai", "google-vertex"]) {
    test(`${api}: injects onto payload.config (the SDK-shaped GenerateContentParameters onPayload actually sees), not top-level generationConfig`, () => {
      const onPayload = buildConstrainedOnPayload(api, SCHEMA);
      const result = onPayload({ model: "gemini-3", contents: [], config: { temperature: 0.5 } });
      expect(result).toEqual({
        model: "gemini-3",
        contents: [],
        config: { temperature: 0.5, responseMimeType: "application/json", responseJsonSchema: SCHEMA },
      });
    });
  }
});

describe("google-gemini-cli (schema-verified only)", () => {
  test("injects onto payload.request.generationConfig (the CloudCodeAssistRequest shape), not top-level generationConfig", () => {
    const onPayload = buildConstrainedOnPayload("google-gemini-cli", SCHEMA);
    const result = onPayload({ project: "p", model: "gemini-3", request: { contents: [], generationConfig: { temperature: 0.5 } } });
    expect(result).toEqual({
      project: "p",
      model: "gemini-3",
      request: {
        contents: [],
        generationConfig: { temperature: 0.5, responseMimeType: "application/json", responseJsonSchema: SCHEMA },
      },
    });
  });
});

describe("ollama-chat (schema-verified only)", () => {
  test("sets the top-level `format` field to the raw schema object", () => {
    const onPayload = buildConstrainedOnPayload("ollama-chat", SCHEMA);
    const result = onPayload({ model: "qwen3.8", messages: [] });
    expect(result).toEqual({ model: "qwen3.8", messages: [], format: SCHEMA });
  });
});

describe("bedrock-converse-stream (schema-verified only)", () => {
  test("sets outputConfig.textFormat with the schema JSON-stringified (per AWS's own documented wire shape)", () => {
    const onPayload = buildConstrainedOnPayload("bedrock-converse-stream", SCHEMA);
    const result = onPayload({ messages: [] }) as Record<string, unknown>;
    expect(result.messages).toEqual([]);
    const outputConfig = result.outputConfig as { textFormat: { type: string; structure: { jsonSchema: { name: string; schema: string } } } };
    expect(outputConfig.textFormat.type).toBe("json_schema");
    expect(outputConfig.textFormat.structure.jsonSchema.name).toBe("response");
    expect(typeof outputConfig.textFormat.structure.jsonSchema.schema).toBe("string");
    expect(JSON.parse(outputConfig.textFormat.structure.jsonSchema.schema)).toEqual(SCHEMA);
  });
});

describe("families with no documented structured-output wire field", () => {
  for (const api of ["cursor-agent", "gitlab-duo-agent", "devin-agent", "mock"]) {
    test(`${api}: buildConstrainedOnPayload throws UnsupportedApiError before any request is built`, () => {
      expect(() => buildConstrainedOnPayload(api, SCHEMA)).toThrow(UnsupportedApiError);
    });
  }
});

describe("non-object payloads", () => {
  test("onPayload returns undefined (no replacement) for a non-object payload, never throws", () => {
    const onPayload = buildConstrainedOnPayload("openai-completions", SCHEMA);
    expect(onPayload("not an object")).toBeUndefined();
    expect(onPayload(null)).toBeUndefined();
    expect(onPayload([1, 2, 3])).toBeUndefined();
  });
});

describe("pinned decoding: temperature + seed wire injection", () => {
  test("openai-completions carries both temperature and seed flat on the chat-completions body", () => {
    const onPayload = buildDecodingOnPayload("openai-completions", { temperature: 0.2, seed: 7 });
    expect(onPayload({ model: "qwen3.8", messages: [] })).toEqual({
      model: "qwen3.8",
      messages: [],
      temperature: 0.2,
      seed: 7,
    });
  });

  test("temperature 0 is injected, not skipped as a falsy value (the pinned-judge case)", () => {
    const onPayload = buildDecodingOnPayload("openai-completions", { temperature: 0, seed: 0 });
    expect(onPayload({ messages: [] })).toEqual({ messages: [], temperature: 0, seed: 0 });
  });

  test("anthropic-messages carries temperature flat (per-model honorability is the caller's check, not this layer's)", () => {
    const onPayload = buildDecodingOnPayload("anthropic-messages", { temperature: 0.5, seed: undefined });
    expect(onPayload({ model: "claude", messages: [] })).toEqual({ model: "claude", messages: [], temperature: 0.5 });
  });

  test("google-generative-ai/vertex place temperature and seed under config (lifted to generationConfig on the wire)", () => {
    for (const api of ["google-generative-ai", "google-vertex"]) {
      const onPayload = buildDecodingOnPayload(api, { temperature: 0.3, seed: 11 });
      expect(onPayload({ model: "gemini-3", config: { topP: 0.9 } })).toEqual({
        model: "gemini-3",
        config: { topP: 0.9, temperature: 0.3, seed: 11 },
      });
    }
  });

  test("google-gemini-cli places them under request.generationConfig", () => {
    const onPayload = buildDecodingOnPayload("google-gemini-cli", { temperature: 0.3, seed: 11 });
    expect(onPayload({ project: "p", request: { contents: [] } })).toEqual({
      project: "p",
      request: { contents: [], generationConfig: { temperature: 0.3, seed: 11 } },
    });
  });

  test("ollama-chat places them under options", () => {
    const onPayload = buildDecodingOnPayload("ollama-chat", { temperature: 0.3, seed: 11 });
    expect(onPayload({ model: "qwen3.8", options: { num_predict: 100 } })).toEqual({
      model: "qwen3.8",
      options: { num_predict: 100, temperature: 0.3, seed: 11 },
    });
  });

  test("bedrock places temperature under inferenceConfig; it has no seed field", () => {
    const onPayload = buildDecodingOnPayload("bedrock-converse-stream", { temperature: 0.3, seed: undefined });
    expect(onPayload({ messages: [] })).toEqual({ messages: [], inferenceConfig: { temperature: 0.3 } });
  });

  test("a set seed against an api whose wire has no seed field fails loud (never silently dropped)", () => {
    for (const api of ["anthropic-messages", "openai-responses", "openrouter", "bedrock-converse-stream"]) {
      expect(() => buildDecodingOnPayload(api, { temperature: undefined, seed: 5 })).toThrow(UnhonorableDecodingError);
    }
  });

  test("apiSupportsSeed / apiSupportsTemperature report the wire-field table", () => {
    expect(apiSupportsSeed("openai-completions")).toBe(true);
    expect(apiSupportsSeed("ollama-chat")).toBe(true);
    expect(apiSupportsSeed("anthropic-messages")).toBe(false);
    expect(apiSupportsSeed("openrouter")).toBe(false);
    expect(apiSupportsTemperature("anthropic-messages")).toBe(true);
    expect(apiSupportsTemperature("cursor-agent")).toBe(false);
  });

  test("no controls set is an identity injection", () => {
    const onPayload = buildDecodingOnPayload("anthropic-messages", { temperature: undefined, seed: undefined });
    expect(onPayload({ model: "claude", messages: [] })).toEqual({ model: "claude", messages: [] });
  });
});

describe("truthful output budget: readWireBudget reads the real number on the wire", () => {
  test("anthropic max_tokens is read verbatim (this is the OAuth-clamped number, e.g. 64000 while model.maxTokens=128000)", () => {
    expect(readWireBudget("anthropic-messages", { max_tokens: 64000 })).toEqual({ value: 64000, field: "max_tokens" });
  });

  test("openai-completions falls back from max_tokens to max_completion_tokens", () => {
    expect(readWireBudget("openai-completions", { max_completion_tokens: 8192 }).value).toBe(8192);
    expect(readWireBudget("openai-completions", { max_tokens: 4096 }).value).toBe(4096);
  });

  test("responses family reads max_output_tokens; google/ollama/bedrock read their nested fields", () => {
    expect(readWireBudget("openai-responses", { max_output_tokens: 2000 }).value).toBe(2000);
    expect(readWireBudget("google-vertex", { config: { maxOutputTokens: 1000 } }).value).toBe(1000);
    expect(readWireBudget("ollama-chat", { options: { num_predict: 512 } }).value).toBe(512);
    expect(readWireBudget("bedrock-converse-stream", { inferenceConfig: { maxTokens: 300 } }).value).toBe(300);
  });

  test("a wire body with no budget field reports value undefined (a genuinely uncapped request), never a fabricated number", () => {
    expect(readWireBudget("anthropic-messages", { messages: [] }).value).toBeUndefined();
  });

  test("readWireDecoding is the symmetric read of what buildDecodingOnPayload wrote", () => {
    const wire = buildDecodingOnPayload("openai-completions", { temperature: 0, seed: 9 })({ messages: [] }) as Record<string, unknown>;
    expect(readWireDecoding("openai-completions", wire)).toEqual({ temperature: 0, seed: 9 });
  });
});
