#!/usr/bin/env bash
# One poll cycle: check upstream, and if a newer version exists, run the update+gate+publish.
# This is what the systemd timer triggers.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
source "$HERE/config.sh"

log "poll cycle start"
set +e
NEW="$("$HERE/check.sh")"; rc=$?
set -e
case "$rc" in
  0)  log "no update needed"; exit 0 ;;
  10) log "update available: $NEW -> running update"; exec "$HERE/update.sh" "$NEW" ;;
  *)  log "check failed (rc=$rc)"; exit "$rc" ;;
esac
