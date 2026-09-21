#!/usr/bin/env bash
# Acceptance checks for omp-structured, run against REAL omp config/auth and
# REAL backends (vLLM always; Anthropic when reachable) plus the pure-function
# unit tests for every api family with no live credentials here. No stand-ins,
# no mocks in (a)-(d) — every one of those is a live subprocess invocation of
# dist/cli.js against a real backend.
#
# Reports each check's pass/fail plainly, including the large-schema
# reliability check as an explicit N/5 count and, for each of the 5 runs, how
# many needed the one-shot session-read continuation (src/session-recovery.ts)
# now that the bounded retry loop is gone. Exits non-zero if any REQUIRED
# check (a, b, d, e) fails; the Anthropic check (c) is best-effort and
# reported separately since it depends on network/auth reachability outside
# this repo.
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
trap 'rm -f "$TRIVIAL_SCHEMA" "$TRIVIAL_PROMPT" "$LARGE_SCHEMA" "$LARGE_PROMPT"' EXIT

cat > "$TRIVIAL_SCHEMA" << 'EOF'
{"type":"object","properties":{"answer":{"type":"string"},"n":{"type":"integer"}},"required":["answer","n"],"additionalProperties":false}
EOF
cat > "$TRIVIAL_PROMPT" << 'EOF'
Reply with an object: answer should be the string "hello", n should be the integer 42.
EOF

overall_pass=true

echo "================================================================"
echo "(a) trivial schema vs vllm/qwen3.8-27b-ablit"
echo "================================================================"
out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-a.err)
code=$?
cat /tmp/omp-structured-a.err
if [ $code -eq 0 ]; then
  echo "STDOUT: $out"
  echo "RESULT: PASS (exit 0, schema-valid object)"
else
  echo "RESULT: FAIL (exit $code)"
  overall_pass=false
fi
echo

echo "================================================================"
echo "(b) LARGE schema (exo-3904 case, exophial.ops.typed_intake.proposal_or_escalate_schema()) vs vllm/qwen3.8-27b-ablit, x5 for reliability"
echo "================================================================"
if command -v uv >/dev/null 2>&1 && PYTHONPATH="${EXOPHIAL_REPO:-$HOME/code/git_puller/repos/exophial}/src" uv run --project "${EXOPHIAL_REPO:-$HOME/code/git_puller/repos/exophial}" python3 -c \
  'import json, exophial.ops.typed_intake as d; print(json.dumps(d.proposal_or_escalate_schema()))' > "$LARGE_SCHEMA" 2>/tmp/omp-structured-schema.err; then
  echo "Using exophial's real proposal_or_escalate_schema() ($(wc -c < "$LARGE_SCHEMA") bytes)"
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
  out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$LARGE_SCHEMA" --prompt "$LARGE_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-b-$i.err)
  code=$?
  elapsed=$(( $(date +%s) - start ))
  needed_continuation=$(grep -c "one-shot session read" /tmp/omp-structured-b-$i.err || true)
  if [ "$needed_continuation" -gt 0 ]; then
    large_continuations=$((large_continuations + 1))
  fi
  if [ $code -eq 0 ]; then
    echo "PASS (${elapsed}s, one-shot session-read continuation needed: $([ "$needed_continuation" -gt 0 ] && echo yes || echo no)): $out"
    large_pass=$((large_pass + 1))
  else
    echo "FAIL (${elapsed}s, exit $code):"
    cat /tmp/omp-structured-b-$i.err
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
echo "(c) trivial schema vs anthropic/claude-sonnet-5 (best-effort; reachability-dependent)"
echo "================================================================"
if out=$("$CLI" --model anthropic/claude-sonnet-5 --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --cwd "$SCRATCH_CWD" 2>/tmp/omp-structured-c.err); then
  echo "STDOUT: $out"
  echo "RESULT: PASS (exit 0, schema-valid object)"
else
  code=$?
  echo "RESULT: SKIPPED/FAILED (exit $code) — anthropic not reachable via omp auth broker, or another error:"
  cat /tmp/omp-structured-c.err
fi
echo

echo "================================================================"
echo "(d) --session writes a real session .jsonl under ~/.omp/agent/sessions/<cwd-slug>/"
echo "================================================================"
out=$("$CLI" --model vllm/qwen3.8-27b-ablit --json-schema "$TRIVIAL_SCHEMA" --prompt "$TRIVIAL_PROMPT" --cwd "$SCRATCH_CWD" --session --print-session-id 2>/tmp/omp-structured-d.err)
code=$?
cat /tmp/omp-structured-d.err
session_id=$(grep -oE 'SESSION_ID=[a-zA-Z0-9-]+' /tmp/omp-structured-d.err | cut -d= -f2)
session_file=$(grep -oE 'file=\S+' /tmp/omp-structured-d.err | head -1 | cut -d= -f2)
if [ $code -eq 0 ] && [ -n "$session_id" ] && [ -f "$session_file" ] && grep -q "\"id\":\"$session_id\"" "$session_file"; then
  echo "STDOUT: $out"
  echo "session id: $session_id"
  echo "session file: $session_file"
  echo "RESULT: PASS (file exists on disk, header id matches reported id)"
else
  echo "RESULT: FAIL (exit $code, session_id='$session_id', session_file='$session_file')"
  overall_pass=false
fi
echo

echo "================================================================"
echo "(e) per-api unit tests for every api family with no live credentials here (pure functions, no network)"
echo "================================================================"
if bun test src 2>&1 | tee /tmp/omp-structured-e.out; then
  echo "RESULT: PASS (all payload-injection.test.ts cases passed)"
else
  echo "RESULT: FAIL"
  overall_pass=false
fi
echo

echo "================================================================"
echo "SUMMARY"
echo "================================================================"
if $overall_pass; then
  echo "All required checks (a, b, d, e) passed. See above for (c)."
  exit 0
else
  echo "At least one required check FAILED. See above."
  exit 1
fi
