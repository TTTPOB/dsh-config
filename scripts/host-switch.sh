#!/usr/bin/env bash
# Maintenance switch for one machine: stop the Host, apply, start it again and roll back when it
# does not answer HTTP within the timeout. Run it through systemd-run (docs/install.md) so that
# stopping the Host cannot also stop this script.
set -uo pipefail
machine=${1:?usage: host-switch.sh <machine>}
service=${DSH_SERVICE:-dsh-web.service}
url=${DSH_HEALTH_URL:-http://127.0.0.1:53083/}
timeout=${DSH_HEALTH_TIMEOUT:-60}
apply_timeout=${DSH_APPLY_TIMEOUT:-180}
rollback_timeout=${DSH_ROLLBACK_TIMEOUT:-180}
# Validate before stopping the Host; timeout without --foreground owns a process group.
for value in "$timeout" "$apply_timeout" "$rollback_timeout"; do
  [[ $value =~ ^[1-9][0-9]*$ ]] || { echo "[switch] timeouts must be positive integer seconds" >&2; exit 1; }
done
for command in timeout tee mktemp; do
  command -v "$command" >/dev/null || { echo "[switch] missing command: $command" >&2; exit 1; }
done
output=$(mktemp) || exit 1
trap 'rm -f "$output"' EXIT
cd "$(dirname "$0")/.."

# Any HTTP answer below 500 means the Web Host is listening; authentication may still reject it.
healthy() {
  local deadline=$((SECONDS + timeout)) code
  while ((SECONDS < deadline)); do
    if systemctl --user is-active --quiet "$service"; then
      code=$(curl --noproxy "*" -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)
      [[ $code =~ ^[1-4][0-9][0-9]$ ]] && return 0
    fi
    sleep 2
  done
  return 1
}
start_healthy() { systemctl --user start "$service" && healthy; }

run_bounded() {
  local limit=$1
  shift
  # Keep the group leader alive until KILL even if Node exits on TERM but pnpm does not.
  CI=true timeout --kill-after=5s "${limit}s" bash -c '
    trap "while :; do sleep 1; done" TERM
    "$@" &
    wait "$!"
  ' _ "$@"
}

echo "[switch] stop $service"
systemctl --user stop "$service" || { echo "[switch] cannot stop $service; nothing changed"; exit 1; }
echo "[switch] apply $machine"
# Stream both channels to stderr while retaining backup information, even on timeout.
run_bounded "$apply_timeout" node scripts/dsh-config.mjs update --machine "$machine" --apply --json 2>&1 | tee "$output" >&2
status=${PIPESTATUS[0]}
backup=$(sed -n 's/^\[apply\] backup ready: //p' "$output" | head -1)
if [[ -z $backup ]]; then
  backup=$(sed -nE 's/.*"backup": "(.*)"[,]?$/\1/p; s/.*backup retained: (.*)\. Installation may have changed.*/\1/p' "$output" | head -1)
fi

if ((status == 0)) && start_healthy; then
  echo "[switch] done: $service answers at $url"
  exit 0
fi
echo "[switch] apply exit $status or $service unhealthy after ${timeout}s"
restored=false
if [[ -n $backup ]]; then
  if systemctl --user stop "$service"; then
    echo "[switch] roll back $backup"
    if run_bounded "$rollback_timeout" node scripts/dsh-config.mjs rollback --machine "$machine" --backup "$backup"; then
      restored=true
    else
      echo "[switch] rollback failed (exit $?); backup kept: $backup" >&2
    fi
  else
    echo "[switch] cannot stop $service; rollback skipped; backup kept: $backup" >&2
  fi
else
  echo "[switch] no backup reported; rollback not performed" >&2
fi
if start_healthy; then
  if $restored; then echo "[switch] previous installation restored and answering";
  else echo "[switch] $service answers, but installation restoration is not confirmed"; fi
else
  echo "[switch] $service still unhealthy; inspect journalctl --user -u $service"
fi
exit 1
