import { describe, expect, test } from "bun:test";
import { CliArgError, parseArgs } from "./args.js";

const BASE = ["--model", "vllm/qwen3.8-27b-ablit", "--json-schema", "schema.json"];

describe("required arguments", () => {
  test("--model and --json-schema are required", () => {
    expect(() => parseArgs([])).toThrow(CliArgError);
    expect(() => parseArgs(["--model", "vllm/qwen3.8-27b-ablit"])).toThrow(CliArgError);
    expect(() => parseArgs(["--json-schema", "schema.json"])).toThrow(CliArgError);
  });

  test("minimal valid invocation parses with defaults", () => {
    const args = parseArgs(BASE);
    expect(args.model).toBe("vllm/qwen3.8-27b-ablit");
    expect(args.jsonSchemaPath).toBe("schema.json");
    expect(args.promptPath).toBeUndefined();
    expect(args.messagesPath).toBeUndefined();
    expect(args.systemPromptPath).toBeUndefined();
    expect(args.reasoning).toBeUndefined();
    expect(args.session).toBe(false);
  });
});

describe("--prompt / --messages mutual exclusion", () => {
  test("--prompt alone is accepted", () => {
    const args = parseArgs([...BASE, "--prompt", "p.txt"]);
    expect(args.promptPath).toBe("p.txt");
    expect(args.messagesPath).toBeUndefined();
  });

  test("--messages alone is accepted", () => {
    const args = parseArgs([...BASE, "--messages", "m.json"]);
    expect(args.messagesPath).toBe("m.json");
    expect(args.promptPath).toBeUndefined();
  });

  test("both --prompt and --messages is rejected", () => {
    expect(() => parseArgs([...BASE, "--prompt", "p.txt", "--messages", "m.json"])).toThrow(CliArgError);
    expect(() => parseArgs([...BASE, "--messages", "m.json", "--prompt", "p.txt"])).toThrow(CliArgError);
  });

  test("both given as `-` is still rejected (mutual exclusion is on flag presence, not path value)", () => {
    expect(() => parseArgs([...BASE, "--prompt", "-", "--messages", "-"])).toThrow(CliArgError);
  });

  test("neither given leaves both undefined (default: read prompt from stdin, decided by the caller)", () => {
    const args = parseArgs(BASE);
    expect(args.promptPath).toBeUndefined();
    expect(args.messagesPath).toBeUndefined();
  });
});

describe("--system-prompt", () => {
  test("parses independently of --prompt/--messages", () => {
    const args = parseArgs([...BASE, "--system-prompt", "sys.txt", "--prompt", "p.txt"]);
    expect(args.systemPromptPath).toBe("sys.txt");
    expect(args.promptPath).toBe("p.txt");
  });

  test("accepts `-` for stdin", () => {
    const args = parseArgs([...BASE, "--system-prompt", "-"]);
    expect(args.systemPromptPath).toBe("-");
  });
});

describe("--reasoning enum", () => {
  for (const value of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    test(`accepts "${value}"`, () => {
      const args = parseArgs([...BASE, "--reasoning", value]);
      expect(args.reasoning).toBe(value as (typeof args)["reasoning"]);
    });
  }

  test("rejects an unsupported value", () => {
    expect(() => parseArgs([...BASE, "--reasoning", "bogus"])).toThrow(CliArgError);
  });

  test('rejects "auto": not a member of the SDK Effort enum (verified against @oh-my-pi/pi-catalog/src/effort.ts)', () => {
    expect(() => parseArgs([...BASE, "--reasoning", "auto"])).toThrow(CliArgError);
  });

  test("omitted --reasoning leaves reasoning undefined (cli.ts applies the existing Effort.Medium default)", () => {
    const args = parseArgs(BASE);
    expect(args.reasoning).toBeUndefined();
  });
});

describe("--max-tokens", () => {
  test("omitted leaves maxTokens undefined (cli.ts derives it from the resolved model.maxTokens)", () => {
    expect(parseArgs(BASE).maxTokens).toBeUndefined();
  });

  test("a positive integer is parsed as the override budget", () => {
    expect(parseArgs([...BASE, "--max-tokens", "16384"]).maxTokens).toBe(16384);
  });

  test("zero and negative and non-integer values are rejected", () => {
    expect(() => parseArgs([...BASE, "--max-tokens", "0"])).toThrow(CliArgError);
    expect(() => parseArgs([...BASE, "--max-tokens", "-1"])).toThrow(CliArgError);
    expect(() => parseArgs([...BASE, "--max-tokens", "1.5"])).toThrow(CliArgError);
  });
});

describe("existing flags still parse (no regression)", () => {
  test("--cwd, --profile, --session, --timeout, --print-session-id", () => {
    const args = parseArgs([
      ...BASE,
      "--cwd",
      "/tmp/x",
      "--profile",
      "myprofile",
      "--session",
      "--timeout",
      "30",
      "--print-session-id",
    ]);
    expect(args.cwd).toBe("/tmp/x");
    expect(args.profile).toBe("myprofile");
    expect(args.session).toBe(true);
    expect(args.timeoutSeconds).toBe(30);
    expect(args.printSessionId).toBe(true);
  });

  test("unknown argument is rejected", () => {
    expect(() => parseArgs([...BASE, "--bogus-flag"])).toThrow(CliArgError);
  });
});
