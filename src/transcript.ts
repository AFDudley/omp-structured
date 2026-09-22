/**
 * --messages transcript parsing/validation, and --system-prompt + --messages
 * -> omp `Context` assembly.
 *
 * omp's `Context` (`@oh-my-pi/pi-ai/types`) carries a system prompt as
 * `Context.systemPrompt: string[]` — a channel entirely separate from
 * `Context.messages`, NOT a `{role:"system"}` message in the array. Every
 * provider that honors a system prompt reads it from there, verified by
 * reading the installed `18.2.8` source:
 *   - `providers/openai-completions.ts`'s `normalizeSystemPrompts(context.systemPrompt)`
 *     (emitted as a `role: "system"` or `role: "developer"` wire message,
 *     the latter when `model.reasoning && compat.supportsDeveloperRole`).
 *   - `providers/anthropic.ts`'s `buildAnthropicSystemBlocks(context.systemPrompt, ...)`
 *     (emitted as top-level Anthropic `system` blocks).
 * `--system-prompt` and a leading `{"role":"system",...}` entry in
 * `--messages` both feed this same array, in that order; omp itself
 * assembles the actual provider-native system wire field from it — this CLI
 * never constructs a system message directly.
 *
 * A synthetic `AssistantMessage` built from a `--messages` transcript entry
 * carries placeholder `api`/`provider`/`model`/`usage`/`stopReason`
 * metadata. None of it is read by the outgoing wire serialization for a
 * prior turn — verified by reading both providers' `msg.role === "assistant"`
 * branches (`providers/openai-completions.ts` line ~2149,
 * `providers/anthropic.ts`'s equivalent), which build the wire request from
 * `.content` alone. Billing/session-bookkeeping fields on a message that was
 * never actually produced by a real completion are meaningless by
 * construction; they exist only so the object satisfies the SDK's `Message`
 * union type.
 */
import type { AssistantMessage, Message, TextContent, UserMessage } from "@oh-my-pi/pi-ai/types";

export interface TranscriptEntry {
  role: "system" | "user" | "assistant";
  content: string;
}

export class TranscriptValidationError extends Error {}

const VALID_ROLES = ["system", "user", "assistant"] as const;

/** Parses and validates raw --messages JSON text into a role-ordered transcript. Pure; throws TranscriptValidationError on any shape violation. */
export function parseMessagesJson(raw: string): TranscriptEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TranscriptValidationError(`--messages did not contain valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TranscriptValidationError("--messages must be a non-empty JSON array of {role, content} objects.");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TranscriptValidationError(`--messages[${index}] must be an object with "role" and "content" string fields, got ${JSON.stringify(entry)}.`);
    }
    const { role, content } = entry as Record<string, unknown>;
    if (typeof role !== "string" || !(VALID_ROLES as readonly string[]).includes(role)) {
      throw new TranscriptValidationError(`--messages[${index}].role must be one of ${VALID_ROLES.join(", ")}, got ${JSON.stringify(role)}.`);
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new TranscriptValidationError(`--messages[${index}].content must be a non-empty string.`);
    }
    if (role === "system" && index !== 0) {
      throw new TranscriptValidationError(`--messages[${index}]: role "system" is only permitted as the first element of the transcript.`);
    }
    return { role: role as TranscriptEntry["role"], content };
  });
}

/** Model identity fields a synthetic AssistantMessage needs to satisfy the SDK's Message union — see file header for why the values themselves are never read by the wire. */
export interface MessageModelIdentity {
  api: string;
  provider: string;
  id: string;
}

export interface AssembledTranscript {
  systemPrompt: string[] | undefined;
  messages: Message[];
}

/**
 * Combines an explicit --system-prompt with a --messages transcript's own
 * optional leading system entry (both feed the same Context.systemPrompt
 * channel — see file header) and converts the remaining user/assistant
 * entries into typed SDK messages, one per entry, in order.
 */
export function assembleTranscriptContext(
  entries: readonly TranscriptEntry[],
  explicitSystemPrompt: string | undefined,
  model: MessageModelIdentity,
): AssembledTranscript {
  const leadingSystem = entries[0]?.role === "system" ? entries[0] : undefined;
  const conversation = leadingSystem ? entries.slice(1) : entries;
  if (conversation.length === 0) {
    throw new TranscriptValidationError("--messages must contain at least one user/assistant turn (a lone system entry is not a transcript).");
  }

  const systemPromptParts = [
    ...(explicitSystemPrompt !== undefined ? [explicitSystemPrompt] : []),
    ...(leadingSystem !== undefined ? [leadingSystem.content] : []),
  ];

  const now = Date.now();
  const messages: Message[] = conversation.map((entry, index) => {
    const timestamp = now + index;
    if (entry.role === "user") {
      const message: UserMessage = { role: "user", content: entry.content, timestamp };
      return message;
    }
    if (entry.role !== "assistant") {
      // Unreachable: parseMessagesJson only allows a "system" role at index 0, already sliced off above.
      throw new TranscriptValidationError(`--messages: unexpected role "${entry.role}" mid-transcript.`);
    }
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: entry.content } satisfies TextContent],
      api: model.api as AssistantMessage["api"],
      provider: model.provider as AssistantMessage["provider"],
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    };
    return message;
  });

  return {
    systemPrompt: systemPromptParts.length > 0 ? systemPromptParts : undefined,
    messages,
  };
}
