#!/bin/bash
# =====================================================================
#  Rabit AI — full end-to-end installer (dashboard + brain + memory +
#  real execution + Telegram + proactivity + HTTPS + auth + hardening)
#  Run on the Ubuntu VPS as root:
#    curl -fsSL https://raw.githubusercontent.com/alenizy361/Ai-Company-Core/claude/voice-agent-chat-site-xtpr4o/server/install.sh | bash
#  Fully unattended is possible by pre-setting env vars (see PROMPTS below).
# =====================================================================
set -euo pipefail
BRANCH="claude/voice-agent-chat-site-xtpr4o"
RAW="https://raw.githubusercontent.com/alenizy361/Ai-Company-Core/$BRANCH"
ENVF=/etc/rabit-brain.env
RUSER=rabit
say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn(){ printf '\033[1;33m    ! %s\033[0m\n' "$1"; }
ok(){ printf '\033[1;32m    %s\033[0m\n' "$1"; }

# read a value: env var wins, else prompt on the terminal, else default
ask(){ local var="$1" prompt="$2" def="${3:-}" cur="${!1:-}"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return; fi
  if [ -r /dev/tty ]; then printf '\033[1;35m?? %s\033[0m ' "$prompt" >/dev/tty
    local a; read -r a </dev/tty || a=""; printf '%s' "${a:-$def}"
  else printf '%s' "$def"; fi; }

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

say "Installing prerequisites..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq nginx python3 python3-pip sqlite3 curl openssl ufw \
  certbot python3-certbot-nginx >/dev/null 2>&1 || \
  apt-get install -y -qq nginx python3 python3-pip sqlite3 curl openssl ufw certbot python3-certbot-nginx
pip3 install -q -U anthropic 2>/dev/null || pip3 install -q -U --break-system-packages anthropic 2>/dev/null || \
  warn "anthropic SDK not installed (only needed for API-key mode; Max-plan CLI mode is fine)"

say "Creating the non-root service user '$RUSER'..."
id "$RUSER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUSER"
mkdir -p /opt/rabit-brain /var/www/rabit /srv/rabit-jobs /srv/rabit-deliverables /var/lib/rabit
# code dir stays root-owned (jobs must never be able to rewrite the brain);
# data dir /var/lib/rabit is the only writable state for brain + worker
chown -R "$RUSER:$RUSER" /srv/rabit-jobs /srv/rabit-deliverables /var/lib/rabit
chown -R root:root /opt/rabit-brain

say "Downloading Rabit files..."
for f in rabit-brain.py rabit-worker.py rabit-telegram.py rabit_claude.py; do
  curl -fsSL "$RAW/server/$f" -o "/opt/rabit-brain/$f"
done
mkdir -p /opt/rabit-brain/routines
for f in health-monitor.sh morning-brief.sh memory-distill.sh; do
  curl -fsSL "$RAW/server/routines/$f" -o "/opt/rabit-brain/routines/$f"
  chmod +x "/opt/rabit-brain/routines/$f"
done
curl -fsSL "$RAW/dashboard/index.html" -o /var/www/rabit/index.html
chmod -R go-w /opt/rabit-brain

# ---------------- config / secrets ----------------
say "Configuring..."
touch "$ENVF"; chmod 640 "$ENVF"; chown "root:$RUSER" "$ENVF"
get(){ grep -oP "^$1=\K.*" "$ENVF" 2>/dev/null | head -1 || true; }
put(){ grep -q "^$1=" "$ENVF" && sed -i "s|^$1=.*|$1=$2|" "$ENVF" || echo "$1=$2" >> "$ENVF"; }

# access code (owner token) — generate once, keep across re-runs
TOKEN=$(get RABIT_TOKEN); [ -z "$TOKEN" ] && TOKEN=$(openssl rand -hex 16)
put RABIT_TOKEN "$TOKEN"

# free port
port_free(){ python3 - "$1" <<'PY' 2>/dev/null
import socket,sys
s=socket.socket()
try: s.bind(("127.0.0.1",int(sys.argv[1])))
except OSError: sys.exit(1)
PY
}
PORT=$(get RABIT_PORT); systemctl stop rabit-brain 2>/dev/null || true
if [ -z "$PORT" ] || ! port_free "$PORT"; then PORT=8787
  port_free "$PORT" || for p in 8899 8901 8917 9411 9737; do port_free "$p" && { PORT=$p; break; }; done
fi
put RABIT_PORT "$PORT"; put RABIT_MODEL "${RABIT_MODEL:-claude-opus-5}"
put RABIT_DB /var/lib/rabit/rabit.db
put RABIT_MEMORY /var/lib/rabit/memory.md
put RABIT_STATUS /var/lib/rabit/status.json
put RABIT_JOBS_DIR /srv/rabit-jobs
put RABIT_DELIVER_DIR /srv/rabit-deliverables
put RABIT_EXEC "${RABIT_EXEC:-1}"
# help cron routines (no PATH) find the CLI the brain/worker use
CBIN=$(sudo -u "$RUSER" -H bash -lc 'command -v claude' 2>/dev/null || true)
[ -n "$CBIN" ] && put RABIT_CLAUDE_BIN "$CBIN"

