#!/usr/bin/env bash
# Update omp-structured to a new @oh-my-pi version using the local model (via omp), then
# GATE on the repo's real acceptance suite before publishing. The agent proposes; acceptance
# decides. There is no fallback path: if the gate is red, we do not publish -- we fail loud.
#   env NO_PUSH=1 -> run everything except the final publish step (for rehearsal)
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/config.sh"

NEW_VERSION="${1:?usage: update.sh <new-version>}"
RUN_LOG="$LOG_DIR/update-$(date -u +%Y%m%dT%H%M%SZ)-$NEW_VERSION.log"
exec > >(tee -a "$RUN_LOG") 2>&1

cd "$CHECKOUT"
log "update start: -> $NEW_VERSION (repo=$CHECKOUT model=$UPDATER_MODEL)"

read -r -d '' TASK <<TASKEOF || true
Upstream oh-my-pi released SDK version $NEW_VERSION. In this repository:
1. Set every @oh-my-pi/pi-* dependency in package.json to exactly "$NEW_VERSION".
2. Run: npm install
3. Run: npm run build
4. If the SDK's stream / onPayload / ModelRegistry / completeSimple surface changed and the
   build or src/payload-injection.ts broke, adapt src/*.ts minimally to restore it. Do NOT
   remove or weaken constrained-decode coverage for any api family, and do NOT reintroduce a
   from-scratch retry loop -- the empty-answer case is handled once by reading the session.
5. Run: bash scripts/acceptance.sh -- and make it pass against the real providers.
Do NOT commit and do NOT publish. Leave your changes in the working tree only.
TASKEOF

log "invoking local model to perform the bump/adaptation"
omp -p "$TASK" --model "$UPDATER_MODEL" --cwd "$CHECKOUT" --auto-approve --max-time "$UPDATE_MAX_TIME" \
  || log "omp agent exited non-zero; proceeding to the independent gate anyway"

# --- Independent confirmation. Never trust the agent's self-report. ---
log "independent gate: bash scripts/acceptance.sh"
if ! bash scripts/acceptance.sh; then
  log "FAIL: acceptance red. NOT publishing. Working tree left in $CHECKOUT for inspection."
  exit 1
fi

ACTUAL="$(pkg_pin "$ANCHOR_PACKAGE")"; ACTUAL="${ACTUAL#[\^~]}"
if [ "$ACTUAL" != "$NEW_VERSION" ]; then
  log "FAIL: pin is $ACTUAL, expected $NEW_VERSION. Agent did not bump. NOT publishing."
  exit 1
fi
if git diff --quiet && git diff --cached --quiet; then
  log "FAIL: acceptance green but no changes to commit. NOT publishing."
  exit 1
fi

log "GREEN: acceptance passed and pin moved to $NEW_VERSION"
git add -A
git commit -m "chore: bump @oh-my-pi SDK to $NEW_VERSION

Automated by omp-structured-updater using ${UPDATER_MODEL}.
Independent acceptance (scripts/acceptance.sh) passed against real providers before publish."

if [ "${NO_PUSH:-0}" = "1" ]; then
  log "NO_PUSH=1 set; committed locally but not publishing. done (rehearsal)."
  exit 0
fi
git push
log "published to $REPO_SLUG. done."
