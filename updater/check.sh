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
  git fetch --quiet origin
  # The maintained checkout's state is a function of upstream alone: derive the
  # branch upstream itself declares as default and land on it from ANY prior HEAD
  # (detached, another branch, or a dirty tree), never depending on a locally
  # configured @{u} that a detached HEAD would leave unresolvable.
  git remote set-head origin --auto >/dev/null
  local default; default="$(git symbolic-ref --short refs/remotes/origin/HEAD)"  # e.g. origin/main
  git checkout -f -B "${default#origin/}" --quiet "$default"
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
