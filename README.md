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
  `exophial.ops.derivation_schema`, both `claude-opus-4-8` and
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
no final-answer text at all. Measured directly against the raw SDK (no CLI, no
retry): trivial schema 2-3/8 turns produced text; large schema similarly
inconsistent. This reproduces identically with `response_format` entirely
absent, so it is a pre-existing model/template termination trait, not
something constrained decoding introduces — and every turn that *does* leave
its reasoning segment has produced schema-valid JSON, 100% of the time, across
every trial run in this repo's history.

Two mitigations, both implemented and both honest (neither hides the
underlying behavior, both are visible on stderr):

1. `reasoning: Effort.Medium` instead of omp's ambient `"low"` default for
   this model — measurably fewer answerless stops.
2. A bounded retry (`src/answer-retry.ts`, up to `ANSWER_RETRY_MAX_ATTEMPTS =
   20`, light backoff since the target is a local server) for exactly the
   "clean stop, zero text content" case — the sibling of omp's own
   `resolveWithThinkingLoopRetries` guard (`packages/ai/src/stream.ts`), which
   only covers the narrower `stopReason: "error"` empty-content stall and does
   not catch this `"stop"` variant.

With both in place, `scripts/acceptance.sh`'s 5-run large-schema check passed
5/5 (see below). Retries are logged to stderr; if you see them, that is this
model behaving as measured above, not the JSON Schema constraint failing.

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
- (b) the real ~22KB `exophial.ops.derivation_schema.proposal_or_escalate_schema()`
  (imported live via `uv run`; falls back to a synthesized comparable-depth
  schema if exophial isn't importable) vs `vllm/qwen3.8-27b-ablit`, run 5
  times, reporting N/5
- (c) trivial schema vs `anthropic/claude-sonnet-5` (best-effort; depends on
  the auth broker being reachable)
- (d) `--session` produces a real session `.jsonl` under
  `~/.omp/agent/sessions/<cwd-slug>/` whose header `id` matches the reported
  session id

```bash
npm run acceptance
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
