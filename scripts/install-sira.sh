#!/usr/bin/env bash
# SIRA OS installer/deployer for a dedicated machine (Linux/macOS/WSL).
#
#   ./scripts/install-sira.sh                     install + verify, then tell you how to run
#   ./scripts/install-sira.sh --services          also install systemd services (24/7 operation)
#   ./scripts/install-sira.sh --skip-tests        skip the test suite (not recommended)
#   ./scripts/install-sira.sh --enable-desktop-bridge
#       everything --services does, PLUS installs the GNOME Shell extension
#       and flips desktop control ON (full screen/mouse/keyboard/app/command
#       access, no per-action confirmation — only the kill switch and the
#       catastrophic-action denylist protect you). Implies --services. Only
#       use this on a machine with nothing sensitive on it. One manual step
#       remains after: log out and back in so GNOME loads the extension.
#   ./scripts/install-sira.sh --enable-browser-bridge
#       everything --services does, PLUS turns on browser automation
#       (Playwright driving your system Chrome, semantic CSS selectors —
#       faster and more reliable than desktop_* coordinate clicking for
#       anything reachable by URL). Implies --services.
#   ./scripts/install-sira.sh --enable-atspi-bridge
#       everything --services does, PLUS turns on native-Linux-app
#       automation (AT-SPI accessible role/name — faster than coordinate
#       clicking for GTK/Qt apps) and enables the GNOME accessibility
#       toolkit setting it depends on. Implies --services.
#   These three flags combine freely, e.g. --enable-desktop-bridge
#   --enable-browser-bridge --enable-atspi-bridge turns everything on at once.
#
# What it does, in order:
#   1. Checks Node.js >= 22.18 (needed for built-in SQLite + TS type-stripping)
#   2. Checks the `claude` CLI login (your Max plan powers the agents;
#      without it SIRA still runs, loudly labeled MOCK MODE)
#   3. npm ci  ->  seeds the database (org, 13 agents, versioned prompts)
#   4. Runs the full test suite (typecheck + unit + integration)
#   5. Runs every agent's evaluation suite and activates agents that pass 100%
#   6. Optionally installs systemd user services with restart policies
#   7. With --enable-desktop-bridge: installs the GNOME extension and turns
#      desktop control on (still needs one logout/login to take effect)
#   8. With --enable-browser-bridge / --enable-atspi-bridge: turns on the
#      browser/AT-SPI automation layers (both are dispatch pipelines inside
#      the SAME sira-desktop-bridge daemon — no new service, no new port)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

WITH_SERVICES=false
SKIP_TESTS=false
ENABLE_DESKTOP_BRIDGE=false
ENABLE_BROWSER_BRIDGE=false
ENABLE_ATSPI_BRIDGE=false
for arg in "$@"; do
  case "$arg" in
    --services) WITH_SERVICES=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --enable-desktop-bridge) ENABLE_DESKTOP_BRIDGE=true; WITH_SERVICES=true ;;
    --enable-browser-bridge) ENABLE_BROWSER_BRIDGE=true; WITH_SERVICES=true ;;
    --enable-atspi-bridge) ENABLE_ATSPI_BRIDGE=true; WITH_SERVICES=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1. Node.js ---------------------------------------------------------------
say "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  die "Node.js not found. Install Node 22 LTS first:
      Ubuntu/Debian:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
      Fedora:         sudo dnf install nodejs22
      macOS:          brew install node@22
      any OS (nvm):   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  die "Node $NODE_VERSION is too old — SIRA needs >= 22.18 (built-in SQLite + TS support). See the install commands above."
fi
NODE_BIN="$(command -v node)"
ok "Node $NODE_VERSION at $NODE_BIN"

# 2. Claude CLI (real model access) ---------------------------------------
say "Checking Claude model access"
LIVE_MODEL=false
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  LIVE_MODEL=true
  ok "ANTHROPIC_API_KEY set — the Anthropic API adapter will be used"
