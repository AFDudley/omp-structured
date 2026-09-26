# omp-structured

A headless TypeScript CLI that drives the real, published **omp SDK**
(`@oh-my-pi/pi-coding-agent` + `@oh-my-pi/pi-ai`, pinned to `18.2.8`) to run
**one completion constrained to a caller-supplied JSON Schema via genuine
constrained decoding**, keyed off the resolved model's exact `api`
discriminant across every omp api family that has a documented
structured-output wire field — see "Supported api families" below —
inheriting config, auth, and model resolution from `~/.omp` exactly as `omp`
itself does. It is a subprocess entry point: give it a provider/model, a
JSON Schema, and a prompt; it prints one schema-valid JSON object to stdout
and exits 0, or fails loud on stderr.

## Why this exists

exophial's `OmpTransport` (`exophial/llm_transport.py`) drives arbitrary
omp-configured providers over `omp --mode rpc`. To get structured output it
offers a **discretionary** `respond` host tool (whose parameters *are* the
schema) and forces it via omp's `/force:respond` builtin. Two real,
independently-filed defects show this is the wrong mechanism:

- **exo-3904** (open): with the ~22KB `proposal_or_escalate_schema()` from
  `exophial.ops.typed_intake` (equivalently `exophial.ops.derivation_schema`,
  which re-derives the identical schema), both `claude-opus-4-8` and
  `claude-sonnet-5` intermittently **end their turn without ever calling the
  `respond` tool** — 120+ seconds of a forced tool choice, then nothing.
  `OmpTransport` raises `TransportError: ended its turn without calling the
  respond tool` and the caller (spec derivation) escalates. The same schema
  and model succeed on other turns — a coin flip driven by tool-call
  discretion, not by the schema's validity. A **forced custom host tool**
  cannot be made more forced than "forced"; the tool-call channel itself is
  the unreliable part.
- **exo-c441** (closed, but load-bearing context): even on a turn where the
  `respond` tool *is* called, `OmpTransport` calls `client.abort()` immediately
  to end the turn fast, then exits into `client.stop()` — killing the omp
  process **before** it reaches the clean turn-end that omp's session writer
  waits for. `persist_session=True` silently writes nothing.

