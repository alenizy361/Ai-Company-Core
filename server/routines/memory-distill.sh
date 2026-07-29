#!/bin/bash
# Rabit long-term memory — once a night, distill the day's conversation into a
# compact "what I know about the owner" file that gets injected into every
# future system prompt. Cron: 30 2 * * *  (= 5:30 Riyadh).
set -euo pipefail
ENV_FILE=/etc/rabit-brain.env
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
DB="${RABIT_DB:-/opt/rabit-brain/rabit.db}"
MEM="${RABIT_MEMORY:-/opt/rabit-brain/memory.md}"
CLAUDE_BIN="${RABIT_CLAUDE_BIN:-$(command -v claude || echo /usr/local/bin/claude)}"
[ -f "$DB" ] || exit 0

# last 24h of conversation
recent=$(sqlite3 "$DB" "SELECT role||': '||substr(content,1,500) FROM messages
  WHERE ts > strftime('%s','now')-86400 ORDER BY id" 2>/dev/null || echo "")
[ -z "$recent" ] && exit 0
current=$(head -c 3000 "$MEM" 2>/dev/null || echo "")

prompt="أنت تدير ملف ذاكرة طويل المدى عن مالك النظام. حدّث الملف التالي بناءً على محادثة اليوم.
اكتب حقائق ثابتة ومفيدة فقط: اسمه، لهجته، مشاريعه، تفضيلاته، أوامر متكررة، أشياء طلب تذكّرها.
لا تكرر ما هو موجود، ادمج وحدّث، احذف ما ثبت خطؤه. أبقِ الملف تحت 2000 حرف. بدون إيموجي.
أخرج نص الملف المحدّث فقط (Markdown)، بدون أي شرح.

الملف الحالي:
${current}

محادثة اليوم:
${recent}"

updated=$("$CLAUDE_BIN" -p "$prompt" --output-format json 2>/dev/null \
  | python3 -c "import sys,json;
try:
    print(json.load(sys.stdin).get('result',''))
except Exception:
    print('')" 2>/dev/null || echo "")

if [ -n "$updated" ]; then
  printf '%s\n' "$updated" | head -c 4000 > "$MEM.tmp" && mv "$MEM.tmp" "$MEM"
fi
