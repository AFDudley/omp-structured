#!/usr/bin/env bun
/**
 * omp-structured: a headless CLI that drives the real omp SDK
 * (@oh-my-pi/pi-coding-agent + @oh-my-pi/pi-ai) to run ONE completion
 * constrained to a caller-supplied JSON Schema via genuine constrained
 * decoding (OpenAI/vLLM `response_format`, Anthropic `output_config.format`),
 * inheriting config/auth from ~/.omp exactly as `omp` itself does.
 *
 * See README.md for the design rationale (exo-3904 / exo-c441) and
 * src/payload-injection.ts for exactly how each API family is constrained.
 *
 * Profile handling: omp resolves `OMP_PROFILE` at MODULE LOAD time in
 * @oh-my-pi/pi-utils/dirs (before any of our code runs), so `--profile` must
 * be applied to process.env before the omp SDK's dependency graph is loaded
 * for the first time. Every SDK import that touches config, auth, or session
 * state is therefore a deliberate `await import()`, deferred past that env
 * mutation (a static top-level import would evaluate before `main()` runs
 * and observe the wrong profile). `@oh-my-pi/pi-catalog/effort` below is a
 * pure, side-effect-free constant module and stays a static import.
 */
import { default as Ajv } from "ajv";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { AssistantMessage, Context, UserMessage } from "@oh-my-pi/pi-ai/types";
import { ANSWER_RETRY_MAX_ATTEMPTS, answerRetryDelayMs, isAnswerlessStop, sleep } from "./answer-retry.js";
import { CliArgError, type CliArgs, parseArgs } from "./args.js";
import { isStdinRequested, readPathOrStdin } from "./io.js";
import { buildConstrainedOnPayload, type ConstrainedOnPayload, type JsonSchema, UnsupportedApiError } from "./payload-injection.js";

