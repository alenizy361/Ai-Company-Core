#!/bin/bash
# Rabit "eyes on the server" — writes a status snapshot the brain reads, and
# pings the owner on Telegram when something crosses a danger threshold.
# Cron: */5 * * * *  (installed by server/install.sh)
set -euo pipefail
ENV_FILE=/etc/rabit-brain.env
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
STATUS="${RABIT_STATUS:-/opt/rabit-brain/status.json}"
BRAIN_DIR="$(dirname "$(readlink -f "$0")")/.."
ALERT_STAMP=/opt/rabit-brain/.last-alert

disk=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
load=$(awk '{print $1}' /proc/loadavg)
cores=$(nproc)
ram=$(free | awk '/Mem:/{printf "%d", $3/$2*100}')

svc_json="{"
for s in nginx rabit-brain rabit-worker rabit-telegram; do
  st=$(systemctl is-active "$s" 2>/dev/null || echo unknown)
  svc_json="$svc_json\"$s\":\"$st\","
done
svc_json="${svc_json%,}}"

cat > "$STATUS" <<EOF
{"disk_pct": $disk, "load": "$load", "ram_pct": $ram, "cores": $cores,
 "services": $svc_json, "ts": $(date +%s)}
EOF

# ---- danger thresholds -> Telegram alert (deduped to once per 30 min) ----
alerts=""
[ "$disk" -ge 88 ] && alerts="${alerts}القرص وصل ${disk}%. "
[ "$ram" -ge 92 ] && alerts="${alerts}الذاكرة وصلت ${ram}%. "
awk -v l="$load" -v c="$cores" 'BEGIN{exit !(l > c*2)}' && alerts="${alerts}ضغط المعالج مرتفع (load $load على $cores أنوية). "
for s in nginx rabit-brain rabit-worker; do
  [ "$(systemctl is-active "$s" 2>/dev/null || echo x)" != "active" ] && alerts="${alerts}خدمة $s متوقفة. "
done

if [ -n "$alerts" ] && [ -n "${TELEGRAM_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  now=$(date +%s); last=$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge 1800 ]; then
    echo "$now" > "$ALERT_STAMP"
    curl -s --max-time 15 "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=تنبيه من السيرفر يا مدير: ${alerts}" >/dev/null || true
  fi
fi
