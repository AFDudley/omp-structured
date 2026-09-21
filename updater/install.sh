#!/usr/bin/env bash
# Install the omp-structured auto-updater as a systemd --user timer on this machine.
# Copies the updater scripts to a stable location (outside the maintained checkout) and
# enables a daily poll. Idempotent: re-run to refresh the installed scripts.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"

STATE_DIR="${OMP_STRUCTURED_UPDATER_STATE:-$HOME/.local/share/omp-structured-updater}"
BIN="$STATE_DIR/bin"
SYSD="$HOME/.config/systemd/user"
mkdir -p "$BIN" "$SYSD"

for f in config.sh check.sh update.sh run.sh; do
  cp -f "$HERE/$f" "$BIN/$f"
  chmod 0755 "$BIN/$f"
done

sed "s#@BIN@#$BIN#g" "$HERE/omp-structured-updater.service.in" > "$SYSD/omp-structured-updater.service"
cp -f "$HERE/omp-structured-updater.timer" "$SYSD/omp-structured-updater.timer"
chmod 0644 "$SYSD/omp-structured-updater.timer"

systemctl --user daemon-reload
systemctl --user enable --now omp-structured-updater.timer

echo "installed to $BIN"
echo "--- timer ---"
systemctl --user status omp-structured-updater.timer --no-pager || true
echo "--- next run ---"
systemctl --user list-timers omp-structured-updater.timer --no-pager || true