The correct mechanism for "make the model's output conform to a schema" is
**constrained decoding**: the provider's own token-level grammar, not a
tool-call the model has to choose to make. Anthropic's Messages API has had
this as a GA field since the `structured-outputs-2025-12-15` era
(`output_config.format`, no beta header required); vLLM's OpenAI-compatible
`/v1/chat/completions` has had `response_format: {"type": "json_schema", ...}`
guided decoding for even longer. omp's provider layer (`packages/ai`) already
speaks both wire shapes to the two backends it's configured for — vLLM
(`vllm/qwen3.8-27b-ablit`, local) and Anthropic (`anthropic/claude-sonnet-5`,
via omp's auth broker) — it just has no CLI or RPC entry point that exposes
them. Neither `omp --print` nor `omp --mode rpc` accepts a `response_format`.
This repo is that missing entry point, built directly against the SDK.

**How the constraint actually reaches the wire** (see
`src/payload-injection.ts`): omp's cross-provider `SimpleStreamOptions` has no
`response_format`/`output_config`/`generationConfig`/etc. field for ANY api
family — verified by reading `packages/ai/src/types.ts` and every provider
file under `packages/ai/src/providers/` in the installed `18.2.8` source. The
real, documented extension point is `onPayload`: "Callback invoked with the
provider request payload just before sending. Return a replacement payload
object... to send it instead of the original" (`packages/ai` README). Every
built-in provider except `devin-agent` honors it. This CLI's `onPayload`
merges the correct provider-native structured-output field onto the exact
wire body omp was about to send, keyed off `model.api` (see "Supported api
families" below) — the provider then does real guided decoding. No tool
call, no `/force`, nothing the model can decline.

## Supported api families

`src/payload-injection.ts` covers every `KnownApi` value
(`@oh-my-pi/pi-catalog/types.ts`) that has a documented structured-output
wire field, verified against the installed `@oh-my-pi/pi-ai@18.2.8` provider
source (file references below) and, where noted, AWS's own Bedrock
documentation. **Live-verified** means an actual `scripts/acceptance.sh` run
against a real backend produced schema-valid output (see "Acceptance").
Every other row is **schema-verified only**: a pure-function unit test in
`src/payload-injection.test.ts` asserts the exact injected body shape against
a synthetic payload shaped like the real one, but no live backend/credential
for that family exists on this machine.

| `model.api` | Wire field injected | Provider source verified against | Status |
| --- | --- | --- | --- |
| `openai-completions` | `response_format: {type:"json_schema", json_schema:{name,schema,strict:true}}` | `providers/openai-completions.ts` | **Live-verified** (vLLM) |
| `anthropic-messages` | `output_config.format: {type:"json_schema", schema}` | `providers/anthropic.ts`, `providers/anthropic-wire.ts` | **Live-verified** (Anthropic) |
| `openai-responses` | `text.format: {type:"json_schema", name, schema, strict:true}` | `providers/openai-responses.ts`, `providers/openai-responses-wire.ts` | Schema-verified only |
| `openai-codex-responses` | same as `openai-responses` (identical `ResponseCreateParamsStreaming` wire shape on both its SSE and websocket transports) | `providers/openai-codex-responses.ts` | Schema-verified only |
| `azure-openai-responses` | same as `openai-responses` (imports the identical wire types) | `providers/azure-openai-responses.ts` | Schema-verified only |
| `openrouter` | **structurally ambiguous** - `text.format` when the payload carries `input` (Responses wire), `response_format` when it carries `messages` (Completions wire); see below | `stream.ts` (`case "openrouter"`), `providers/openai-responses.ts`, `providers/openai-completions.ts` | Schema-verified only |
| `google-generative-ai` | `config.{responseMimeType:"application/json", responseJsonSchema:schema}` on the SDK-shaped `GenerateContentParameters` `onPayload` actually receives (lifted onto the literal `generationConfig` wire key afterwards by `paramsToWireBody`) | `providers/google-shared.ts`, `providers/google.ts` | Schema-verified only |
| `google-vertex` | identical to `google-generative-ai` (shares the same `streamGoogleGenAI`/`buildGoogleGenerateContentParams` code path) | `providers/google-shared.ts`, `providers/google-vertex.ts` | Schema-verified only |
| `google-gemini-cli` | `request.generationConfig.{responseMimeType:"application/json", responseJsonSchema:schema}` (distinct `{project,model,request:{...}}` `CloudCodeAssistRequest` wire shape) | `providers/google-gemini-cli.ts` | Schema-verified only |
| `ollama-chat` | top-level `format: schema` (Ollama's own documented structured-output field; omp's own `createChatBody` does not set it at all, so this is the CLI adding a field omp never sends, not overriding one) | `providers/ollama.ts` | Schema-verified only |
| `bedrock-converse-stream` | `outputConfig.textFormat: {type:"json_schema", structure:{jsonSchema:{name, schema: JSON.stringify(schema)}}}` - `schema` is a **JSON-encoded string** here, unlike every other family, per AWS's own documented Converse-API shape | `providers/amazon-bedrock.ts` (no native structured-output field at all — confirmed by reading `commandInput`'s full type); wire shape confirmed against https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html | Schema-verified only |
| `cursor-agent`, `gitlab-duo-agent`, `devin-agent` | none — throws `UnsupportedApiError` | `providers/cursor.ts`, `providers/gitlab-duo-workflow.ts`, `providers/devin.ts` (agentic/terminal-driving transports, not a JSON completion API) | Not applicable |
| `mock` (SDK-internal test provider, not a `KnownApi` member) | none — throws `UnsupportedApiError` | `providers/mock.ts` | Not applicable |

Three real corrections to the api list this repo shipped with before this
change: there is no separate `"openai"`/`"anthropic"` api distinct from
`"openai-completions"`/`"anthropic-messages"` (`KnownApi` has no such
values — Kimi, for instance, is a `provider`, not an `api`; it rides
`openai-completions` via `providers/kimi.ts`'s
`streamKimi(model: Model<"openai-completions">, ...)`), and there is no
`"amazon-bedrock"` api — the real value is `"bedrock-converse-stream"`.

**`openrouter`'s wire shape is genuinely ambiguous at the api-discriminant
level, not just under-documented.** `packages/ai/src/stream.ts` dispatches an
`openrouter` model to either `streamOpenAIResponses` or
`streamOpenAICompletions` depending on `$env.PI_OPENROUTER_RESPONSES`
(default: Responses), via `providerModel as Model<"openai-responses">` — a
**TypeScript-only** cast (`castApi = (api) => api as OptionsForApi<Api>`).
The object `onPayload` actually receives at runtime still has
`model.api === "openrouter"` literally, in both branches — verified by
reading `castApi`'s implementation, not inferred. So `model.api` cannot
distinguish the two wire shapes; `src/payload-injection.ts`'s `openrouter`
injector instead detects the shape structurally from the payload's own keys
(`input` only exists on the Responses wire, `messages` only on the
Completions wire), and both branches are unit-tested.

Every one of the schema-verified-only rows above is implemented against the
real wire types/functions cited in its "Provider source verified against"
column, read directly from the installed `18.2.8` source
(`node_modules/@oh-my-pi/pi-ai/src/providers/*.ts`) — none are guesses from
the providers' public API docs alone, except `bedrock-converse-stream` (omp's
own Bedrock provider has no structured-output field of its own to read;
the wire shape there is AWS's documented one, cross-checked against the
`outputConfig`/`toolConfig`/`guardrailConfig` sibling fields omp's own
`ConverseStreamRequest` type already carries).