# voice mode
VMODE=$(get RABIT_TTS); [ -z "$VMODE" ] && VMODE=$(ask RABIT_TTS \
  "Voice output? [browser=free default / azure / elevenlabs]" browser)
put RABIT_TTS "${VMODE:-browser}"
[ "$VMODE" = azure ] && { put AZURE_TTS_KEY "$(ask AZURE_TTS_KEY 'Azure Speech key' '')"
                          put AZURE_TTS_REGION "$(ask AZURE_TTS_REGION 'Azure region (e.g. eastus)' '')"; }
[ "$VMODE" = elevenlabs ] && put ELEVEN_KEY "$(ask ELEVEN_KEY 'ElevenLabs API key' '')"

# telegram (optional)
TG=$(get TELEGRAM_TOKEN); [ -z "$TG" ] && TG=$(ask TELEGRAM_TOKEN \
  "Telegram bot token from @BotFather (blank to skip)" '')
[ -n "$TG" ] && { put TELEGRAM_TOKEN "$TG"
  CID=$(get TELEGRAM_CHAT_ID); [ -z "$CID" ] && CID=$(ask TELEGRAM_CHAT_ID \
    "Your Telegram chat id (send your bot a message first, blank to auto-detect later)" '')
  [ -n "$CID" ] && put TELEGRAM_CHAT_ID "$CID"; }

# domain for HTTPS
DOMAIN=$(ask RABIT_DOMAIN "Domain pointing at this server for HTTPS (blank = stay on http, mic stays OFF)" '')

# Cover the www variant too, but only when it already resolves: Let's Encrypt
# validates every requested name, so asking for a www that has no A record
# fails the whole certificate — including the bare domain that would have worked.
SRVNAMES="_"; CERTD=""
if [ -n "$DOMAIN" ]; then
  SRVNAMES="$DOMAIN"; CERTD="-d $DOMAIN"
  case "$DOMAIN" in
    # wildcard-DNS hosts answer for ANY label, so a www there is just noise
    www.*|*.sslip.io|*.nip.io|*.traefik.me|*.localtest.me) ;;
    *) if getent hosts "www.$DOMAIN" >/dev/null 2>&1; then
         SRVNAMES="$DOMAIN www.$DOMAIN"; CERTD="$CERTD -d www.$DOMAIN"
         ok "www.$DOMAIN resolves too — including it in the certificate"
       fi ;;
  esac
fi

# ---------------- systemd units ----------------
say "Installing services..."
# /opt/rabit-brain (code) is deliberately NOT writable by the services, so a
# job can never rewrite the brain. Writable state lives in /var/lib/rabit.
HARDEN="NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes"
unit(){ cat > "/etc/systemd/system/$1.service"; }

unit rabit-brain <<EOF
[Unit]
Description=Rabit AI brain
After=network.target
[Service]
User=$RUSER
ExecStart=/usr/bin/python3 /opt/rabit-brain/rabit-brain.py
WorkingDirectory=/opt/rabit-brain
EnvironmentFile=-$ENVF
Environment=HOME=/home/$RUSER
Environment=PATH=/home/$RUSER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=3
$HARDEN
ReadWritePaths=/var/lib/rabit /home/$RUSER
[Install]
WantedBy=multi-user.target
EOF

unit rabit-worker <<EOF
[Unit]
Description=Rabit execution worker
After=network.target rabit-brain.service
[Service]
User=$RUSER
ExecStart=/usr/bin/python3 /opt/rabit-brain/rabit-worker.py
WorkingDirectory=/opt/rabit-brain
EnvironmentFile=-$ENVF
Environment=HOME=/home/$RUSER
Environment=PATH=/home/$RUSER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=5
MemoryMax=2G
CPUQuota=80%
$HARDEN
ReadWritePaths=/var/lib/rabit /srv/rabit-jobs /srv/rabit-deliverables /home/$RUSER
[Install]
WantedBy=multi-user.target
EOF

unit rabit-telegram <<EOF
[Unit]
Description=Rabit Telegram bridge
After=network.target rabit-brain.service
[Service]
User=$RUSER
ExecStart=/usr/bin/python3 /opt/rabit-brain/rabit-telegram.py
WorkingDirectory=/opt/rabit-brain
EnvironmentFile=-$ENVF
Environment=HOME=/home/$RUSER
Restart=always
RestartSec=10
$HARDEN
ReadWritePaths=/var/lib/rabit /home/$RUSER
[Install]
WantedBy=multi-user.target
EOF

