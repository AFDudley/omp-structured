#!/usr/bin/env bash
# Acceptance checks for omp-structured, run against REAL omp config/auth and
# REAL backends (vLLM always; Anthropic when reachable) plus the pure-function
# unit tests for every api family/arg-parsing/transcript-assembly case with no
# live credentials required. No stand-ins, no mocks in (a)-(e) — every one of
# those is a live subprocess invocation of dist/cli.js against a real backend.
#
# Lettering matches the CLI's full input contract:
#   (a) large-schema (~22KB exophial proposal_or_escalate_schema) reliability, x5, vs vLLM
#   (b) --system-prompt demonstrably changes output, both directions, vs vLLM
#   (c) --messages carries a multi-turn transcript, and --prompt+--messages is rejected, vs vLLM
#   (d) --reasoning is honored and independently observable on the real wire body, vs vLLM
#   (e) --system-prompt vs real Anthropic (best-effort; depends on the auth broker being reachable)
#   (f) unit tests: arg parsing (mutual exclusion, reasoning enum) + transcript assembly (message-array validation) + per-api payload injection
#   (g) --session still produces a real session .jsonl (regression check for pre-existing behavior)
#   (h) the output-token budget derives from the resolved model's declared output limit: a
#       reasoning-heavy request truncates (stopReason=length) under an explicit small
#       --max-tokens but completes schema-valid under the derived default, vs vLLM
# Exits non-zero if any REQUIRED check (a, b, c, d, f, g, h) fails; (e) is
# best-effort and reported separately since it depends on network/auth
# reachability outside this repo.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

chmod +x dist/cli.js 2>/dev/null || true
CLI="./dist/cli.js"
SCRATCH_CWD="${OMP_STRUCTURED_ACCEPTANCE_CWD:-/tmp/omp-structured-acceptance-cwd}"
mkdir -p "$SCRATCH_CWD"

TRIVIAL_SCHEMA=$(mktemp)
TRIVIAL_PROMPT=$(mktemp)
LARGE_SCHEMA=$(mktemp)
LARGE_PROMPT=$(mktemp)
SYSTEM_PROMPT=$(mktemp)
TRANSCRIPT=$(mktemp)
REASONING_SCHEMA=$(mktemp)
REASONING_PROMPT=$(mktemp)
trap 'rm -f "$TRIVIAL_SCHEMA" "$TRIVIAL_PROMPT" "$LARGE_SCHEMA" "$LARGE_PROMPT" "$SYSTEM_PROMPT" "$TRANSCRIPT" "$REASONING_SCHEMA" "$REASONING_PROMPT"' EXIT

cat > "$TRIVIAL_SCHEMA" << 'EOF'
{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}
EOF
cat > "$TRIVIAL_PROMPT" << 'EOF'
Reply with an object: answer should be any short string of your choosing.
EOF

overall_pass=true

echo "================================================================"
echo "(a) LARGE schema (exo-3904 case, exophial.ops.derivation_schema.proposal_or_escalate_schema()) vs vllm/qwen3.8-27b-ablit, x5 for reliability"
echo "================================================================"
if command -v uv >/dev/null 2>&1 && PYTHONPATH="${EXOPHIAL_REPO:-$HOME/code/git_puller/repos/exophial}/src" uv run --project "${EXOPHIAL_REPO:-$HOME/code/git_puller/repos/exophial}" python3 -c \
  'import json, exophial.ops.derivation_schema as d; print(json.dumps(d.proposal_or_escalate_schema()))' > "$LARGE_SCHEMA" 2>/tmp/omp-structured-schema.err; then
  echo "Using exophial's real proposal_or_escalate_schema() ($(wc -c < "$LARGE_SCHEMA") bytes)"
elif [ -x "$HOME/.local/share/uv/tools/exophial/bin/python" ] && "$HOME/.local/share/uv/tools/exophial/bin/python" -c \
  'import json, exophial.ops.derivation_schema as d; print(json.dumps(d.proposal_or_escalate_schema()))' > "$LARGE_SCHEMA" 2>/tmp/omp-structured-schema.err; then
  echo "Using exophial's real proposal_or_escalate_schema() via the installed exophial interpreter ($(wc -c < "$LARGE_SCHEMA") bytes)"
else
  echo "exophial not importable ($(cat /tmp/omp-structured-schema.err 2>/dev/null)); synthesizing a comparable-size/depth schema"
  python3 - > "$LARGE_SCHEMA" << 'PYEOF'
import json

def leaf(name):
    return {"type": "object", "additionalProperties": False, "required": ["id", "text"],
            "properties": {"id": {"type": "string"}, "text": {"type": "string"}, "tag": {"const": name}}}

