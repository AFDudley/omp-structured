import { describe, expect, test } from "bun:test";
import { buildConstrainedOnPayload, UnsupportedApiError } from "./payload-injection.js";

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
