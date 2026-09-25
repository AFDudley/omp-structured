#!/usr/bin/env bash
# One poll cycle: check upstream, and if a newer version exists, run the update+gate+publish.
# This is what the systemd timer triggers.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
source "$HERE/config.sh"

# Self-deploy: the scripts the service runs are the maintained checkout's, not a copy
# frozen at install time. The stable bootstrap (installed bin/) refreshes the checkout
# to upstream's tip ONCE, then hands the cycle to the checkout's own run.sh -- so an
# upstream change to check.sh/update.sh/config.sh reaches this very run with no manual
# re-install. Refreshing here, before any checkout script executes, also guarantees no
# running script is overwritten mid-cycle by ensure_checkout's `git checkout -f`.
if [ "${OMP_STRUCTURED_UPDATER_FROM_CHECKOUT:-}" != "1" ]; then
  ensure_checkout
  export OMP_STRUCTURED_UPDATER_FROM_CHECKOUT=1
  exec "$CHECKOUT/updater/run.sh" "$@"
fi

log "poll cycle start"
set +e
NEW="$("$HERE/check.sh")"; rc=$?
set -e
case "$rc" in
  0)  log "no update needed"; exit 0 ;;
  10) log "update available: $NEW -> running update"; exec "$HERE/update.sh" "$NEW" ;;
  *)  log "check failed (rc=$rc)"; exit "$rc" ;;
esac
