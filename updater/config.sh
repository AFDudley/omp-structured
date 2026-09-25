#!/usr/bin/env bash
# Shared configuration + helpers for the omp-structured auto-updater.
# Sourced by check.sh / update.sh / run.sh.
set -euo pipefail

REPO_SLUG="AFDudley/omp-structured"
# The @oh-my-pi SDK packages omp-structured pins; they version in lockstep.
PACKAGES=("@oh-my-pi/pi-ai" "@oh-my-pi/pi-catalog" "@oh-my-pi/pi-coding-agent")
ANCHOR_PACKAGE="@oh-my-pi/pi-ai"          # the package we poll for "latest"
UPDATER_MODEL="${OMP_STRUCTURED_UPDATER_MODEL:-vllm/qwen3.8-27b-ablit}"
UPDATE_MAX_TIME="${OMP_STRUCTURED_UPDATE_MAX_TIME:-45m}"

STATE_DIR="${OMP_STRUCTURED_UPDATER_STATE:-$HOME/.local/share/omp-structured-updater}"
CHECKOUT="$STATE_DIR/checkout"
LOG_DIR="$STATE_DIR/logs"

# bun + omp live under ~/.bun and ~/.local/bin; a systemd --user unit has a bare PATH.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

mkdir -p "$STATE_DIR" "$LOG_DIR"

# Logs go to STDERR so a caller can capture a script's real stdout (e.g. the version).
log() { printf '%s [omp-structured-updater] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

pkg_pin() { # <package> -> version string from the checkout's package.json
  node -e 'const p=require(process.argv[1]+"/package.json");process.stdout.write(String(p.dependencies[process.argv[2]]||""))' "$CHECKOUT" "$1"
}

ensure_checkout() { # put CHECKOUT on upstream's declared default branch, from any prior state
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
