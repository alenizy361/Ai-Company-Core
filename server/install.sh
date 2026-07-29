#!/bin/bash
# Rabit AI Company OS — one-shot installer for the dashboard + Claude brain.
# Run on the VPS as root:
#   curl -fsSL https://raw.githubusercontent.com/alenizy361/Ai-Company-Core/claude/voice-agent-chat-site-xtpr4o/server/install.sh | bash
set -e

BRANCH="claude/voice-agent-chat-site-xtpr4o"
RAW="https://raw.githubusercontent.com/alenizy361/Ai-Company-Core/$BRANCH"

echo "==> Checking prerequisites..."
if ! command -v nginx >/dev/null 2>&1; then
  echo "    nginx not found — installing..."
  apt-get update -y -qq && apt-get install -y -qq nginx
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "    python3 not found — installing..."
  apt-get update -y -qq && apt-get install -y -qq python3
fi

echo "==> Downloading dashboard + brain..."
mkdir -p /opt/rabit-brain /var/www/rabit
curl -fsSL "$RAW/server/rabit-brain.py" -o /opt/rabit-brain/rabit-brain.py
curl -fsSL "$RAW/dashboard/index.html" -o /var/www/rabit/index.html

echo "==> Installing the anthropic SDK (only needed for API-key mode)..."
if ! command -v pip3 >/dev/null 2>&1; then
  apt-get update -y -qq && apt-get install -y -qq python3-pip || true
fi
if command -v pip3 >/dev/null 2>&1; then
  pip3 install -q -U anthropic \
    || pip3 install -q -U --break-system-packages anthropic \
    || echo "    WARNING: could not install the anthropic SDK — API-key mode won't work (CLI/Max-plan mode is unaffected)"
else
  echo "    WARNING: pip3 unavailable — API-key mode won't work (CLI/Max-plan mode is unaffected)"
fi

touch /etc/rabit-brain.env
chmod 600 /etc/rabit-brain.env

echo "==> Installing systemd service rabit-brain..."
cat > /etc/systemd/system/rabit-brain.service <<'EOF'
[Unit]
Description=Rabit AI brain (Claude chat backend for the dashboard)
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/rabit-brain/rabit-brain.py
WorkingDirectory=/opt/rabit-brain
EnvironmentFile=-/etc/rabit-brain.env
Environment=HOME=/root
Environment=PATH=/root/.local/bin:/root/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> Configuring nginx..."
cat > /etc/nginx/sites-available/rabit-dashboard <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/rabit;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
EOF
# park any other enabled site so our default_server doesn't collide
mkdir -p /root/nginx-backup
for f in /etc/nginx/sites-enabled/*; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = "rabit-dashboard" ] && continue
  mv "$f" /root/nginx-backup/ 2>/dev/null || rm -f "$f"
done
ln -sf /etc/nginx/sites-available/rabit-dashboard /etc/nginx/sites-enabled/rabit-dashboard

systemctl daemon-reload
systemctl enable rabit-brain >/dev/null 2>&1 || true
systemctl restart rabit-brain
nginx -t
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx

sleep 2
echo "==> Verifying..."
if ! systemctl is-active --quiet rabit-brain; then
  echo "ERROR: rabit-brain failed to start. Logs:"
  journalctl -u rabit-brain -n 20 --no-pager || true
  exit 1
fi
HEALTH=$(curl -s --max-time 5 http://localhost/api/health || true)
echo "Brain health: $HEALTH"
echo
echo "Done ✅  Open the site and hard-refresh the page."
case "$HEALTH" in
  *'"brain": "none"'*|*'"brain":"none"'*|"")
    echo
    echo "Brain is NOT connected yet. Pick one:"
    echo "  A) Max plan (no API key):  claude login   then:  systemctl restart rabit-brain"
    echo "  B) API key:  echo 'ANTHROPIC_API_KEY=sk-ant-...' >> /etc/rabit-brain.env"
    echo "     then:  systemctl restart rabit-brain"
    ;;
esac
