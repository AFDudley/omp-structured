import { describe, expect, test } from "bun:test";
import { assembleTranscriptContext, parseMessagesJson, TranscriptValidationError } from "./transcript.js";

const MODEL = { api: "openai-completions", provider: "vllm", id: "qwen3.8-27b-ablit" };

describe("parseMessagesJson", () => {
  test("parses a valid user/assistant/user transcript", () => {
    const entries = parseMessagesJson(
      JSON.stringify([
        { role: "user", content: "remember the number 7" },
        { role: "assistant", content: "ok, 7" },
        { role: "user", content: "echo the number" },
      ]),
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ role: "user", content: "remember the number 7" });
    expect(entries[1]).toEqual({ role: "assistant", content: "ok, 7" });
  });

  test("accepts a leading system entry", () => {
    const entries = parseMessagesJson(
      JSON.stringify([{ role: "system", content: "be terse" }, { role: "user", content: "hi" }]),
    );
    expect(entries[0].role).toBe("system");
  });

  test("rejects invalid JSON", () => {
    expect(() => parseMessagesJson("not json")).toThrow(TranscriptValidationError);
  });

  test("rejects a non-array payload", () => {
    expect(() => parseMessagesJson(JSON.stringify({ role: "user", content: "hi" }))).toThrow(TranscriptValidationError);
  });

  test("rejects an empty array", () => {
    expect(() => parseMessagesJson("[]")).toThrow(TranscriptValidationError);
  });

  test("rejects an entry with a missing/invalid role", () => {
    expect(() => parseMessagesJson(JSON.stringify([{ role: "bogus", content: "hi" }]))).toThrow(TranscriptValidationError);
    expect(() => parseMessagesJson(JSON.stringify([{ content: "hi" }]))).toThrow(TranscriptValidationError);
  });

  test("rejects an entry with missing/empty content", () => {
    expect(() => parseMessagesJson(JSON.stringify([{ role: "user" }]))).toThrow(TranscriptValidationError);
    expect(() => parseMessagesJson(JSON.stringify([{ role: "user", content: "" }]))).toThrow(TranscriptValidationError);
    expect(() => parseMessagesJson(JSON.stringify([{ role: "user", content: "   " }]))).toThrow(TranscriptValidationError);
  });

  test("rejects a non-object entry", () => {
    expect(() => parseMessagesJson(JSON.stringify(["hi"]))).toThrow(TranscriptValidationError);
  });

  test('rejects "system" role anywhere but index 0', () => {
    expect(() =>
      parseMessagesJson(JSON.stringify([{ role: "user", content: "hi" }, { role: "system", content: "be terse" }])),
    ).toThrow(TranscriptValidationError);
  });
});

describe("assembleTranscriptContext", () => {
  test("converts user/assistant entries into typed messages in order", () => {
    const entries = parseMessagesJson(
      JSON.stringify([
        { role: "user", content: "remember the number 7" },
        { role: "assistant", content: "ok, 7" },
        { role: "user", content: "echo the number" },
      ]),
    );
    const assembled = assembleTranscriptContext(entries, undefined, MODEL);
    expect(assembled.messages).toHaveLength(3);
    expect(assembled.messages[0].role).toBe("user");
    expect(assembled.messages[1].role).toBe("assistant");
    expect(assembled.messages[2].role).toBe("user");
    expect(assembled.systemPrompt).toBeUndefined();
  });

  test("a leading system entry becomes systemPrompt, not a message", () => {
    const entries = parseMessagesJson(JSON.stringify([{ role: "system", content: "be terse" }, { role: "user", content: "hi" }]));
    const assembled = assembleTranscriptContext(entries, undefined, MODEL);
    expect(assembled.systemPrompt).toEqual(["be terse"]);
    expect(assembled.messages).toHaveLength(1);
    expect(assembled.messages[0].role).toBe("user");
  });

  test("--system-prompt and a transcript's own leading system entry both compose into systemPrompt, in that order", () => {
    const entries = parseMessagesJson(JSON.stringify([{ role: "system", content: "from transcript" }, { role: "user", content: "hi" }]));
    const assembled = assembleTranscriptContext(entries, "from --system-prompt", MODEL);
    expect(assembled.systemPrompt).toEqual(["from --system-prompt", "from transcript"]);
  });

  test("rejects a transcript that is only a system entry", () => {
    const entries = parseMessagesJson(JSON.stringify([{ role: "system", content: "be terse" }]));
    expect(() => assembleTranscriptContext(entries, undefined, MODEL)).toThrow(TranscriptValidationError);
  });

  test("a synthetic assistant message carries text content matching the transcript entry", () => {
    const entries = parseMessagesJson(
      JSON.stringify([{ role: "user", content: "q" }, { role: "assistant", content: "the answer is 7" }, { role: "user", content: "echo it" }]),
    );
    const assembled = assembleTranscriptContext(entries, undefined, MODEL);
    const assistantMessage = assembled.messages[1];
    expect(assistantMessage.role).toBe("assistant");
    if (assistantMessage.role === "assistant") {
      expect(assistantMessage.content).toEqual([{ type: "text", text: "the answer is 7" }]);
      expect(assistantMessage.stopReason).toBe("stop");
    }
  });
});
