#!/usr/bin/env bun
/**
 * omp-structured: a headless CLI that drives the real omp SDK
 * (@oh-my-pi/pi-coding-agent + @oh-my-pi/pi-ai) to run ONE completion
 * constrained to a caller-supplied JSON Schema via genuine constrained
 * decoding, inheriting config/auth from ~/.omp exactly as `omp` itself does.
 *
 * See README.md for the design rationale (exo-3904 / exo-c441),
 * src/payload-injection.ts for exactly how each api family is constrained,
 * src/transcript.ts for how --system-prompt/--messages assemble into omp's
 * Context, and src/session-recovery.ts for the one-shot session-read
 * recovery this file drives when a reasoning model ends its turn without
 * ever leaving its own `<think>` segment.
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
import * as fs from "node:fs/promises";
import { default as Ajv } from "ajv";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { AssistantMessage, Context, Message, UserMessage } from "@oh-my-pi/pi-ai/types";
import { CliArgError, type CliArgs, parseArgs, type ReasoningEffort } from "./args.js";
import { acquireRouterLease, releaseRouterLease, ROUTER_POOL_PREFIX, type RouterLease, RouterLeaseError } from "./router-lease.js";
import { isStdinRequested, readPathOrStdin } from "./io.js";
import {
  apiSupportsSeed,
  apiSupportsTemperature,
  buildConstrainedOnPayload,
  buildDecodingOnPayload,
  type ConstrainedOnPayload,
  type JsonSchema,
  readWireBudget,
  readWireSystemPrompt,
  readWireDecoding,
  UnsupportedApiError,
} from "./payload-injection.js";
import {
  forceReasoningOffOnWire,
  isAnswerlessStop,
  resolveAnswerlessTurnViaSession,
  type SessionManagerHandle,
} from "./session-recovery.js";
import {
  assembleTranscriptContext,
  type AssembledTranscript,
  parseMessagesJson,
  type TranscriptEntry,
  TranscriptValidationError,
} from "./transcript.js";

function fail(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

/**
 * Deletes the on-disk session file the one-shot recovery mechanism creates
 * internally when the caller did not pass `--session` - `fail()` calls
 * `process.exit()` directly, so it never reaches the natural cleanup at the
 * bottom of `main()`; every failure path reachable after
 * `resolveAnswerlessTurnViaSession` may have created one and MUST call this
 * first so a run that ultimately fails leaves no artifact, matching the
 * no-`--session` contract on the success path.
 */
async function cleanupEphemeralSession(sessionManager: SessionManagerHandle | undefined, keep: boolean): Promise<void> {
  if (!sessionManager || keep) return;
  await sessionManager.close().catch(() => undefined);
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile) await fs.unlink(sessionFile).catch(() => undefined);
}

/** Raw (unparsed-against-model) inputs read from disk/stdin: the schema, and either a single prompt or a --messages transcript, plus an optional --system-prompt. */
interface RawInputs {
  schema: JsonSchema;
  promptText: string | undefined;
  messagesEntries: TranscriptEntry[] | undefined;
  systemPromptText: string | undefined;
}