## Known local-model reliability note

The local `vllm/qwen3.8-27b-ablit` server is a hybrid-reasoning model, and
independent of constrained decoding it sometimes ends its turn (a clean
`stopReason: "stop"`) **entirely inside its own `<think>` segment**, emitting
no final-answer text at all. This reproduces identically with
`response_format` entirely absent, so it is a pre-existing model/template
termination trait, not something constrained decoding introduces — and every
turn that *does* leave its reasoning segment has produced schema-valid JSON,
100% of the time, across every trial run in this repo's history.

`reasoning: Effort.Medium` instead of omp's ambient `"low"` default for this
model (see `src/cli.ts`) measurably reduces how often this happens, but does
not eliminate it — so this repo does not pretend a reasoning-effort tweak is
a fix. See "One-shot session-read recovery" below for the actual mechanism.

## One-shot session-read recovery

**A bounded retry loop is forbidden here.** Regenerating the whole completion
from scratch on an answerless stop throws away real, completed reasoning
work and replaces it with a fresh, independent dice roll on the exact same
failure mode — neither deterministic nor a fix, just cost. `src/cli.ts`
issues at most one extra completion, ever, for this case; there is no retry
counter, no backoff, no loop.

omp's own guard for a related failure
(`packages/ai/src/stream.ts`'s `isRetryableThinkingLoop` /
`resolveWithThinkingLoopRetries`) only covers `stopReason: "error"` with
empty content — a stalled/errored stream. It does not cover a **well-formed**
`stopReason: "stop"` that simply never left the reasoning segment; that is
the case this repo handles, in `src/session-recovery.ts`.

**The mechanism** (`resolveAnswerlessTurnViaSession`), on an answerless
first turn:

1. **Persist the turn to a real omp session.** `SessionManager.create(cwd)` +
   `appendMessage(userMessage)` + `appendMessage(answerlessResult)` +
   `ensureOnDisk()` — the exact same `SessionManager` API `--session` already
   uses, writing a real `.jsonl` under `~/.omp/agent/sessions/<cwd-slug>/`
   with the model's thinking blocks intact, in whatever provider-specific
   shape omp itself persists them in.
2. **Read the persisted session back from disk** through omp's own read-only
   transcript loader,
   `@oh-my-pi/pi-coding-agent/session/session-loader`'s
   `loadSessionMessagesReadOnly(sessionFile)` — the same function a resumed
   omp session uses to rebuild provider-replayable history. This is the
   actual "read the persisted session" step: an independent reload from the
   file just written, not a reuse of the in-memory `AssistantMessage`
   object. It is one-shot because there is nothing left to compute: the
   model's reasoning already happened and is already durable on disk: this
   step only recovers it faithfully, through the same code path a real omp
   session resume would use, rather than trusting this process's own memory
   of what it just produced.
3. **If the persisted turn already carries visible text** (a defensive
   check only — the case that reached this code already failed that exact
   test once), use it directly; no continuation is issued.
