#!/bin/bash
# Rabit proactivity — a spoken-language morning brief the brain sends the owner
# FIRST, on Telegram, before he asks. Cron: 0 4 * * *  (= 7:00 Riyadh, UTC+3).
set -euo pipefail
ENV_FILE=/etc/rabit-brain.env
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
[ -z "${TELEGRAM_TOKEN:-}" ] && exit 0
[ -z "${TELEGRAM_CHAT_ID:-}" ] && exit 0

STATUS="${RABIT_STATUS:-/opt/rabit-brain/status.json}"
MEM="${RABIT_MEMORY:-/opt/rabit-brain/memory.md}"
CLAUDE_BIN="${RABIT_CLAUDE_BIN:-$(command -v claude || echo /usr/local/bin/claude)}"

status_txt=$(cat "$STATUS" 2>/dev/null || echo "{}")
mem_txt=$(head -c 2000 "$MEM" 2>/dev/null || echo "")

prompt="أنت رابِت، مساعد المدير الشخصي. اكتب موجز صباحي قصير جداً بالعربي (3-4 أسطر)،
ودّي وعملي، بدون إيموجي. حيّه بصباح الخير، واذكر باختصار حالة السيرفر إن كان فيها ملاحظة،
وذكّره بأهم شي من سياقه إن وُجد، واقترح خطوة مفيدة لليوم.
حالة السيرفر (JSON): ${status_txt}
ما تعرفه عن المدير: ${mem_txt}"

brief=$("$CLAUDE_BIN" -p "$prompt" --output-format json 2>/dev/null \
  | python3 -c "import sys,json;
try:
    print(json.load(sys.stdin).get('result',''))
except Exception:
    print('')" 2>/dev/null || echo "")

[ -z "$brief" ] && brief="صباح الخير يا مدير. السيرفر يعمل. جاهز لأوامرك اليوم."

curl -s --max-time 20 "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${brief}" >/dev/null || true
