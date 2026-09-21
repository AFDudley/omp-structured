/**
 * One-shot session-read recovery for the real vLLM/qwen3.8 termination trait:
 * a clean `stopReason: "stop"` whose turn never left the model's own
 * `<think>` segment, so `content` carries reasoning (and possibly tool-call)
 * blocks but zero text. omp's own guard for a related failure
 * (`packages/ai/src/stream.ts` `isRetryableThinkingLoop` /
 * `resolveWithThinkingLoopRetries`) only covers the narrower
 * `stopReason: "error"` empty-content stall; it does not cover this
 * well-formed `"stop"` case. A bounded retry loop is forbidden for this case
 * (see README "One-shot session-read recovery") - the reasoning the model
 * already produced is real, completed work, and re-running the whole
 * completion from scratch to get a fresh dice roll on whether it leaves
 * `<think>` this time is neither deterministic nor a fix.
 *
 * The mechanism instead: persist the answerless turn to a real omp session
 * (the exact `SessionManager` path `--session` already uses), then read it
 * back through omp's own read-only transcript loader
 * (`@oh-my-pi/pi-coding-agent/session/session-loader`'s
 * `loadSessionMessagesReadOnly`) - the same function a resumed omp session
 * uses to rebuild provider-replayable history from disk. That gives a
 * `Context` whose history already contains the model's completed reasoning,
 * verbatim, exactly as omp itself would replay it. Appending ONE new user
 * turn asking the model to now just serialize its answer, and calling
 * `completeSimple` exactly once more, is a single deterministic completion:
 * the model is never asked to reason again, only to emit the JSON its
 * already-computed reasoning already determined.
 */
import type { AssistantMessage, Context, Message, UserMessage } from "@oh-my-pi/pi-ai/types";

/** True when `message` is a clean stop that never produced a text block (only reasoning/tool/image content, or nothing). */
export function isAnswerlessStop(message: AssistantMessage): boolean {
  if (message.stopReason !== "stop") return false;
  return !message.content.some(block => block.type === "text");
}

export const CONTINUATION_PROMPT =
  "Your reasoning above is already complete. Do not reason further and do not call any tools. " +
  "Output only the single final JSON object that satisfies the required schema now.";

/** The subset of `SessionManager` this module (and cli.ts's own --session path) drives - kept minimal so it stays independently testable without the real SDK class. */
export interface SessionManagerHandle {
  appendMessage(message: Message): unknown;
  ensureOnDisk(): Promise<void>;
  close(): Promise<void>;
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

export interface OneShotRecoveryDeps {
  /** omp's own read-only transcript loader - reads `filePath` from disk and rebuilds provider-replayable history. */
  loadSessionMessagesReadOnly: (filePath: string) => Promise<Message[]>;
  /**
   * The same `completeSimple` the primary completion used. Declared as a
   * method signature (not an arrow-typed property) so TypeScript's bivariant
   * method-parameter checking accepts the real, precisely-typed
   * `Model<Api>`-accepting function here without an `unknown`-to-concrete
   * cast at the call site - `model` is genuinely opaque to this module,
   * which only ever forwards it back to the same function that produced it.
   */
  completeSimple(model: unknown, context: Context, options: Record<string, unknown>): Promise<AssistantMessage>;
}

export interface OneShotRecoveryResult {
  result: AssistantMessage;
  /** False in the (defensive, expected never to trigger) case where the persisted session already carried visible text and no continuation turn was needed. */
  continuationIssued: boolean;
}

export class NoSessionFileError extends Error {
  constructor() {
    super("SessionManager produced no session file to read back; the one-shot recovery mechanism has no state to read.");
    this.name = "NoSessionFileError";
  }
}

/**
 * The continuation call's last-mile guarantee that the model does not
 * re-enter its own reasoning segment. Measured directly against real vLLM:
 * `disableReasoning: true` on `completionOptions` alone is NOT sufficient -
 * `openai-completions.ts`'s own per-provider-session reasoning-effort state
 * can still stamp a concrete wire effort (observed: `chat_template_kwargs:
 * {enable_thinking: true, reasoning_effort: "low"}`) onto the request even
 * when the caller's `options.reasoning` is `undefined` and
 * `options.disableReasoning` is `true`. `onPayload` runs strictly after all
 * of that internal policy resolution and immediately before the request is
 * sent, so forcing every reasoning/thinking toggle omp itself already
 * populated to "off" here is unconditional and independent of that internal
 * state. Only flips fields already present on the wire body - never adds an
 * unknown top-level key a strict-schema server (e.g. NIM) might reject.
 */
function forceReasoningOffOnWire(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  if ("enable_thinking" in next) next.enable_thinking = false;
  if ("reasoning_effort" in next) delete next.reasoning_effort;
  if ("thinking" in next) next.thinking = { type: "disabled" };
  const kwargs = next.chat_template_kwargs;
  if (kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)) {
    const nextKwargs: Record<string, unknown> = { ...(kwargs as Record<string, unknown>) };
    if ("enable_thinking" in nextKwargs) nextKwargs.enable_thinking = false;
    if ("reasoning_effort" in nextKwargs) delete nextKwargs.reasoning_effort;
    if ("thinking" in nextKwargs) nextKwargs.thinking = false;
    next.chat_template_kwargs = nextKwargs;
  }
  return next;
}

/**
 * Resolve a single answerless (reasoning-only) turn by reading it back from
 * disk and issuing AT MOST ONE deterministic continuation turn in the same
 * session. Never loops, never regenerates from scratch.
 */
export async function resolveAnswerlessTurnViaSession(
  manager: SessionManagerHandle,
  userMessage: UserMessage,
  answerlessResult: AssistantMessage,
  model: unknown,
  completionOptions: Record<string, unknown>,
  deps: OneShotRecoveryDeps,
): Promise<OneShotRecoveryResult> {
  manager.appendMessage(userMessage);
  manager.appendMessage(answerlessResult);
  await manager.ensureOnDisk();

  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new NoSessionFileError();

  // The actual "read the persisted session" step: an independent reload of
  // the turn just written, through omp's own transcript loader, rather than
  // reusing the in-memory `answerlessResult` object.
  const persistedMessages = await deps.loadSessionMessagesReadOnly(sessionFile);
  const persistedAssistant = [...persistedMessages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");

  if (persistedAssistant && persistedAssistant.content.some(block => block.type === "text")) {
    // Defensive only: the persisted content should be identical to
    // `answerlessResult`, which already failed this exact check. Handled
    // anyway per spec ("extract the answer the model already produced")
    // rather than assumed away.
    return { result: persistedAssistant, continuationIssued: false };
  }

  const continuationPrompt: UserMessage = { role: "user", content: CONTINUATION_PROMPT, timestamp: Date.now() };
  const continuationContext: Context = { messages: [...persistedMessages, continuationPrompt] };
  const baseOnPayload = completionOptions.onPayload as ((payload: unknown) => unknown) | undefined;
  const continuationResult = await deps.completeSimple(model, continuationContext, {
    ...completionOptions,
    disableReasoning: true,
    onPayload: (payload: unknown) => {
      const afterSchema = (baseOnPayload?.(payload) ?? payload) as Record<string, unknown>;
      return forceReasoningOffOnWire(afterSchema);
    },
  });

  manager.appendMessage(continuationPrompt);
  manager.appendMessage(continuationResult);
  await manager.ensureOnDisk();

  return { result: continuationResult, continuationIssued: true };
}