4. **Otherwise, issue exactly one continuation turn in the same session**:
   append one new user message ("Your reasoning above is already complete.
   Do not reason further and do not call any tools. Output only the single
   final JSON object that satisfies the required schema now.") to the
   persisted history and call `completeSimple` once more. The model's own
   completed reasoning is history at this point, not something it is asked
   to redo — it only has to serialize what it already determined.
5. The continuation's `AssistantMessage` is also appended to the same
   session and flushed. If it *also* comes back answerless, `src/cli.ts`
   fails loudly (exit 4) — no further attempts are made, by design.

**A measured, real gap that needed a real fix, not just the mechanism above:**
`completionOptions.disableReasoning: true` alone was measured to be
**insufficient** to stop the continuation from re-entering `<think>` — live
testing against real vLLM caught `openai-completions.ts`'s own
provider-session reasoning-effort state still stamping a concrete wire
effort (`chat_template_kwargs: {enable_thinking: true, reasoning_effort:
"low"}`) onto the continuation request even with `options.reasoning ===
undefined` and `options.disableReasoning === true`. `onPayload` runs strictly
after all of that internal policy resolution, immediately before the request
is sent, so `src/session-recovery.ts`'s `forceReasoningOffOnWire` uses it as
the unconditional last-mile guarantee: it flips every reasoning/thinking
toggle omp's own policy resolution already populated on the wire body
(`enable_thinking`, `chat_template_kwargs.enable_thinking`,
`reasoning_effort`, `thinking`) to off, composed after the schema-constraint
`onPayload` from `payload-injection.ts` on the continuation call only. It
only flips fields already present on the wire body — it never adds an
unknown top-level key a strict-schema server (e.g. NVIDIA NIM) might reject.

`--session` is not required to trigger this mechanism: when the caller did
not pass `--session`, the session file this mechanism creates internally is
deleted (`fs.unlink`) once the run resolves, on both the success and the
eventual-failure path, so a `--no-session` (default) invocation leaves the
same zero-artifact footprint as before, whether or not recovery fired. When
the caller *did* pass `--session`, the recovery's session IS the one printed
via `--print-session-id` - the continuation, if any, is part of the same
session's history, not a second session.

With this in place, `scripts/acceptance.sh`'s 5-run large-schema check has
passed 5/5 against real vLLM on every measured run, with most (not
necessarily all) of those runs needing the one-shot continuation — see
"Acceptance" below for the current verbatim run's exact count.

## Usage

```
omp-structured --model <provider/model|pool/name> --json-schema <path|-> [options]

Required:
  --model <provider/model>   e.g. vllm/qwen3.8-27b-ablit or anthropic/claude-sonnet-5, or
                             pool/<name> to let omp-router pick the server (see below)
  --json-schema <path|->     JSON Schema file, or - to read it from stdin

Options:
  --prompt <path|->          Prompt file, or - to read it from stdin (default: read the whole prompt from stdin)
                             Single-user-message shortcut; mutually exclusive with --messages.
  --messages <path|->        Multi-turn transcript file (or - for stdin): a JSON array of
                             {role, content} objects, role one of user/assistant, and optionally
                             a single leading {role:"system", content} entry. Mutually exclusive
                             with --prompt.
  --system-prompt <path|->   System prompt file, or - to read it from stdin. Injected via omp's
                             Context.systemPrompt channel, ahead of --prompt/--messages. Composes
                             with a leading system entry in --messages (both are appended, in that
                             order, to the same systemPrompt array).
  --reasoning <effort>       off|minimal|low|medium|high|xhigh|max (default: medium, matching this
                             CLI's existing default reasoning effort). Maps to omp's Effort enum;
                             "off" requests disableReasoning instead of an Effort value.
  --cwd <dir>                Working directory for config/session discovery (default: process cwd)
  --profile <name>           Named omp profile (OMP_PROFILE), same isolation as `omp --profile`
  --session                  Write a real omp session .jsonl for this turn (default: --no-session)
  --no-session                (default)
  --timeout <seconds>        Abort the completion after N seconds (default: 120)
  --max-tokens <n>           Output-token budget for the completion, mapped to omp's
                             SimpleStreamOptions.maxTokens verbatim. Default: the resolved
                             model's own declared output limit (model.maxTokens from the omp
                             catalog). Pass this to override that default.
  --temperature <t>          Pinned sampling temperature (a finite number >= 0), injected onto the
                             provider's own wire body. Fails loud (exit 6) when the resolved
                             provider/model cannot honor it (a model that deprecated sampling
                             parameters) rather than silently sending an unpinned request.
  --seed <n>                 Pinned sampling seed (a non-negative integer), injected onto the
                             provider's own wire body for api families whose API has a seed field.
                             Fails loud (exit 6) naming the provider when the api has no seed.
  --print-session-id         With --session, also emit a stable "SESSION_ID=<id>" line on stderr
```

Stdout carries exactly one line: the schema-valid JSON object. Everything
else — progress, retries, the session id/path — goes to stderr. Exit 0 on a
schema-valid object; non-zero with a specific stderr message otherwise
(argument error: 2, unsupported provider API: 3, completion/model failure: 4,
schema validation failure: 5, a pinned decoding control the resolved
provider/model cannot honor: 6, omp-router could not place a `pool/` model: 7).

```bash
echo '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' \
  | omp-structured --model vllm/qwen3.8-27b-ablit --json-schema - --prompt -
```

### `pool/<name>` models

`--model pool/<name>` runs `omp-router acquire pool/<name>` (the
`local_agents/router` CLI; override the executable with `OMP_ROUTER_CLI`)
before resolving the model. The router picks a local server with a free slot,
else the pool's cloud fallback while it is within omp's usage reserve, else
queues (a warning on stderr) and fails when the queue is full or times out
(exit 7). The chosen member's thinking level replaces `--reasoning`, because
it is a property of that server. The lease belongs to this process and is
released when it exits.

### Requires Bun

The omp SDK (`engines.bun` in its own `package.json`) ships its `import`
condition pointing at raw `.ts` source and uses Bun-only APIs directly
(`Bun.hash`, `Bun.sleep`, `bun:sqlite` in its credential store). Plain Node
refuses to type-strip `.ts` under `node_modules` by design
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) and has no `Bun.*`
polyfill — this is not a build-tooling gap, it is what the vendored SDK
requires. `dist/cli.js` (built by `tsc`, dependencies left as bare
specifiers — not bundled) is executed with `bun dist/cli.js ...`, exactly
like omp's own `dist/cli.js` (`#!/usr/bin/env bun`).