elif command -v claude >/dev/null 2>&1; then
  if claude auth status >/dev/null 2>&1; then
    LIVE_MODEL=true
    ok "claude CLI logged in — agents run on your subscription"
  else
    warn "claude CLI found but not logged in. Run:  claude login"
  fi
else
  warn "claude CLI not found. Install Claude Code and run 'claude login',"
  warn "or set ANTHROPIC_API_KEY. Until then SIRA runs in labeled MOCK MODE."
fi

# 3. Dependencies + database ----------------------------------------------
say "Installing dependencies"
npm ci
say "Seeding database (org, 13 agents, versioned prompts)"
npm run seed

# 4. Test suite ------------------------------------------------------------
if [ "$SKIP_TESTS" = false ]; then
  say "Running the test suite (typecheck + 42 tests incl. acceptance tests)"
  npm test
  ok "all tests passed"
else
  warn "tests skipped (--skip-tests)"
fi

# 5. Eval-gated agent activation -------------------------------------------
say "Running agent evaluation suites (agents activate only at 100%)"
npm run eval -- --promote

# 6. Optional systemd services ---------------------------------------------
RUN_HINT="npm run dev        # API :4600 + worker in one terminal"
if [ "$WITH_SERVICES" = true ]; then
  say "Installing systemd services"
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "systemd user services not available on this machine — skipping service install."
    warn "(On WSL2: add '[boot]' + 'systemd=true' to /etc/wsl.conf, then 'wsl --shutdown' and reopen.)"
    warn "Run SIRA with:  $RUN_HINT"
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    # Migrate installs made under the previous product name: the old units
    # must be stopped and removed, otherwise two workers run on one database.
    for old in rabit-api rabit-worker; do
      if [ -f "$UNIT_DIR/$old.service" ]; then
        warn "migrating old $old.service -> sira-* (stopping and removing it)"
        systemctl --user stop "$old.service" 2>/dev/null || true
        systemctl --user disable "$old.service" 2>/dev/null || true
        rm -f "$UNIT_DIR/$old.service"
      fi
    done
    # Services get a minimal PATH; include the claude CLI's directory so the
    # subscription adapter works under systemd, not just in your terminal.
    SERVICE_PATH="/usr/local/bin:/usr/bin:/bin"
    if command -v claude >/dev/null 2>&1; then
      SERVICE_PATH="$(dirname "$(command -v claude)"):$SERVICE_PATH"
    fi
    # Provider keys live in one env file that SURVIVES reinstalls — the unit
    # files are regenerated every run, so keys must never be written there.
    ENV_FILE="$HOME/.config/sira/env"
    if [ ! -f "$ENV_FILE" ]; then
      mkdir -p "$(dirname "$ENV_FILE")"
      cat > "$ENV_FILE" <<'ENVT'
# SIRA provider keys — edit, then: systemctl --user restart sira-api sira-worker
# CHATTERBOX_URL=http://127.0.0.1:8765  # local persistent TTS (tried FIRST — zero cost, one steady voice)
# CHATTERBOX_VOICE=default              # voice name your Chatterbox service was prepared with
# CHATTERBOX_ONLY=1               # never fall back to Fish/espeak — a failed sentence stays silent
                                   #   (text reply still arrives) instead of ever switching voices
# CHATTERBOX_TIMEOUT_MS=          # override the per-request wait (default 6000, or 30000 when CHATTERBOX_ONLY=1)
# FISH_API_KEY=                  # premium voice (falls back to Chatterbox/espeak-ng without it)
# FISH_AUDIO_API_KEY=            # legacy name, still accepted
# FISH_AUDIO_MODEL=s2.1-pro-free # default; set a paid model if you have API credit
# DEEPGRAM_API_KEY=              # premium speech recognition
# PICOVOICE_ACCESS_KEY=          # wake word
# LIVEKIT_URL=
# LIVEKIT_API_KEY=
# LIVEKIT_API_SECRET=
# SIRA_HOST=                     # defaults to 127.0.0.1 (loopback-only); set to 0.0.0.0 to
                                   #   reach SIRA from your phone/other devices on the LAN —
                                   #   ALWAYS set OWNER_TOKEN above first when you do this