# ---------------- nginx ----------------
say "Configuring nginx..."
cat > /etc/nginx/sites-available/rabit-dashboard <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $SRVNAMES;
    root /var/www/rabit;
    index index.html;

    location /deliverables/ {
        alias /srv/rabit-deliverables/;
        autoindex off;
        # AI-built pages run in a sandboxed opaque origin so they can never
        # read the dashboard's stored access token (no allow-same-origin).
        add_header Content-Security-Policy "sandbox allow-scripts allow-popups allow-forms" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Host \$host;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
EOF
mkdir -p /root/nginx-backup
for f in /etc/nginx/sites-enabled/*; do [ -e "$f" ] || continue
  [ "$(basename "$f")" = rabit-dashboard ] && continue
  mv "$f" /root/nginx-backup/ 2>/dev/null || rm -f "$f"; done
ln -sf /etc/nginx/sites-available/rabit-dashboard /etc/nginx/sites-enabled/rabit-dashboard

systemctl daemon-reload
systemctl enable rabit-brain rabit-worker rabit-telegram >/dev/null 2>&1 || true
systemctl restart rabit-brain rabit-worker rabit-telegram
nginx -t && { systemctl enable --now nginx >/dev/null 2>&1 || true; systemctl reload nginx; }

# ---------------- HTTPS ----------------
if [ -n "$DOMAIN" ]; then
  say "Getting HTTPS certificate for $DOMAIN..."
  certbot --nginx $CERTD --non-interactive --agree-tos --register-unsafely-without-email --redirect --expand \
    && ok "HTTPS active — the iPhone mic will work now" \
    || warn "certbot failed — check the domain's A record points at this server, then re-run: certbot --nginx $CERTD"
fi

# ---------------- cron routines ----------------
say "Scheduling proactive routines (health, morning brief, memory)..."
CRON=/etc/cron.d/rabit
CRONPATH="/home/$RUSER/.local/bin:/home/$RUSER/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
cat > "$CRON" <<EOF
SHELL=/bin/bash
PATH=$CRONPATH
*/5 * * * * $RUSER /opt/rabit-brain/routines/health-monitor.sh >/dev/null 2>&1
0 4 * * * $RUSER /opt/rabit-brain/routines/morning-brief.sh >/dev/null 2>&1
30 2 * * * $RUSER /opt/rabit-brain/routines/memory-distill.sh >/dev/null 2>&1
EOF
chmod 644 "$CRON"

# ---------------- firewall + expose check ----------------
say "Firewall + exposure check..."
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80,443/tcp >/dev/null 2>&1 || ufw allow 80/tcp >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true
if command -v docker >/dev/null 2>&1; then
  EXP=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0:(3100|18080|18081|5432|6379)' || true)
  [ -n "$EXP" ] && { warn "DANGER: these containers are exposed to the whole internet:"; echo "$EXP"
    warn "Bind them to localhost in your docker-compose (prefix ports with 127.0.0.1:) and 'docker compose up -d'."; }
fi

# ---------------- claude login for the rabit user ----------------
say "Connecting the brain to your Claude account..."
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then put ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"; systemctl restart rabit-brain; fi
NEEDLOGIN=1
sudo -u "$RUSER" -H bash -lc 'test -e ~/.claude || test -e ~/.claude.json' 2>/dev/null && NEEDLOGIN=0
if [ "$NEEDLOGIN" = 1 ] && [ -z "$(get ANTHROPIC_API_KEY)" ]; then
  if [ -r /dev/tty ]; then
    warn "The brain needs a Claude login as the '$RUSER' user (one time, uses your Max plan)."
    printf '\033[1;35m?? Log in now? [Y/n]\033[0m ' >/dev/tty; read -r yn </dev/tty || yn=y
    if [ "${yn:-y}" != n ]; then sudo -u "$RUSER" -H claude login </dev/tty >/dev/tty 2>&1 || \
      warn "Login didn't complete — run later: sudo -u $RUSER -H claude login"; fi
  else
    warn "Run this one command to connect the brain: sudo -u $RUSER -H claude login"
  fi
fi
systemctl restart rabit-brain rabit-worker rabit-telegram

# ---------------- done ----------------
sleep 2
say "Verifying..."
systemctl is-active --quiet rabit-brain || { warn "rabit-brain not running:"; journalctl -u rabit-brain -n 15 --no-pager || true; }
HEALTH=$(curl -s --max-time 5 http://localhost/api/health || true)
echo "Brain health: $HEALTH"
URL="http://$( [ -n "$DOMAIN" ] && echo "$DOMAIN" || echo "$(hostname -I | awk '{print $1}')" )"
[ -n "$DOMAIN" ] && URL="https://$DOMAIN"
echo
ok "Done."
echo "  Site:        $URL"
echo "  Access code: $TOKEN   (type it once on the site's lock screen)"
echo
case "$HEALTH" in *'"brain": "none"'*|*'"brain":"none"'*|"")
  warn "Brain not connected yet — run:  sudo -u $RUSER -H claude login   then: systemctl restart rabit-brain";;
esac
[ -z "$DOMAIN" ] && warn "No domain set — the iPhone mic stays OFF. Re-run with a domain to enable voice."
[ -z "$TG" ] && warn "No Telegram — you won't get morning briefs/alerts. Re-run with a bot token to enable."