## System prompt, multi-turn transcripts, and reasoning effort

**`--system-prompt` and `--messages`'s own leading system entry both feed
omp's `Context.systemPrompt: string[]` channel — never a `{role:"system"}`
message.** `@oh-my-pi/pi-ai/types`' `Context` shape is
`{ systemPrompt?: string[]; messages: Message[] }`: the system prompt is a
field on `Context` entirely separate from the message array, and every
provider that honors it reads it from there (verified against the installed
`18.2.8` source):

- `providers/openai-completions.ts`'s `normalizeSystemPrompts(context.systemPrompt)`
  turns it into a leading wire message with `role: "system"`, or
  `role: "developer"` when `model.reasoning && compat.supportsDeveloperRole`.
- `providers/anthropic.ts`'s `buildAnthropicSystemBlocks(context.systemPrompt, ...)`
  turns it into top-level Anthropic `system` blocks (never a message in
  Anthropic's `messages` array, which has no `system` role at all).

`src/transcript.ts`'s `assembleTranscriptContext` composes `--system-prompt`
(when given) and `--messages`' own leading `{"role":"system",...}` entry
(when present) into that same array, in that order, then converts every
remaining transcript entry into a typed SDK message: `{role:"user"}` becomes
a `UserMessage`; `{role:"assistant"}` becomes a synthetic `AssistantMessage`
whose `content` is `[{type:"text", text: entry.content}]`. The
`AssistantMessage` interface also requires `api`/`provider`/`model`/`usage`/
`stopReason` bookkeeping fields that a *real* completed turn would carry;
this CLI fills them with the resolved model's own identity and all-zero
usage, because none of that metadata is read by the outgoing wire
serialization for a *prior* turn — verified by reading both providers'
`msg.role === "assistant"` branches, which build the wire request from
`.content` alone (`providers/openai-completions.ts` around line 2149;
`providers/anthropic.ts`'s equivalent branch). `--prompt` (no `--messages`)
skips `transcript.ts` entirely and builds the same single-`UserMessage`
`Context` this CLI always has, with `systemPrompt` set to `[text]` when
`--system-prompt` was given.

**`--reasoning <effort>` maps onto `SimpleStreamOptions.reasoning`, an
`Effort` value from `@oh-my-pi/pi-catalog/src/effort.ts`.** That module's
entire runtime vocabulary, read directly from source, is exactly:
`minimal | low | medium | high | xhigh | max` — there is no `"auto"` member,
and no other reasoning-related SDK field (`model-thinking.ts`'s
`requireSupportedEffort`/`defaultSupportedEffort`, `SimpleStreamOptions`
itself) accepts one either, so `--reasoning auto` is rejected by argument
parsing rather than silently accepted and ignored. `--reasoning off` is this
CLI's own vocabulary on top of that enum: it maps to
`{ reasoning: undefined, disableReasoning: true }` rather than an `Effort`
member, since `disableReasoning` (not a special `Effort` value) is the SDK's
actual off-switch. Measured directly against real vLLM,
`disableReasoning: true` on `completionOptions` **alone is insufficient**:
`openai-completions.ts`'s own ambient per-model reasoning-effort default can
still stamp a concrete `chat_template_kwargs.reasoning_effort`/
`enable_thinking: true` onto the wire body underneath it (the same gap
`src/session-recovery.ts`'s one-shot continuation already had to work
around — see "One-shot session-read recovery" above). `--reasoning off`
therefore also composes `session-recovery.ts`'s exported
`forceReasoningOffOnWire` onto the request's `onPayload`, the same
unconditional last-mile wire-level guarantee the continuation call uses.
Omitting `--reasoning` entirely preserves this CLI's pre-existing default
(`Effort.Medium` for reasoning-capable models, unconditionally — see "Known
local-model reliability note" above) with byte-identical behavior to before
this flag existed. `--reasoning`'s effect on the real wire body is always
independently inspectable: every completion logs
`[omp-structured] wire reasoning fields: {...}` to stderr with whatever
subset of `reasoning_effort`/`chat_template_kwargs`/`thinking`/`reasoning`
the outgoing payload actually carries, non-mutating and composed after the
schema-constraint `onPayload`.

A model's own catalog entry can further restrict which `Effort` values it
accepts — `vllm/qwen3.8-27b-ablit`, on this machine, accepts only
`low`/`medium`/`xhigh` (`requireSupportedEffort` rejects `high` with
`Thinking effort high is not supported by vllm/qwen3.8-27b-ablit. Supported
efforts: low, medium, xhigh`); this CLI forwards `--reasoning` verbatim to
`completeSimple` and surfaces that rejection as a normal completion failure
(exit 4), rather than silently clamping to a supported value.

## Output-token budget

**The completion's output-token budget derives from the resolved model's own
declared output limit — `model.maxTokens` from the omp catalog — not a
hard-coded constant.** `--max-tokens <n>` overrides it and is forwarded to
`SimpleStreamOptions.maxTokens` verbatim, exactly as omp's own
`options.maxTokens ?? model.maxTokens` fallback resolves it (see
`@oh-my-pi/pi-ai/stream.ts`'s `mapOptionsForApi`). When neither the flag nor a
catalog limit is present the option is left unset and the provider applies its
own cap.

This replaced a fixed `maxTokens: 4096`. On `openai-completions`-family
backends (this machine's local `vllm/qwen3.8-27b-ablit`) that wire field is
the **total** output cap — thinking tokens included — so a mandatory-reasoning
model spent the whole 4096 inside its own `<think>` segment and the turn ended
`stopReason: "length"` before it ever emitted the final JSON, at every
reasoning effort. `vllm/qwen3.8-27b-ablit`'s catalog entry declares
`maxTokens: 16384` (`~/.omp/agent/models.yml`), which leaves room for the
reasoning trace and the schema-constrained answer both; the same
reasoning-heavy request that truncated under the old constant now completes
schema-valid. `scripts/acceptance.sh` check (h) is exactly that discriminating
pair: `--max-tokens 4096` truncates (`stopReason=length`, exit 4) while the
model-derived default completes.

**The budget is reported truthfully from the actual outgoing wire body, not
from what the CLI requested.** `--max-tokens ?? model.maxTokens` is only what
this CLI ASKS the SDK for; the provider layer may clamp it underneath. On the
anthropic auth-broker (OAuth) route, `providers/anthropic.ts` clamps
`max_tokens` to `Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000, model.maxTokens)`
— so `anthropic/claude-sonnet-5`, whose catalog `maxTokens` is 128000, actually
sends `max_tokens: 64000` on the wire. Reporting only the requested number
(128000, or worse, `source=unset`) would hide that finite cap. So every
completion logs BOTH lines to stderr: the request
(`[omp-structured] requested output budget: maxTokens=<n> (source=...)`) and,
authoritatively, the number actually on the wire read back through `onPayload`
(`[omp-structured] wire output budget: <n> (field=<wireField>, api=<api>)`).
The wire line is the real number sent; reading the wire is what makes
`source=unset` unable to hide a provider-fallback cap.

## Pinned decoding: temperature and seed

**`--temperature` and `--seed` pin a call's sampling so a graded oracle's
judge is a fixed grader, not a hidden live input** (exophial exo-d6a,
`docs/ORACLES.md`'s live-dependency rule). omp's cross-provider
`SimpleStreamOptions` carries a `temperature` but NO `seed` for any api family,
and even `temperature` is dropped by the anthropic provider for models that
deprecated sampling params (`compat.supportsSamplingParams === false`) — so
neither control can be pinned through `SimpleStreamOptions` alone. Both are
injected onto the exact outgoing wire body via the same `onPayload` mechanism
the schema constraint uses (`src/payload-injection.ts`), keyed off the resolved
`model.api`: flat `temperature`/`seed` for `openai-completions`, top-level
`temperature` for `anthropic-messages`/the Responses family, `config.*` for
Google, `options.*` for Ollama, `inferenceConfig.temperature` for Bedrock.
They are logged from the real wire body
(`[omp-structured] wire decoding fields: {...}`), so the pin reaching the
provider is inspectable, not merely trusted.

**A pinned control the resolved provider/model cannot honor fails loud (exit
6), naming the provider — never silently dropped.** A pinned decoding setting
that is silently discarded is not pinned. Temperature: the wire field exists on
every family, but a model can reject it — `anthropic/claude-sonnet-5` and
`anthropic/claude-opus-4-8` return `400 "temperature is deprecated for this
model"`, surfaced statically via `compat.supportsSamplingParams`, as do OpenAI
o-series/gpt-5. Seed: several api wires have no seed field at all
(`anthropic-messages`, the Responses family, `bedrock-converse-stream`, and
`openrouter` — whose runtime wire shape is chosen from `PI_OPENROUTER_RESPONSES`
and the Responses shape has no seed). In every such case the CLI refuses before
any network request rather than sending an unpinned one.

A live discriminating check against `anthropic/claude-sonnet-5` (2026-09-25):
`--temperature 0` and `--seed 42` each exit 6 naming `anthropic-messages`
before any request; the same request WITHOUT the flags logs
`requested output budget: maxTokens=128000 (source=model.maxTokens)` yet
`wire output budget: 64000 (field=max_tokens, api=anthropic-messages)` — the
real number sent, which the pre-fix single log hid. Determinism-when-honored
(temperature 0 + seed reaching the `openai-completions` wire identically twice)
is asserted by `src/payload-injection.test.ts`; no local vLLM live run is
included here.

## Build

```bash
npm install
npm run build        # tsc -p tsconfig.json -> dist/
bun dist/cli.js --help
```

## Upgrade path

The `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, and `@oh-my-pi/pi-coding-agent`
dependencies in `package.json` are pinned to the **exact** version `18.2.8`
(omp ships roughly twice a day; tracking `^`/`latest` would silently change
this CLI's behavior underneath its callers). To upgrade: bump all three pins
together to a specific new version, re-run `npm install`, re-run
`scripts/acceptance.sh` against real backends, and only then commit. Never
bump implicitly via `npm update`.

## Acceptance

`scripts/acceptance.sh` runs every check against real omp config/auth and
real backends — no recording stand-ins, no mocks for (a)-(e); (f) is the
pure-function unit-test suite (arg parsing, transcript assembly, and every
api family's payload injection, see "Supported api families" above):

- (a) the real ~22KB `exophial.ops.derivation_schema.proposal_or_escalate_schema()`
  (imported live via `uv run`, falling back to the installed exophial
  interpreter, then to a synthesized comparable-depth schema if neither is
  importable) vs `vllm/qwen3.8-27b-ablit`, run 5 times, reporting N/5
  schema-valid AND how many of the 5 needed the one-shot session-read
  continuation
- (b) `--system-prompt` demonstrably changes output vs `vllm/qwen3.8-27b-ablit`:
  a system prompt forcing `answer` to the literal string `SYSTEMOK`, run
  both with and without the flag, asserting the string appears only with it
- (c) `--messages` carries a 3-turn transcript (user/assistant/user) vs
  `vllm/qwen3.8-27b-ablit`, where the correct answer is a value only the
  earlier assistant turn stated, plus a `--prompt`+`--messages` invocation
  asserting it is rejected (exit 2)
- (d) `--reasoning off` and `--reasoning high` (falling back to `xhigh` when
  this model's own catalog entry rejects `high` — see "System prompt,
  multi-turn transcripts, and reasoning effort" above) vs
  `vllm/qwen3.8-27b-ablit`, both schema-valid, asserting the real wire
  body's reasoning fields (logged via `onPayload`) actually differ between
  the two
- (e) `--system-prompt` vs `anthropic/claude-sonnet-5` (best-effort; depends
  on the auth broker being reachable), asserting both schema-valid output
  and the system prompt honored
- (f) `bun test src` - `src/args.test.ts` (mutual exclusion, reasoning enum),
  `src/transcript.test.ts` (message-array validation, system-prompt
  composition), and `src/payload-injection.test.ts`'s per-api wire-shape
  assertions
- (g) `--session` still produces a real session `.jsonl` under
  `~/.omp/agent/sessions/<cwd-slug>/` whose header `id` matches the reported
  session id (regression check for pre-existing behavior)

```bash
npm run acceptance
```

A real run against this machine's vLLM + Anthropic (2026-09-22) produced:

```
(a) 5/5 schema-valid; 4/5 needed the one-shot session-read continuation
(b) PASS (system prompt honored with the flag: {"answer":"SYSTEMOK"}; not honored without it: {"answer":"hello"})
(c) PASS (transcript answer: {"answer":"FLAMINGO77"}; --prompt+--messages rejected, exit 2)
(d) PASS (--reasoning off wire: {"chat_template_kwargs":{"enable_thinking":false}}; --reasoning xhigh wire: {"chat_template_kwargs":{"enable_thinking":true,"reasoning_effort":"xhigh"}} — --reasoning high itself correctly rejected: "Thinking effort high is not supported by vllm/qwen3.8-27b-ablit. Supported efforts: low, medium, xhigh")
(e) PASS (exit 0, schema-valid, system prompt honored: {"answer":"SYSTEMOK"})
(f) 52 pass, 0 fail (88 expect() calls)
(g) PASS (file exists on disk, header id matches reported id)
```

## Exophial integration (exo-3904 / exo-c441 fix path)

A new `OmpStructuredCliTransport` in `exophial/llm_transport.py` would lower a
`CompletionRequest` to:

```bash
bun /path/to/omp-structured/dist/cli.js \
  --model <provider>/<model> \
  --json-schema <schema-tmpfile-path> \
  --messages <transcript-tmpfile-path>  # request.messages, the whole growing \
                                         # discuss/Slack transcript, as a JSON \
                                         # array of {role, content} \
  [--system-prompt <system-tmpfile-path>]  # when request carries a system prompt \
  [--reasoning <effort>]                # request.thinking_budget mapped to off/ \
                                         # minimal/low/medium/high/xhigh/max \
  [--temperature <t>]                   # request.temperature (grader.decoding pin) \
  [--seed <n>]                          # request.seed (grader.decoding pin) \
  --cwd <request.cwd> \
  --timeout <request.timeout> \
  [--profile <profile>] \
  [--session --print-session-id]        # only when persist_session=True
```

(`--prompt -` remains the single-user-message shortcut for any caller that
only ever sends one turn — unchanged from before this transcript/system-
prompt/reasoning widening.)

reading the printed stdout line as `structured_output` directly (already
schema-valid — no re-parsing a tool-call payload) and, when `--session` was
passed, reading the `SESSION_ID=<id>` stderr line for `session_id` — fixing
exo-c441 for free, since this CLI never aborts a live process: it calls
`completeSimple` once, appends the turn to a `SessionManager`, flushes, and
exits normally.

## License

MIT — see [LICENSE](LICENSE).