# OWNER_TOKEN=                   # required before setting SIRA_HOST to anything but loopback
# PORT=4600
# SIRA_SELF_DEV=1                # let SIRA modify its own code/interface (dedicated machine)
# DESKTOP_BRIDGE_TOKEN=           # auto-generated below; shared secret between sira-api and sira-desktop-bridge
ENVT
      chmod 600 "$ENV_FILE"
    fi
    # Desktop bridge auth token: generated once, works for both brand-new
    # and pre-existing env files (an install from before this feature
    # existed just gains the key here instead of via the heredoc above).
    if ! grep -q '^DESKTOP_BRIDGE_TOKEN=' "$ENV_FILE" 2>/dev/null; then
      printf '\nDESKTOP_BRIDGE_TOKEN=%s\n' "$($NODE_BIN -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")" >> "$ENV_FILE"
      ok "generated DESKTOP_BRIDGE_TOKEN in $ENV_FILE"
    fi
    # Self-development mode: agents commit their own changes; give the repo a
    # local git identity so those commits succeed (agents run with HOME=repo).
    if grep -q '^SIRA_SELF_DEV=1' "$ENV_FILE" 2>/dev/null; then
      git config user.name >/dev/null 2>&1 || git config user.name "SIRA"
      git config user.email >/dev/null 2>&1 || git config user.email "sira@localhost"
      ok "self-development mode is ON — SIRA may modify its own code (git is the undo)"
    fi
    for svc in api worker desktop-bridge; do
      ENTRY="src/server/index.ts"; DESC="SIRA OS API server"
      if [ "$svc" = worker ]; then ENTRY="src/worker/index.ts"; DESC="SIRA OS execution worker"; fi
      if [ "$svc" = desktop-bridge ]; then ENTRY="src/desktop-bridge/index.ts"; DESC="SIRA OS desktop control bridge (mouse/keyboard/screen — off until config/desktop-bridge.json enabled:true)"; fi
      cat > "$UNIT_DIR/sira-$svc.service" <<UNIT
[Unit]
Description=$DESC
After=network.target

[Service]
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $ENTRY
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PATH=$SERVICE_PATH
EnvironmentFile=-$ENV_FILE