async function readRawInputs(args: CliArgs): Promise<RawInputs> {
  // At most one input may read stdin; the second stdin read would observe
  // an already-drained empty stream. --prompt and --messages are mutually
  // exclusive (enforced in parseArgs), so exactly one of them contributes to
  // this stdin-conflict check, never both.
  const stdinRequests: string[] = [];
  if (isStdinRequested(args.jsonSchemaPath)) stdinRequests.push("--json-schema");
  if (args.messagesPath !== undefined) {
    if (isStdinRequested(args.messagesPath)) stdinRequests.push("--messages");
  } else if (isStdinRequested(args.promptPath)) {
    stdinRequests.push("--prompt");
  }
  if (args.systemPromptPath !== undefined && isStdinRequested(args.systemPromptPath)) stdinRequests.push("--system-prompt");
  if (stdinRequests.length > 1) {
    fail(`${stdinRequests.join(" and ")} cannot all read from stdin; give all but one an explicit file path.`, 2);
  }

  const [schemaText, promptOrMessagesText, systemPromptRaw] = await Promise.all([
    readPathOrStdin(args.jsonSchemaPath),
    args.messagesPath !== undefined ? readPathOrStdin(args.messagesPath) : readPathOrStdin(args.promptPath),
    args.systemPromptPath !== undefined ? readPathOrStdin(args.systemPromptPath) : Promise.resolve(undefined),
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

  if (args.systemPromptPath !== undefined && systemPromptRaw !== undefined && systemPromptRaw.trim().length === 0) {
    fail("--system-prompt is empty.", 2);
  }

  if (args.messagesPath !== undefined) {
    let messagesEntries: TranscriptEntry[];
    try {
      messagesEntries = parseMessagesJson(promptOrMessagesText);
    } catch (err) {
      if (err instanceof TranscriptValidationError) fail(err.message, 2);
      throw err;
    }
    return { schema: schema as JsonSchema, promptText: undefined, messagesEntries, systemPromptText: systemPromptRaw };
  }

  if (promptOrMessagesText.trim().length === 0) fail("Prompt is empty.", 2);
  return { schema: schema as JsonSchema, promptText: promptOrMessagesText, messagesEntries: undefined, systemPromptText: systemPromptRaw };
}

/** Reasoning-related wire field names actually observed across omp's api families (see session-recovery.ts's forceReasoningOffOnWire for the vLLM/openai-completions set this was measured against). Logged, never mutated, so --reasoning's effect on the real wire body is independently inspectable (stderr), not just trusted. */
const REASONING_WIRE_FIELDS = ["reasoning_effort", "chat_template_kwargs", "thinking", "reasoning"] as const;

function logReasoningWireFields(payload: Record<string, unknown>): void {
  const fields: Record<string, unknown> = {};
  for (const key of REASONING_WIRE_FIELDS) {
    if (key in payload) fields[key] = payload[key];
  }
  if (Object.keys(fields).length > 0) {
    process.stderr.write(`[omp-structured] wire reasoning fields: ${JSON.stringify(fields)}\n`);
  }
}

/** api families where a model can DEPRECATE sampling params (temperature) — the wire has the field, but a given model may reject it, signalled by `model.compat.supportsSamplingParams`. For every other family the field is unconditionally honored. Mirrors `@oh-my-pi/pi-catalog`'s `supports-sampling-params` compat axis, which is wired only for the OpenAI families + anthropic. */
const SAMPLING_GATED_APIS: Record<string, true> = {
  "openai-completions": true,
  "openai-responses": true,
  "openai-codex-responses": true,
  "azure-openai-responses": true,
  openrouter: true,
  "anthropic-messages": true,
};

/** Non-mutating stderr log of the pinned decoding controls as they actually sit on the outgoing wire body, so `--temperature`/`--seed`'s effect on the request reaching the provider is inspectable, not merely trusted (mirrors logReasoningWireFields). */
function logDecodingWireFields(api: string, payload: Record<string, unknown>): void {
  const wire = readWireDecoding(api, payload);
  const fields: Record<string, number> = {};
  if (wire.temperature !== undefined) fields.temperature = wire.temperature;
  if (wire.seed !== undefined) fields.seed = wire.seed;
  if (Object.keys(fields).length > 0) {
    process.stderr.write(`[omp-structured] wire decoding fields: ${JSON.stringify(fields)}\n`);
  }
}

/** Non-mutating stderr log of the output-token budget ACTUALLY on the wire — the real number sent, including any provider-SDK fallback/clamp the caller never set. This is the authoritative budget report: reading the wire is what makes "source=unset" unable to hide a provider cap (e.g. anthropic's OAuth clamp to 64000 while model.maxTokens=128000). */
function logWireBudget(api: string, payload: Record<string, unknown>): void {
  const budget = readWireBudget(api, payload);
  const shown = budget.value !== undefined ? String(budget.value) : "absent (no output cap on the wire)";
  process.stderr.write(`[omp-structured] wire output budget: ${shown} (field=${budget.field}, api=${api})\n`);
}

/** Non-mutating stderr log of the system prompt ACTUALLY on the wire — the symmetric read of where completeSimple placed context.systemPrompt for this api. A model's ANSWER to a system prompt varies sample to sample, so it cannot prove --system-prompt reached the provider; the wire body can and does deterministically. Mirrors logReasoningWireFields/logDecodingWireFields/logWireBudget. */
function logSystemPromptWireField(api: string, payload: Record<string, unknown>): void {
  const { text, field } = readWireSystemPrompt(api, payload);
  process.stderr.write(
    `[omp-structured] wire system prompt: ${JSON.stringify({ field, present: text !== undefined, text: text ?? null })}\n`,
  );
}

/** Maps --reasoning onto completeSimple's SimpleStreamOptions. "off" -> disableReasoning (there is no Effort member for "off" - see args.ts); undefined (flag absent) preserves this CLI's pre-existing default of Effort.Medium for reasoning-capable models; every other value is a verified Effort enum member, forwarded as-is. */
function resolveReasoningOptions(reasoning: ReasoningEffort | undefined, modelReasons: boolean): { reasoning: Effort | undefined; disableReasoning: boolean | undefined } {
  if (!modelReasons) return { reasoning: undefined, disableReasoning: undefined };
  if (reasoning === undefined) return { reasoning: Effort.Medium, disableReasoning: undefined };
  if (reasoning === "off") return { reasoning: undefined, disableReasoning: true };
  return { reasoning: reasoning as Effort, disableReasoning: undefined };
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

  const rawInputs = await readRawInputs(args);

  // `--model pool/<name>`: the router picks the server and how it is run. The
  // member's thinking level replaces --reasoning, because it is a property of
  // that server (e.g. marks' Qwen3.6 lands work only with thinking off).
  if (args.model.startsWith(ROUTER_POOL_PREFIX)) {
    let lease: RouterLease;
    try {
      lease = await acquireRouterLease(args.model);
    } catch (err) {
      if (err instanceof RouterLeaseError) fail(`[omp-structured] ${err.message}`, 7);
      throw err;
    }
    process.once("exit", () => releaseRouterLease(lease));
    process.stderr.write(`[omp-structured] ${args.model} -> ${lease.model} thinking=${lease.thinking} (${lease.note})\n`);
    args = { ...args, model: lease.model, reasoning: lease.thinking };
  }

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

  let baseOnPayload: ConstrainedOnPayload;
  try {
    baseOnPayload = buildConstrainedOnPayload(model.api, rawInputs.schema);
  } catch (err) {
    if (err instanceof UnsupportedApiError) fail(err.message, 3);
    throw err;
  }
  const { reasoning, disableReasoning } = resolveReasoningOptions(args.reasoning, Boolean(model.reasoning));

  // Pinned decoding (--temperature/--seed). Fail loud, BEFORE any network
  // request, if the resolved provider/model cannot honor a SET control — a
  // pinned decoding setting silently dropped is not pinned (docs/ORACLES.md's
  // "a pinned judge is a fixed grader"). Temperature's wire field exists on
  // every family, but a model can DEPRECATE it (anthropic sonnet-5, OpenAI
  // o-series/gpt-5): `compat.supportsSamplingParams` is that per-model signal
  // for the gated families. Seed has no wire field at all on several apis.
  const samplingParamsHonored =
    model.compat != null &&
    "supportsSamplingParams" in model.compat &&
    model.compat.supportsSamplingParams === true;
  const temperatureHonorable =
    args.temperature === undefined ||
    (apiSupportsTemperature(model.api) &&
      (SAMPLING_GATED_APIS[model.api] ? samplingParamsHonored : true));
  if (!temperatureHonorable) {
    fail(
      `--temperature ${args.temperature} cannot be honored by "${args.model}" (api "${model.api}"): ` +
        "this model deprecated sampling parameters (compat.supportsSamplingParams=false), so the provider " +
        "rejects a temperature. Refusing to send an unpinned request " +
        "(a pinned decoding setting silently dropped is not pinned).",
      6,
    );
  }
  if (args.seed !== undefined && !apiSupportsSeed(model.api)) {
    fail(
      `--seed ${args.seed} cannot be honored by "${args.model}" (api "${model.api}"): ` +
        "this provider's API has no seed parameter. Refusing to send an unpinned request " +
        "(a pinned decoding setting silently dropped is not pinned).",
      6,
    );
  }
  const decodingOnPayload = buildDecodingOnPayload(model.api, {
    temperature: args.temperature,
    seed: args.seed,
  });

  // Composes the schema constraint with a non-mutating wire-level log of
  // every reasoning-related field actually present on the outgoing payload,
  // so --reasoning's effect is independently inspectable on stderr (see
  // README "Reasoning effort" and acceptance check (d)) rather than merely
  // trusted to have reached the provider. When the caller explicitly asked
  // for --reasoning off, also applies forceReasoningOffOnWire
  // (session-recovery.ts): `disableReasoning: true` alone reaches
  // SimpleStreamOptions but does not stop openai-completions.ts's own
  // ambient per-model reasoning-effort default from stamping a concrete
  // effort onto the wire body underneath it (the same gap the one-shot
  // continuation's forced-off path already had to work around).
  const onPayload: ConstrainedOnPayload = payload => {
    const afterSchema = baseOnPayload(payload);
    const afterDecoding = afterSchema ? decodingOnPayload(afterSchema) : afterSchema;
    const forcedOff = disableReasoning && afterDecoding ? forceReasoningOffOnWire(afterDecoding) : afterDecoding;
    const wireBody = (forcedOff ?? payload) as Record<string, unknown>;
    logReasoningWireFields(wireBody);
    logDecodingWireFields(model.api, wireBody);
    logWireBudget(model.api, wireBody);
    logSystemPromptWireField(model.api, wireBody);
    return forcedOff;
  };

  // Build the Context this turn sends: either the --messages transcript
  // (optionally prefixed by --system-prompt and/or the transcript's own
  // leading system entry) or the --prompt single-user-message shortcut
  // (optionally prefixed by --system-prompt alone). See transcript.ts for
  // exactly how Context.systemPrompt/Context.messages map onto the wire.
  let contextMessages: Message[];
  let systemPrompt: string[] | undefined;
  if (rawInputs.messagesEntries) {
    let assembled: AssembledTranscript;
    try {
      assembled = assembleTranscriptContext(rawInputs.messagesEntries, rawInputs.systemPromptText, {
        api: model.api,
        provider: model.provider,
        id: model.id,
      });
    } catch (err) {
      if (err instanceof TranscriptValidationError) fail(err.message, 2);
      throw err;
    }
    contextMessages = assembled.messages;
    systemPrompt = assembled.systemPrompt;
  } else {
    const userMessage: UserMessage = { role: "user", content: rawInputs.promptText ?? "", timestamp: Date.now() };
    contextMessages = [userMessage];
    systemPrompt = rawInputs.systemPromptText !== undefined ? [rawInputs.systemPromptText] : undefined;
  }
  const context: Context = { systemPrompt, messages: contextMessages };

  const apiKey = await modelRegistry.getApiKey(model);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${args.timeoutSeconds}s`)),
    args.timeoutSeconds * 1000,
  );

  // Populated only when the one-shot recovery path (below) or `--session`
  // needs a real on-disk session; the common (has-text-on-the-first-turn)
  // path never touches SessionManager at all.
  let sessionManager: SessionManagerHandle | undefined;
  let result: AssistantMessage | undefined;
  try {
    // Output-token budget REQUESTED of the SDK: the resolved model's own
    // declared output limit (`model.maxTokens` from the omp catalog), which
    // for a mandatory-reasoning local model already covers thinking + the
    // final answer; `--max-tokens` overrides it. No hard-coded constant: a
    // fixed 4096 total cap was exhausted by qwen's own <think> segment before
    // it reached the JSON answer (stopReason=length). This is only what we ASK
    // for — the provider SDK may clamp it (e.g. anthropic's OAuth clamp to
    // 64000 while model.maxTokens=128000). The AUTHORITATIVE, truthful budget
    // (`wire output budget`) is logged from the actual outgoing wire body in
    // onPayload (logWireBudget), so "source=unset" can never hide a real cap.
    const maxTokens = args.maxTokens ?? model.maxTokens ?? undefined;
    process.stderr.write(
      `[omp-structured] requested output budget: maxTokens=${maxTokens ?? "provider-default"} ` +
        `(source=${args.maxTokens !== undefined ? "--max-tokens" : model.maxTokens != null ? "model.maxTokens" : "unset"})\n`,
    );
    const completionOptions: Record<string, unknown> = {
      apiKey,
      maxTokens,
      signal: controller.signal,
      // "medium" measurably reduces answerless reasoning-only stops versus
      // omp's ambient "low" default for this local model (see README
      // "Known local-model reliability note") when --reasoning is not
      // given; only reasoning-capable models accept a `reasoning` option at
      // all (see resolveReasoningOptions).
      reasoning,
      disableReasoning,
      onPayload,
    };
    result = await completeSimple(model, context, completionOptions);

    if (isAnswerlessStop(result)) {
      process.stderr.write(
        "[omp-structured] turn ended entirely inside the model's reasoning with no answer text; " +
          'resolving via one-shot session read (see README "One-shot session-read recovery")\n',
      );
      // Deferred: same OMP_PROFILE-ordering constraint as the top-of-main
      // batch (file header), and this branch only runs on the answerless-
      // stop path, so a static import would load session-manager's/
      // session-loader's dependency graph on every invocation instead of
      // only the ones that actually hit this recovery mechanism.
      const [{ SessionManager }, { loadSessionMessagesReadOnly }] = await Promise.all([
        import("@oh-my-pi/pi-coding-agent/session/session-manager"),
        import("@oh-my-pi/pi-coding-agent/session/session-loader"),
      ]);
      sessionManager = SessionManager.create(args.cwd);
      const recovery = await resolveAnswerlessTurnViaSession(
        sessionManager,
        contextMessages,
        result,
        model,
        completionOptions,
        {
          loadSessionMessagesReadOnly: filePath => loadSessionMessagesReadOnly(filePath) as unknown as Promise<Message[]>,
          completeSimple,
        },
        systemPrompt,
      );
      result = recovery.result;
      if (!recovery.continuationIssued) {
        process.stderr.write("[omp-structured] persisted session already carried answer text; no continuation turn was needed\n");
      } else if (isAnswerlessStop(result)) {
        process.stderr.write(
          "[omp-structured] one-shot continuation turn also ended inside the model's reasoning with no answer text; no further attempts will be made\n",
        );
      } else {
        process.stderr.write("[omp-structured] one-shot continuation turn (seeded from the persisted reasoning) produced answer text\n");
      }
    }
  } catch (err) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail(`Completion request failed: ${err instanceof Error ? err.message : String(err)}`, 4);
  } finally {
    clearTimeout(timer);
  }

  if (!result) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail("Completion request produced no result.", 4);
  }
  if (isAnswerlessStop(result)) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail(
      "Model ended its turn without producing answer text on both the original turn and the one-shot " +
        "session-read continuation (reasoning-only stop both times). No further attempts are made.",
      4,
    );
  }

  if (result.errorMessage) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail(`Model returned an error (stopReason=${result.stopReason}): ${result.errorMessage}`, 4);
  }
  if (result.stopReason !== "stop") {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail(`Model did not finish normally (stopReason=${result.stopReason}).`, 4);
  }

  const textBlock = result.content.find(
    (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
  );
  if (!textBlock || textBlock.text.trim().length === 0) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail("Model produced no text content (only thinking/tool-call/image blocks).", 4);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail(
      `Model output was not valid JSON despite constrained decoding: ${err instanceof Error ? err.message : String(err)}\nRaw output: ${textBlock.text}`,
      4,
    );
  }

  const ajv = new Ajv({ strict: false, allowUnionTypes: true });
  const validate = ajv.compile(rawInputs.schema);
  if (!validate(parsed)) {
    await cleanupEphemeralSession(sessionManager, args.session);
    fail(`Model output did not validate against --json-schema: ${ajv.errorsText(validate.errors)}`, 5);
  }

  if (args.session) {
    if (!sessionManager) {
      // Same profile-ordering reason as the batch above, and to avoid
      // loading session-manager's dependency graph on the (default)
      // --no-session, no-recovery-needed path.
      const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
      sessionManager = SessionManager.create(args.cwd);
      for (const message of contextMessages) sessionManager.appendMessage(message);
      sessionManager.appendMessage(result);
      await sessionManager.ensureOnDisk();
    }
    await sessionManager.close();
    process.stderr.write(
      `[omp-structured] session written: id=${sessionManager.getSessionId()} file=${sessionManager.getSessionFile()}\n`,
    );
    if (args.printSessionId) process.stderr.write(`SESSION_ID=${sessionManager.getSessionId()}\n`);
  } else {
    // The recovery path above always needs a real on-disk session to read
    // back; when the caller didn't ask for --session, leave no artifact.
    await cleanupEphemeralSession(sessionManager, false);
  }

  process.stdout.write(`${JSON.stringify(parsed)}\n`);
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[omp-structured] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