function fail(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

async function readSchemaAndPrompt(args: CliArgs): Promise<{ schema: JsonSchema; promptText: string }> {
  if (isStdinRequested(args.jsonSchemaPath) && isStdinRequested(args.promptPath)) {
    fail("--json-schema and --prompt cannot both read from stdin; give at least one an explicit file path.", 2);
  }

  const [schemaText, promptText] = await Promise.all([
    readPathOrStdin(args.jsonSchemaPath),
    readPathOrStdin(args.promptPath),
  ]);

  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch (err) {
    fail(`--json-schema did not contain valid JSON: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    fail("--json-schema must be a JSON object.", 2);
  }
  if (promptText.trim().length === 0) fail("Prompt is empty.", 2);

  return { schema: schema as JsonSchema, promptText };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliArgError) fail(err.message, 2);
    throw err;
  }

  // MUST happen before any omp SDK import (see file header).
  if (args.profile) process.env.OMP_PROFILE = args.profile;

  const { schema, promptText } = await readSchemaAndPrompt(args);

  // Deliberately dynamic: every omp SDK module transitively loads
  // @oh-my-pi/pi-utils/dirs, which reads OMP_PROFILE once at first import.
  // A static top-level import would run before the env mutation above.
  const [{ getAgentDir }, { discoverAuthStorage }, { ModelRegistry }, { resolveModelFromString }, { completeSimple }] =
    await Promise.all([
      import("@oh-my-pi/pi-coding-agent"),
      import("@oh-my-pi/pi-coding-agent/session/auth-broker-config"),
      import("@oh-my-pi/pi-coding-agent/config/model-registry"),
      import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
      import("@oh-my-pi/pi-ai/stream"),
    ]);

  const agentDir = getAgentDir();
  process.stderr.write(`[omp-structured] agentDir=${agentDir} cwd=${args.cwd} model=${args.model}\n`);

  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage, `${agentDir}/models.yml`);
  const providerId = args.model.split("/")[0] ?? args.model;
  await modelRegistry.refreshProvider(providerId, "online-if-uncached");

  const model = resolveModelFromString(args.model, modelRegistry.getAvailable("chat"));
  if (!model) fail(`Could not resolve --model "${args.model}" against ~/.omp/agent/models.yml.`, 2);

  let onPayload: ConstrainedOnPayload;
  try {
    onPayload = buildConstrainedOnPayload(model.api, schema);
  } catch (err) {
    if (err instanceof UnsupportedApiError) fail(err.message, 3);
    throw err;
  }

  const apiKey = await modelRegistry.getApiKey(model);
  const userMessage: UserMessage = { role: "user", content: promptText, timestamp: Date.now() };
  const context: Context = { messages: [userMessage] };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${args.timeoutSeconds}s`)),
    args.timeoutSeconds * 1000,
  );
  let result: AssistantMessage | undefined;
  try {
    for (let attempt = 0; attempt < ANSWER_RETRY_MAX_ATTEMPTS; attempt++) {
      const attemptResult = await completeSimple(model, context, {
        apiKey,
        maxTokens: 4096,
        signal: controller.signal,
        // "medium" measurably reduces answerless reasoning-only stops versus
        // omp's ambient "low" default for this local model (see README
        // "Known local-model reliability note"); only reasoning-capable
        // models accept a `reasoning` option at all.
        reasoning: model.reasoning ? Effort.Medium : undefined,
        onPayload,
      });
      if (!isAnswerlessStop(attemptResult)) {
        result = attemptResult;
        break;
      }
      result = attemptResult;
      process.stderr.write(
        `[omp-structured] attempt ${attempt + 1}/${ANSWER_RETRY_MAX_ATTEMPTS} ended inside the model's reasoning with no answer text; retrying (see README "Known local-model reliability note")\n`,
      );
      if (attempt + 1 < ANSWER_RETRY_MAX_ATTEMPTS) {
        await sleep(answerRetryDelayMs(attempt));
      }
    }
  } catch (err) {
    fail(`Completion request failed: ${err instanceof Error ? err.message : String(err)}`, 4);
  } finally {
    clearTimeout(timer);
  }
  if (!result) fail("Completion request produced no result.", 4);
  if (isAnswerlessStop(result)) {
    fail(
      `Model ended its turn without producing answer text ${ANSWER_RETRY_MAX_ATTEMPTS} times in a row (reasoning-only stop each time).`,
      4,
    );
  }

  if (result.errorMessage) {
    fail(`Model returned an error (stopReason=${result.stopReason}): ${result.errorMessage}`, 4);
  }
  if (result.stopReason !== "stop") {
    fail(`Model did not finish normally (stopReason=${result.stopReason}).`, 4);
  }

  const textBlock = result.content.find(
    (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
  );
  if (!textBlock || textBlock.text.trim().length === 0) {
    fail("Model produced no text content (only thinking/tool-call/image blocks).", 4);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    fail(
      `Model output was not valid JSON despite constrained decoding: ${err instanceof Error ? err.message : String(err)}\nRaw output: ${textBlock.text}`,
      4,
    );
  }

  const ajv = new Ajv({ strict: false, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    fail(`Model output did not validate against --json-schema: ${ajv.errorsText(validate.errors)}`, 5);
  }

  if (args.session) {
    // Deferred for the same profile-ordering reason as the batch above, and
    // to avoid loading session-manager's dependency graph on the (default)
    // --no-session path.
    const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
    const manager = SessionManager.create(args.cwd);
    manager.appendMessage(userMessage);
    manager.appendMessage(result);
    await manager.ensureOnDisk();
    await manager.close();
    process.stderr.write(
      `[omp-structured] session written: id=${manager.getSessionId()} file=${manager.getSessionFile()}\n`,
    );
    if (args.printSessionId) process.stderr.write(`SESSION_ID=${manager.getSessionId()}\n`);
  }

  process.stdout.write(`${JSON.stringify(parsed)}\n`);
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[omp-structured] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
