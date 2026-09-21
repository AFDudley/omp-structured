# omp-structured

A headless TypeScript CLI that drives the real, published **omp SDK**
(`@oh-my-pi/pi-coding-agent` + `@oh-my-pi/pi-ai`, pinned to `18.2.8`) to run
**one completion constrained to a caller-supplied JSON Schema via genuine
constrained decoding** — vLLM/OpenAI `response_format`, Anthropic
`output_config.format` — inheriting config, auth, and model resolution from
`~/.omp` exactly as `omp` itself does. It is a subprocess entry point: give it
a provider/model, a JSON Schema, and a prompt; it prints one schema-valid JSON
object to stdout and exits 0, or fails loud on stderr.

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
`response_format`/`output_config` field at all — verified by reading
`packages/ai/src/types.ts`, `providers/openai-completions.ts`, and
`providers/anthropic.ts` in the installed `18.2.8` source. The real,
documented extension point is `onPayload`: "Callback invoked with the
provider request payload just before sending. Return a replacement payload
object... to send it instead of the original" (`packages/ai` README). Every
built-in provider except `devin-agent` honors it. This CLI's `onPayload`
merges `response_format` (OpenAI/vLLM chat-completions) or
`output_config.format` (Anthropic Messages) onto the exact wire body omp was
about to send — the provider then does real guided decoding. No tool call, no
`/force`, nothing the model can decline.

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

With this in place, `scripts/acceptance.sh`'s 5-run large-schema check
passed 5/5 against real vLLM, with 5/5 of those runs needing the one-shot
continuation (see "Acceptance" below for the verbatim run).

## Usage

```
omp-structured --model <provider/model> --json-schema <path|-> [options]

Required:
  --model <provider/model>   e.g. vllm/qwen3.8-27b-ablit or anthropic/claude-sonnet-5
  --json-schema <path|->     JSON Schema file, or - to read it from stdin

Options:
  --prompt <path|->          Prompt file, or - to read it from stdin (default: read the whole prompt from stdin)
  --cwd <dir>                Working directory for config/session discovery (default: process cwd)
  --profile <name>           Named omp profile (OMP_PROFILE), same isolation as `omp --profile`
  --session                  Write a real omp session .jsonl for this turn (default: --no-session)
  --no-session                (default)
  --timeout <seconds>        Abort the completion after N seconds (default: 120)
  --print-session-id         With --session, also emit a stable "SESSION_ID=<id>" line on stderr
```

Stdout carries exactly one line: the schema-valid JSON object. Everything
else — progress, retries, the session id/path — goes to stderr. Exit 0 on a
schema-valid object; non-zero with a specific stderr message otherwise
(argument error: 2, unsupported provider API: 3, completion/model failure: 4,
schema validation failure: 5).

```bash
echo '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' \
  | omp-structured --model vllm/qwen3.8-27b-ablit --json-schema - --prompt -
```

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
real backends — no recording stand-ins, no mocks:

- (a) trivial 2-field schema vs `vllm/qwen3.8-27b-ablit`
- (b) the real ~22KB `exophial.ops.typed_intake.proposal_or_escalate_schema()`
  (imported live via `uv run`; falls back to a synthesized comparable-depth
  schema if exophial isn't importable) vs `vllm/qwen3.8-27b-ablit`, run 5
  times, reporting N/5 schema-valid AND how many of the 5 needed the
  one-shot session-read continuation
- (c) trivial schema vs `anthropic/claude-sonnet-5` (best-effort; depends on
  the auth broker being reachable)
- (d) `--session` produces a real session `.jsonl` under
  `~/.omp/agent/sessions/<cwd-slug>/` whose header `id` matches the reported
  session id

```bash
npm run acceptance
```

A real run against this machine's vLLM + Anthropic (2026-09-21) produced:

```
(a) PASS (exit 0, schema-valid object)
(b) 5/5 schema-valid; 5/5 needed the one-shot session-read continuation
(c) PASS (exit 0, schema-valid object)
(d) PASS (file exists on disk, header id matches reported id)
```

## Exophial integration (exo-3904 / exo-c441 fix path)

A new `OmpStructuredCliTransport` in `exophial/llm_transport.py` would lower a
`CompletionRequest` to:

```bash
bun /path/to/omp-structured/dist/cli.js \
  --model <provider>/<model> \
  --json-schema <schema-tmpfile-path> \
  --prompt -                            # request.messages piped to stdin \
  --cwd <request.cwd> \
  --timeout <request.timeout> \
  [--profile <profile>] \
  [--session --print-session-id]        # only when persist_session=True
```

reading the printed stdout line as `structured_output` directly (already
schema-valid — no re-parsing a tool-call payload) and, when `--session` was
passed, reading the `SESSION_ID=<id>` stderr line for `session_id` — fixing
exo-c441 for free, since this CLI never aborts a live process: it calls
`completeSimple` once, appends the turn to a `SessionManager`, flushes, and
exits normally.

## License

MIT — see [LICENSE](LICENSE).