[Install]
WantedBy=default.target
UNIT
    done
    systemctl --user daemon-reload
    systemctl --user enable sira-api.service sira-worker.service sira-desktop-bridge.service
    # restart (not just enable --now) so re-running the installer picks up a
    # new `claude login`, updated code, or changed env vars
    systemctl --user restart sira-api.service sira-worker.service sira-desktop-bridge.service
    ok "services sira-api + sira-worker + sira-desktop-bridge enabled and (re)started"
    if command -v loginctl >/dev/null 2>&1; then
      warn "so services keep running after you log out:  sudo loginctl enable-linger $USER"
    fi

    # Desktop control bridge: install the GNOME Shell extension the daemon
    # needs for the primary (GNOME/Wayland) backend, and report tool
    # dependencies honestly. Never fails the install if this machine isn't
    # GNOME/Wayland — the daemon just reports itself not-ready over
    # /api/desktop-bridge/status until it is. The feature itself stays OFF
    # regardless (config/desktop-bridge.json "enabled": false by default) —
    # this only makes it READY to turn on.
    say "Desktop control bridge: extension + dependencies"
    EXT_UUID="sira-desktop-bridge@sira.local"
    EXT_SRC="$REPO_DIR/gnome-extension/$EXT_UUID"
    EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
    if [ -d "$EXT_SRC" ]; then
      mkdir -p "$(dirname "$EXT_DEST")"
      rm -rf "$EXT_DEST"
      cp -r "$EXT_SRC" "$EXT_DEST"
      ok "installed the GNOME Shell extension to $EXT_DEST"
      if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions enable "$EXT_UUID" >/dev/null 2>&1 || true
        warn "extension enabled, but GNOME only loads a NEW extension after you log out and back in (Wayland has no live-reload for unregistered extensions)"
      else
        warn "gnome-extensions CLI not found — enable it manually (GNOME Extensions app), then log out/in"
      fi
    else
      warn "gnome-extension/$EXT_UUID not found in this checkout — skipping extension install"
    fi
    if command -v gdbus >/dev/null 2>&1; then
      ok "gdbus found (needed by the GNOME/Wayland desktop backend)"
    else
      warn "gdbus not found — install it for desktop control on GNOME/Wayland:  sudo apt install libglib2.0-bin"
    fi
    if command -v xdotool >/dev/null 2>&1 && command -v scrot >/dev/null 2>&1; then
      ok "xdotool + scrot found (X11 desktop-control fallback available)"
    else
      warn "xdotool/scrot not found — the X11 fallback backend is unavailable (fine on GNOME/Wayland, the primary supported path); install with:  sudo apt install xdotool scrot"
    fi

    # Browser + AT-SPI automation: report dependencies honestly, change
    # nothing here — actually turning either on (--enable-browser-bridge /
    # --enable-atspi-bridge) happens further below. Both are dispatch
    # pipelines inside the SAME sira-desktop-bridge daemon/port — no new
    # systemd unit, no new token.
    say "Browser + AT-SPI automation: dependencies"
    if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
      ok "system Chrome/Chromium found (browser automation drives it directly — no separate download)"
    else
      warn "no system Chrome/Chromium found — browser automation needs one:  sudo apt install -y google-chrome-stable  (or: sudo apt install -y chromium-browser)"
    fi
    if python3 -c "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi" >/dev/null 2>&1; then
      ok "AT-SPI GObject-Introspection bindings importable"
    else
      warn "AT-SPI bindings not importable — install with:  sudo apt install -y gir1.2-atspi-2.0 python3-gi"
    fi
    if [ "$(gsettings get org.gnome.desktop.interface toolkit-accessibility 2>/dev/null)" = "true" ]; then
      ok "GNOME accessibility (toolkit-accessibility) already enabled"
    else
      warn "GNOME accessibility is off — AT-SPI can't see GTK/Qt app widgets until it's on (--enable-atspi-bridge does this for you, or by hand:  gsettings set org.gnome.desktop.interface toolkit-accessibility true)"
    fi

    if [ "$ENABLE_DESKTOP_BRIDGE" = true ]; then
      say "Enabling desktop control (--enable-desktop-bridge)"
      warn "SIRA will have FULL screen/mouse/keyboard/app/command control with NO per-action confirmation."
      warn "Only the kill switch (POST /api/desktop-bridge/kill) and the catastrophic-action denylist protect you now."
      DESKTOP_CONFIG="$REPO_DIR/config/desktop-bridge.json"
      "$NODE_BIN" -e "
        const fs = require('node:fs');
        const p = process.argv[1];
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        cfg.enabled = true;
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
      " "$DESKTOP_CONFIG"
      ok "config/desktop-bridge.json: enabled = true"
      systemctl --user restart sira-api.service sira-desktop-bridge.service
      ok "sira-api + sira-desktop-bridge restarted with desktop control enabled"
      DESKTOP_BRIDGE_NOTE="ON — log out and back in now so GNOME loads the extension, then verify:  curl -s http://127.0.0.1:4600/api/desktop-bridge/status | jq"
    else
      warn "desktop control stays OFF until you set \"enabled\": true in config/desktop-bridge.json (or re-run with --enable-desktop-bridge) — read gnome-extension/README.md first; only enable this on a machine with nothing sensitive on it"
      DESKTOP_BRIDGE_NOTE="installed but OFF — turn on with:  ./scripts/install-sira.sh --enable-desktop-bridge"
    fi

    if [ "$ENABLE_BROWSER_BRIDGE" = true ]; then
      say "Enabling browser automation (--enable-browser-bridge)"
      BROWSER_CONFIG="$REPO_DIR/config/browser-bridge.json"
      "$NODE_BIN" -e "
        const fs = require('node:fs');
        const p = process.argv[1];
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        cfg.enabled = true;
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
      " "$BROWSER_CONFIG"
      ok "config/browser-bridge.json: enabled = true"
      systemctl --user restart sira-api.service sira-desktop-bridge.service
      ok "sira-api + sira-desktop-bridge restarted with browser automation enabled"
      BROWSER_BRIDGE_NOTE="ON — verify:  curl -s http://127.0.0.1:4600/api/desktop-bridge/status | jq .browser"
    else
      BROWSER_BRIDGE_NOTE="installed but OFF — turn on with:  ./scripts/install-sira.sh --enable-browser-bridge"
    fi

    if [ "$ENABLE_ATSPI_BRIDGE" = true ]; then
      say "Enabling AT-SPI automation (--enable-atspi-bridge)"
      if command -v gsettings >/dev/null 2>&1; then
        gsettings set org.gnome.desktop.interface toolkit-accessibility true
        ok "GNOME accessibility (toolkit-accessibility) enabled"
      else
        warn "gsettings not found — enable GNOME accessibility manually (Settings > Accessibility), AT-SPI won't see app widgets otherwise"
      fi
      ATSPI_CONFIG="$REPO_DIR/config/atspi-bridge.json"
      "$NODE_BIN" -e "
        const fs = require('node:fs');
        const p = process.argv[1];
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        cfg.enabled = true;
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
      " "$ATSPI_CONFIG"
      ok "config/atspi-bridge.json: enabled = true"
      systemctl --user restart sira-api.service sira-desktop-bridge.service
      ok "sira-api + sira-desktop-bridge restarted with AT-SPI automation enabled"
      ATSPI_BRIDGE_NOTE="ON — verify:  curl -s http://127.0.0.1:4600/api/desktop-bridge/status | jq .atspi"
    else
      ATSPI_BRIDGE_NOTE="installed but OFF — turn on with:  ./scripts/install-sira.sh --enable-atspi-bridge"
    fi

    RUN_HINT="systemctl --user status sira-api sira-worker sira-desktop-bridge
      journalctl --user -u sira-worker -f     # live worker logs"
  fi
