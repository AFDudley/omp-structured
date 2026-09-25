/** Reasoning-effort choices this CLI's --reasoning flag accepts. Runtime string values are
 * identical to `@oh-my-pi/pi-catalog/effort`'s `Effort` const enum members ("minimal".."max"),
 * plus "off" (this CLI's own vocabulary: maps to `disableReasoning: true` on the completion
 * options - see cli.ts). There is no "auto": `Effort` (the SDK's complete reasoning-effort
 * vocabulary, verified by reading `@oh-my-pi/pi-catalog/src/effort.ts`) has no such member, and
 * no other SDK reasoning field (`SimpleStreamOptions`, `model-thinking.ts`) accepts one either. */
export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Parsed, validated CLI arguments. Pure data — no I/O, no SDK dependency. */
export interface CliArgs {
  model: string;
  jsonSchemaPath: string;
  promptPath: string | undefined;
  messagesPath: string | undefined;
  systemPromptPath: string | undefined;
  reasoning: ReasoningEffort | undefined;
  cwd: string;
  profile: string | undefined;
  session: boolean;
  timeoutSeconds: number;
  maxTokens: number | undefined;
  temperature: number | undefined;
  seed: number | undefined;
  printSessionId: boolean;
}

const USAGE = [
  "Usage: omp-structured --model <provider/model> --json-schema <path|-> [options]",
  "",
  "Required:",
  "  --model <provider/model>   e.g. vllm/qwen3.8-27b-ablit or anthropic/claude-sonnet-5",
  "  --json-schema <path|->     JSON Schema file, or - to read it from stdin",
  "",
  "Options:",
  "  --prompt <path|->          Prompt file, or - to read it from stdin (default: read the whole prompt from stdin)",
  "                             Single-user-message shortcut; mutually exclusive with --messages.",
  "  --messages <path|->        Multi-turn transcript file (or - for stdin): a JSON array of",
  "                             {role, content} objects, role one of user/assistant, and optionally",
  "                             a single leading {role:\"system\", content} entry. Mutually exclusive",
  "                             with --prompt.",
  "  --system-prompt <path|->   System prompt file, or - to read it from stdin. Injected via omp's",
  "                             Context.systemPrompt channel, ahead of --prompt/--messages. Composes",
  "                             with a leading system entry in --messages (both are appended, in that",
  "                             order, to the same systemPrompt array).",
  "  --reasoning <effort>       off|minimal|low|medium|high|xhigh|max (default: medium, matching this",
  "                             CLI's existing default reasoning effort). Maps to omp's Effort enum;",
  "                             \"off\" requests disableReasoning instead of an Effort value.",
  "  --cwd <dir>                Working directory for config/session discovery (default: process cwd)",
  "  --profile <name>           Named omp profile (OMP_PROFILE), same isolation as `omp --profile`",
  "  --session                  Write a real omp session .jsonl for this turn (default: --no-session)",
  "  --no-session                (default)",
  "  --timeout <seconds>        Abort the completion after N seconds (default: 120)",
  "  --max-tokens <n>           Output-token budget for the completion. Maps to omp's",
  "                             SimpleStreamOptions.maxTokens verbatim. Default: the resolved",
  "                             model's own declared output limit (model.maxTokens from the omp",
  "                             catalog); pass this to override it.",
  "  --temperature <t>          Pinned sampling temperature (a finite number >= 0), injected onto the",
  "                             provider's own wire body (see src/payload-injection.ts). Fails loud",
  "                             (exit 6) when the resolved provider/model cannot honor it (e.g. an",
  "                             anthropic model that deprecated sampling params) rather than silently",
  "                             sending an unpinned request.",
  "  --seed <n>                 Pinned sampling seed (a non-negative integer), injected onto the",
  "                             provider's own wire body for api families whose API has a seed field.",
  "                             Fails loud (exit 6) naming the provider when the api has no seed.",
  "  --print-session-id         With --session, also emit a stable \"SESSION_ID=<id>\" line on stderr",
  "  -h, --help                 Print this message and exit 0",
  "",
].join("\n");

export class CliArgError extends Error {}

/** Parse and validate argv (excluding the node/bun and script path entries). Throws CliArgError on bad input. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let model: string | undefined;
  let jsonSchemaPath: string | undefined;
  let promptPath: string | undefined;
  let messagesPath: string | undefined;
  let systemPromptPath: string | undefined;
  let reasoning: ReasoningEffort | undefined;
  let cwd = process.cwd();
  let profile: string | undefined;
  let session = false;
  let timeoutSeconds = 120;
  let maxTokens: number | undefined;
  let temperature: number | undefined;
  let seed: number | undefined;
  let printSessionId = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--model":
        model = requireValue(argv, ++i, "--model");
        break;
      case "--json-schema":
        jsonSchemaPath = requireValue(argv, ++i, "--json-schema");
        break;
      case "--prompt":
        promptPath = requireValue(argv, ++i, "--prompt");
        break;
      case "--messages":
        messagesPath = requireValue(argv, ++i, "--messages");
        break;
      case "--system-prompt":
        systemPromptPath = requireValue(argv, ++i, "--system-prompt");
        break;
      case "--reasoning":
        reasoning = requireReasoningEffort(requireValue(argv, ++i, "--reasoning"));
        break;
      case "--cwd":
        cwd = requireValue(argv, ++i, "--cwd");
        break;
      case "--profile":
        profile = requireValue(argv, ++i, "--profile");
        break;
      case "--session":
        session = true;
        break;
      case "--no-session":
        session = false;
        break;
      case "--timeout":
        timeoutSeconds = requirePositiveInt(requireValue(argv, ++i, "--timeout"), "--timeout");
        break;
      case "--max-tokens":
        maxTokens = requirePositiveInt(requireValue(argv, ++i, "--max-tokens"), "--max-tokens");
        break;
      case "--temperature":
        temperature = requireNonNegativeFloat(requireValue(argv, ++i, "--temperature"), "--temperature");
        break;
      case "--seed":
        seed = requireNonNegativeInt(requireValue(argv, ++i, "--seed"), "--seed");
        break;
      case "--print-session-id":
        printSessionId = true;
        break;
      default:
        throw new CliArgError(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (!model) throw new CliArgError(`Missing required --model\n\n${USAGE}`);
  if (!jsonSchemaPath) throw new CliArgError(`Missing required --json-schema\n\n${USAGE}`);
  if (promptPath !== undefined && messagesPath !== undefined) {
    throw new CliArgError(`--prompt and --messages are mutually exclusive; --messages carries the whole transcript.\n\n${USAGE}`);
  }

  return {
    model,
    jsonSchemaPath,
    promptPath,
    messagesPath,
    systemPromptPath,
    reasoning,
    cwd,
    profile,
    session,
    timeoutSeconds,
    maxTokens,
    temperature,
    seed,
    printSessionId,
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new CliArgError(`${flag} requires a value`);
  return value;
}

function requirePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new CliArgError(`${flag} must be a positive integer, got "${value}"`);
  return n;
}

function requireNonNegativeInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CliArgError(`${flag} must be a non-negative integer, got "${value}"`);
  return n;
}

function requireNonNegativeFloat(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CliArgError(`${flag} must be a finite number >= 0, got "${value}"`);
  return n;
}

function requireReasoningEffort(value: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new CliArgError(`--reasoning must be one of: ${REASONING_EFFORTS.join(", ")} (got "${value}")\n\n${USAGE}`);
  }
  return value as ReasoningEffort;
}
