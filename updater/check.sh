#!/usr/bin/env bash
# Poll upstream. Refresh the maintained checkout to its tracked upstream, compare the
# pinned @oh-my-pi version to npm's latest.
#   exit 0  -> up to date (nothing on stdout)
#   exit 10 -> update available; the new version is printed to stdout
#   other   -> error
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/config.sh"

ensure_checkout() {
  if [ ! -d "$CHECKOUT/.git" ]; then
    log "cloning $REPO_SLUG -> $CHECKOUT"
    gh repo clone "$REPO_SLUG" "$CHECKOUT" -- --quiet
  fi
  cd "$CHECKOUT"
  git fetch --quiet
  local up; up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
  git reset --hard --quiet "$up"
  git clean -fd --quiet          # keep gitignored node_modules/ + dist/ across runs
}

ensure_checkout
PIN="$(pkg_pin "$ANCHOR_PACKAGE")"; PIN="${PIN#[\^~]}"
LATEST="$(npm view "$ANCHOR_PACKAGE" version)"
log "pin=$PIN latest=$LATEST"

if [ "$PIN" = "$LATEST" ]; then
  log "up to date"
  exit 0
fi
GREATER="$(printf '%s\n%s\n' "$PIN" "$LATEST" | sort -V | tail -1)"
if [ "$GREATER" = "$LATEST" ]; then
  log "update available: $PIN -> $LATEST"
  echo "$LATEST"
  exit 10
fi
log "pin ($PIN) is ahead of latest ($LATEST); nothing to do"
exit 0