fi

# Summary -------------------------------------------------------------------
say "SIRA OS installed"
echo "    Open:      http://localhost:4600"
echo "    Run/watch: $RUN_HINT"
if [ "$LIVE_MODEL" = true ]; then
  echo "    Model:     LIVE (subscription/API)"
else
  echo "    Model:     MOCK MODE until 'claude login' or ANTHROPIC_API_KEY — the UI shows a banner"
fi
echo "    Voice:     works now with browser/local providers; put provider keys in"
echo "               ~/.config/sira/env (FISH_AUDIO_API_KEY, DEEPGRAM_API_KEY, …)"
echo "               then: systemctl --user restart sira-api sira-worker"
echo "    Note:      the mic and speech APIs need localhost or HTTPS in the browser."
if [ -n "${DESKTOP_BRIDGE_NOTE:-}" ]; then
  echo "    Desktop control: $DESKTOP_BRIDGE_NOTE"
fi
if [ -n "${BROWSER_BRIDGE_NOTE:-}" ]; then
  echo "    Browser automation: $BROWSER_BRIDGE_NOTE"
fi
if [ -n "${ATSPI_BRIDGE_NOTE:-}" ]; then
  echo "    AT-SPI automation: $ATSPI_BRIDGE_NOTE"
fi
if [ -z "${FISH_AUDIO_API_KEY:-}" ] && ! command -v espeak-ng >/dev/null 2>&1 && ! command -v espeak >/dev/null 2>&1; then
  warn "no server voice installed — Linux browsers often have ZERO speech voices,"
  warn "so replies may be silent. Enable SIRA's local voice (Arabic + English):"
  warn "    sudo apt install -y espeak-ng     # then re-run this script"
fi
