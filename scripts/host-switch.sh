#!/usr/bin/env bash
# Maintenance switch for one machine: stop the Host, apply, start it again and roll back when it
# does not answer HTTP within the timeout. Run it through systemd-run (docs/install.md) so that
# stopping the Host cannot also stop this script.
set -uo pipefail
machine=${1:?usage: host-switch.sh <machine>}
service=${DSH_SERVICE:-dsh-web.service}
url=${DSH_HEALTH_URL:-http://127.0.0.1:53083/}
timeout=${DSH_HEALTH_TIMEOUT:-60}
cd "$(dirname "$0")/.."

# Any HTTP answer below 500 means the Web Host is listening; authentication may still reject it.
healthy() {
  local deadline=$((SECONDS + timeout)) code
  while ((SECONDS < deadline)); do
    if systemctl --user is-active --quiet "$service"; then
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)
      [[ $code =~ ^[1-4][0-9][0-9]$ ]] && return 0
    fi
    sleep 2
  done
  return 1
}
start_healthy() { systemctl --user start "$service" && healthy; }

echo "[switch] stop $service"
systemctl --user stop "$service" || { echo "[switch] cannot stop $service; nothing changed"; exit 1; }
echo "[switch] apply $machine"
output=$(node scripts/dsh-config.mjs update --machine "$machine" --apply --json 2>&1)
status=$?
printf '%s\n' "$output"
backup=$(grep -oE '("backup": "|backup retained: )[^"; ]+' <<<"$output" | head -1 | sed -E 's/^("backup": "|backup retained: )//; s/\.$//')

if ((status == 0)) && start_healthy; then
  echo "[switch] done: $service answers at $url"
  exit 0
fi
echo "[switch] apply exit $status or $service unhealthy after ${timeout}s"
if [[ -n $backup ]]; then
  systemctl --user stop "$service"
  echo "[switch] roll back $backup"
  node scripts/dsh-config.mjs rollback --machine "$machine" --backup "$backup" || echo "[switch] rollback failed; backup kept: $backup"
fi
if start_healthy; then echo "[switch] previous installation restored and answering"; else echo "[switch] $service still unhealthy; inspect journalctl --user -u $service"; fi
exit 1