def branch(name, depth):
    if depth == 0:
        return leaf(name)
    return {"type": "object", "additionalProperties": False, "required": ["kind", "children"],
            "properties": {"kind": {"const": name}, "children": {"type": "array", "minItems": 1,
                "items": {"oneOf": [branch(f"{name}.{i}", depth - 1) for i in range(3)]}}}}

schema = {"type": "object", "additionalProperties": False, "required": ["result"],
          "properties": {"result": {"oneOf": [
              {"type": "object", "additionalProperties": False, "required": ["escalate", "reason"],
               "properties": {"escalate": {"const": True}, "reason": {"type": "string"}}},
              branch("root", 5),
          ]}}}
print(json.dumps(schema))
PYEOF
  echo "Synthesized schema ($(wc -c < "$LARGE_SCHEMA") bytes)"
fi

cat > "$LARGE_PROMPT" << 'EOF'
You must respond with a single JSON object that matches the required schema exactly.
Take the "escalate" branch of the top-level oneOf: set "escalate" to true (boolean literal true, not a string) and "reason" to a short one-sentence string explaining this is a reliability test. Do not include any other branch's fields.
EOF

large_pass=0
large_total=5
large_continuations=0
for i in $(seq 1 $large_total); do
  echo "--- run $i/$large_total ---"
  start=$(date +%s)
  out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$LARGE_SCHEMA" --prompt "$LARGE_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-a-$i.err)
  code=$?
  elapsed=$(( $(date +%s) - start ))
  needed_continuation=$(grep -c "one-shot session read" /tmp/omp-structured-a-$i.err || true)
  if [ "$needed_continuation" -gt 0 ]; then
    large_continuations=$((large_continuations + 1))
  fi
  if [ $code -eq 0 ]; then
    echo "PASS (${elapsed}s, one-shot session-read continuation needed: $([ "$needed_continuation" -gt 0 ] && echo yes || echo no)): $out"
    large_pass=$((large_pass + 1))
  else
    echo "FAIL (${elapsed}s, exit $code):"
    cat /tmp/omp-structured-a-$i.err
  fi
done
echo
echo "LARGE-SCHEMA RESULT: ${large_pass}/${large_total} schema-valid; ${large_continuations}/${large_total} needed the one-shot session-read continuation"
if [ "$large_pass" -ne "$large_total" ]; then
  echo "NOT 5/5 RELIABLE — reporting plainly as required."
  overall_pass=false
fi
echo

echo "================================================================"
echo "(b) --system-prompt demonstrably changes output vs vllm/qwen3.8-27b-ablit (both directions)"
echo "================================================================"
cat > "$SYSTEM_PROMPT" << 'EOF'
Always set answer to the exact string SYSTEMOK, regardless of what the user asks.
EOF
with_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --system-prompt "$SYSTEM_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-b-with.err)
with_code=$?
without_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-b-without.err)
without_code=$?
echo "WITH --system-prompt:    exit=$with_code stdout=$with_out"
echo "WITHOUT --system-prompt: exit=$without_code stdout=$without_out"
if [ $with_code -eq 0 ] && [ $without_code -eq 0 ] && echo "$with_out" | grep -q '"answer":"SYSTEMOK"' && ! echo "$without_out" | grep -q '"answer":"SYSTEMOK"'; then
  echo "RESULT: PASS (system prompt honored with the flag, not honored without it)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo

echo "================================================================"
echo "(c) --messages carries a multi-turn transcript vs vllm/qwen3.8-27b-ablit; --prompt+--messages together is rejected"
echo "================================================================"
cat > "$TRANSCRIPT" << 'EOF'
[
  {"role": "user", "content": "I'm going to tell you a secret code word. Just acknowledge it briefly."},
  {"role": "assistant", "content": "Understood, please share the code word."},
  {"role": "user", "content": "The secret code word is FLAMINGO77. Now, respond with the JSON object: set answer to exactly the secret code word I just gave you, nothing else."}
]
EOF
transcript_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --messages "$TRANSCRIPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-c.err)
transcript_code=$?
echo "--messages run: exit=$transcript_code stdout=$transcript_out"
"$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --messages "$TRANSCRIPT" --prompt "$TRIVIAL_PROMPT" --cwd "$SCRATCH_CWD" >/tmp/omp-structured-c-reject.out 2>/tmp/omp-structured-c-reject.err
reject_code=$?
echo "--prompt + --messages together: exit=$reject_code (expect 2)"
if [ $transcript_code -eq 0 ] && echo "$transcript_out" | grep -q '"answer":"FLAMINGO77"' && [ $reject_code -eq 2 ]; then
  echo "RESULT: PASS (answer reflects the transcript's earlier assistant turn; --prompt+--messages rejected)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo

echo "================================================================"
echo "(d) --reasoning is honored and reaches the real wire body vs vllm/qwen3.8-27b-ablit"
echo "================================================================"
off_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --reasoning off --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-d-off.err)
off_code=$?
off_wire=$(grep "wire reasoning fields" /tmp/omp-structured-d-off.err | tail -1)
echo "--reasoning off:  exit=$off_code stdout=$off_out"
echo "                  $off_wire"
# This model's own catalog entry (~/.omp/agent/models.yml) restricts which
# Effort values it accepts; asking for an unsupported one is a real,
# expected completion failure (see README "System prompt, multi-turn
# transcripts, and reasoning effort"), not a bug in this CLI. Try "high"
# first per the documented contract; fall back to "xhigh" (this model's
# actual highest supported effort) and report which one was used.
high_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --reasoning high --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-d-high.err)
high_code=$?
high_level="high"
if [ $high_code -ne 0 ] && grep -q "is not supported by" /tmp/omp-structured-d-high.err; then
  echo "--reasoning high: exit=$high_code REJECTED by this model's own catalog entry ($(grep 'is not supported by' /tmp/omp-structured-d-high.err)); falling back to --reasoning xhigh"
  high_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --reasoning xhigh --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-d-high.err)
  high_code=$?
  high_level="xhigh"
fi
high_wire=$(grep "wire reasoning fields" /tmp/omp-structured-d-high.err | tail -1)
echo "--reasoning $high_level: exit=$high_code stdout=$high_out"
echo "                  $high_wire"
if [ $off_code -eq 0 ] && [ $high_code -eq 0 ] && echo "$off_wire" | grep -q '"enable_thinking":false' && ! echo "$off_wire" | grep -q "reasoning_effort" && echo "$high_wire" | grep -q "\"reasoning_effort\":\"$high_level\""; then
  echo "RESULT: PASS (both schema-valid; the real wire body's reasoning fields differ exactly as --reasoning requested)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo

echo "================================================================"
echo "(e) --system-prompt vs anthropic/claude-sonnet-5 (best-effort; reachability-dependent)"
echo "================================================================"
if out=$("$CLI" --model anthropic/claude-sonnet-5 --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --system-prompt "$SYSTEM_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-e.err); then
  echo "STDOUT: $out"
  if echo "$out" | grep -q '"answer":"SYSTEMOK"'; then
    echo "RESULT: PASS (exit 0, schema-valid, system prompt honored)"
  else
    echo "RESULT: FAIL (schema-valid but system prompt not honored)"
  fi
else
  echo "RESULT: SKIPPED/FAILED (best-effort; see /tmp/omp-structured-e.err)"
  cat /tmp/omp-structured-e.err
fi
echo

echo "================================================================"
echo "(f) unit tests: arg parsing, transcript assembly, per-api payload injection (pure functions, no network)"
echo "================================================================"
if bun test src 2>&1 | tee /tmp/omp-structured-f.out; then
  echo "RESULT: PASS (args.test.ts + transcript.test.ts + payload-injection.test.ts all passed)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo

echo "================================================================"
echo "(g) --session still writes a real session .jsonl under ~/.omp/agent/sessions/<cwd-slug>/ (regression check)"
echo "================================================================"
out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --cwd "$SCRATCH_CWD" --session --print-session-id 2>/tmp/omp-structured-g.err)
code=$?
cat /tmp/omp-structured-g.err
session_id=$(grep -oE 'SESSION_ID=[a-zA-Z0-9-]+' /tmp/omp-structured-g.err | cut -d= -f2)
session_file=$(grep -oE 'file=\S+' /tmp/omp-structured-g.err | head -1 | cut -d= -f2)
if [ $code -eq 0 ] && [ -n "$session_id" ] && [ -f "$session_file" ] && grep -q "\"id\":\"$session_id\"" "$session_file"; then
  echo "RESULT: PASS (file exists on disk, header id matches reported id)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo
echo "================================================================"
echo "(h) output-token budget derives from the model's declared output limit; --max-tokens overrides it, vs vllm/qwen3.8-27b-ablit"
echo "================================================================"
# A reasoning-heavy request whose <think> segment alone exceeds a small total
# output cap. Under an explicit tiny --max-tokens the whole budget is spent in
# reasoning and the turn truncates (stopReason=length, exit 4); under the
# derived default (model.maxTokens from the omp catalog) the same request has
# room to finish and emits schema-valid JSON. This is the discriminating check
# for the fix that replaced the hard-coded maxTokens:4096 with a model-derived
# budget: the truncating cap is exactly the old constant.
cat > "$REASONING_SCHEMA" << 'EOF'
{"type":"object","additionalProperties":false,"properties":{"houses":{"type":"array","minItems":5,"maxItems":5,"items":{"type":"object","additionalProperties":false,"properties":{"position":{"type":"integer"},"color":{"type":"string"},"nationality":{"type":"string"},"drink":{"type":"string"},"cigarette":{"type":"string"},"pet":{"type":"string"}},"required":["position","color","nationality","drink","cigarette","pet"]}},"water_drinker":{"type":"string"},"zebra_owner":{"type":"string"}},"required":["houses","water_drinker","zebra_owner"]}
EOF
cat > "$REASONING_PROMPT" << 'EOF'
Solve this classic logic puzzle completely and carefully, deducing every attribute of all five houses.

There are five houses in a row, numbered 1 to 5 from left to right. Each house has a different color, and is occupied by a person of a different nationality, who drinks a different beverage, smokes a different brand of cigarette, and keeps a different pet.

Clues:
1. The Englishman lives in the red house.
2. The Spaniard owns the dog.
3. Coffee is drunk in the green house.
4. The Ukrainian drinks tea.
5. The green house is immediately to the right of the ivory house.
6. The Old Gold smoker owns snails.
7. Kools are smoked in the yellow house.
8. Milk is drunk in the middle house.
9. The Norwegian lives in the first house.
10. The man who smokes Chesterfields lives next to the man with the fox.
11. Kools are smoked in the house next to the house where the horse is kept.
12. The Lucky Strike smoker drinks orange juice.
13. The Japanese smokes Parliaments.
14. The Norwegian lives next to the blue house.

Reason step by step through all constraints, then report the full solution: for every house give its position, color, nationality, drink, cigarette, and pet, and state who drinks water and who owns the zebra.
EOF
# Both runs generate a full reasoning trace; the default run may spend up to the
# model's declared output limit. Derive each --timeout from its token budget so a
# slow backend never races the CLI's 120s default and reports a false FAIL: a
# conservative floor throughput plus fixed model-load/prompt headroom.
H_FLOOR_TOKENS_PER_SEC=10                 # slow-hardware generation floor
H_STARTUP_SECONDS=60                      # model load + prompt processing headroom
H_CAPPED_BUDGET=4096                      # the explicit --max-tokens below (old constant)
H_DEFAULT_BUDGET=16384                    # vllm/qwen3.8-27b-ablit's declared model.maxTokens
capped_timeout=$(( H_STARTUP_SECONDS + H_CAPPED_BUDGET / H_FLOOR_TOKENS_PER_SEC ))
default_timeout=$(( H_STARTUP_SECONDS + H_DEFAULT_BUDGET / H_FLOOR_TOKENS_PER_SEC ))
capped_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$REASONING_SCHEMA" --prompt "$REASONING_PROMPT" --max-tokens 4096 --timeout "$capped_timeout" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-h-capped.err)
capped_code=$?
capped_budget=$(grep "maxTokens=" /tmp/omp-structured-h-capped.err | tail -1)
echo "--max-tokens 4096 (old constant): exit=$capped_code"
echo "                  $capped_budget"
grep -q "stopReason=length" /tmp/omp-structured-h-capped.err && echo "                  truncated: stopReason=length" || echo "                  (no length truncation observed)"
default_out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$REASONING_SCHEMA" --prompt "$REASONING_PROMPT" --timeout "$default_timeout" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-h-default.err)
default_code=$?
default_budget=$(grep "maxTokens=" /tmp/omp-structured-h-default.err | tail -1)
echo "default (model-derived budget):   exit=$default_code stdout=${default_out:0:120}..."
echo "                  $default_budget"
if [ $capped_code -ne 0 ] && grep -q "stopReason=length" /tmp/omp-structured-h-capped.err \
   && [ $default_code -eq 0 ] && echo "$default_out" | grep -q '"zebra_owner"' \
   && echo "$default_budget" | grep -q "source=model.maxTokens"; then
  echo "RESULT: PASS (old 4096 cap truncates; model-derived default completes schema-valid)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo

echo "================================================================"
echo "SUMMARY"
echo "================================================================"
if $overall_pass; then
  echo "All required checks (a, b, c, d, f, g, h) passed. See above for (e)."
  exit 0
else
  echo "At least one required check FAILED. See above."
  exit 1
fi
