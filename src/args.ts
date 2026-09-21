/** Parsed, validated CLI arguments. Pure data — no I/O, no SDK dependency. */
export interface CliArgs {
  model: string;
  jsonSchemaPath: string;
  promptPath: string | undefined;
  cwd: string;
  profile: string | undefined;
  session: boolean;
  timeoutSeconds: number;
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
  "  --cwd <dir>                Working directory for config/session discovery (default: process cwd)",
  "  --profile <name>           Named omp profile (OMP_PROFILE), same isolation as `omp --profile`",
  "  --session                  Write a real omp session .jsonl for this turn (default: --no-session)",
  "  --no-session                (default)",
  "  --timeout <seconds>        Abort the completion after N seconds (default: 120)",
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
  let cwd = process.cwd();
  let profile: string | undefined;
  let session = false;
  let timeoutSeconds = 120;
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
      case "--print-session-id":
        printSessionId = true;
        break;
      default:
        throw new CliArgError(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (!model) throw new CliArgError(`Missing required --model\n\n${USAGE}`);
  if (!jsonSchemaPath) throw new CliArgError(`Missing required --json-schema\n\n${USAGE}`);

  return {
    model,
    jsonSchemaPath,
    promptPath,
    cwd,
    profile,
    session,
    timeoutSeconds,
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
