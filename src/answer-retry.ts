import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";

/**
 * Bounded retry for a reasoning model that ends its turn inside its own
 * `<think>` segment, producing a clean `stopReason: "stop"` with zero text
 * content. Observed empirically against vllm/qwen3.8-27b-ablit at the low
 * reasoning effort omp defaults to for this provider: it reproduces with
 * `response_format` entirely absent (unconstrained baseline: 1/8 turns
 * produced a text block; constrained: 2-3/8), so it is a pre-existing
 * local-model/template termination trait, not something constrained decoding
 * introduces. Whenever the model DOES leave its reasoning segment, its output
 * conforms to schema every time (see README "Known local-model reliability
 * note").
 *
 * omp's own guard for a related failure (packages/ai/src/stream.ts
 * `isRetryableThinkingLoop` / `resolveWithThinkingLoopRetries`) only covers
 * the narrower `stopReason: "error"` empty-content stall; it does not retry
 * a well-formed `stopReason: "stop"` turn that simply never left its
 * reasoning segment. This is that guard's sibling for the `"stop"` case.
 */
export const ANSWER_RETRY_MAX_ATTEMPTS = 20;
const ANSWER_RETRY_BASE_DELAY_MS = 100;
const ANSWER_RETRY_MAX_DELAY_MS = 1000;

/** True when `message` is a clean stop that never produced a text block (only reasoning/tool/image content, or nothing). */
export function isAnswerlessStop(message: AssistantMessage): boolean {
  if (message.stopReason !== "stop") return false;
  return !message.content.some(block => block.type === "text");
}


/** Delay `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
/** Exponential backoff (matches the shape of omp's own THINKING_LOOP_RETRY_* constants), capped at ANSWER_RETRY_MAX_DELAY_MS. */
export function answerRetryDelayMs(attemptIndex: number): number {
  return Math.min(ANSWER_RETRY_BASE_DELAY_MS * 2 ** attemptIndex, ANSWER_RETRY_MAX_DELAY_MS);
}
