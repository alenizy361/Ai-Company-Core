#!/usr/bin/env bash
# SIRA OS installer/deployer for a dedicated machine (Linux/macOS/WSL).
#
#   ./scripts/install-sira.sh                 install + verify, then tell you how to run
#   ./scripts/install-sira.sh --services      also install systemd services (24/7 operation)
#   ./scripts/install-sira.sh --skip-tests    skip the test suite (not recommended)
#
# What it does, in order:
#   1. Checks Node.js >= 22.18 (needed for built-in SQLite + TS type-stripping)
#   2. Checks the `claude` CLI login (your Max plan powers the agents;
#      without it SIRA still runs, loudly labeled MOCK MODE)
#   3. npm ci  ->  seeds the database (org, 13 agents, versioned prompts)
#   4. Runs the full test suite (42 tests incl. the acceptance tests)
#   5. Runs every agent's evaluation suite and activates agents that pass 100%
#   6. Optionally installs systemd user services with restart policies
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

WITH_SERVICES=false
SKIP_TESTS=false
for arg in "$@"; do
  case "$arg" in
    --services) WITH_SERVICES=true ;;
    --skip-tests) SKIP_TESTS=true ;;
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
# FISH_API_KEY=                  # premium voice (falls back to espeak-ng without it)
# FISH_AUDIO_API_KEY=            # legacy name, still accepted
# FISH_AUDIO_MODEL=s2.1-pro-free # default; set a paid model if you have API credit
# DEEPGRAM_API_KEY=              # premium speech recognition
# PICOVOICE_ACCESS_KEY=          # wake word
# LIVEKIT_URL=
# LIVEKIT_API_KEY=
# LIVEKIT_API_SECRET=
# OWNER_TOKEN=                   # required only when exposing beyond localhost
# PORT=4600
# SIRA_SELF_DEV=1                # let SIRA modify its own code/interface (dedicated machine)
ENVT
      chmod 600 "$ENV_FILE"
    fi
    # Self-development mode: agents commit their own changes; give the repo a
    # local git identity so those commits succeed (agents run with HOME=repo).
    if grep -q '^SIRA_SELF_DEV=1' "$ENV_FILE" 2>/dev/null; then
      git config user.name >/dev/null 2>&1 || git config user.name "SIRA"
      git config user.email >/dev/null 2>&1 || git config user.email "sira@localhost"
      ok "self-development mode is ON — SIRA may modify its own code (git is the undo)"
    fi
    for svc in api worker; do
      ENTRY="src/server/index.ts"; DESC="SIRA OS API server"
      if [ "$svc" = worker ]; then ENTRY="src/worker/index.ts"; DESC="SIRA OS execution worker"; fi
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
    systemctl --user enable sira-api.service sira-worker.service
    # restart (not just enable --now) so re-running the installer picks up a
    # new `claude login`, updated code, or changed env vars
    systemctl --user restart sira-api.service sira-worker.service
    ok "services sira-api + sira-worker enabled and (re)started"
    if command -v loginctl >/dev/null 2>&1; then
      warn "so services keep running after you log out:  sudo loginctl enable-linger $USER"
    fi
    RUN_HINT="systemctl --user status sira-api sira-worker
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
if [ -z "${FISH_AUDIO_API_KEY:-}" ] && ! command -v espeak-ng >/dev/null 2>&1 && ! command -v espeak >/dev/null 2>&1; then
  warn "no server voice installed — Linux browsers often have ZERO speech voices,"
  warn "so replies may be silent. Enable SIRA's local voice (Arabic + English):"
  warn "    sudo apt install -y espeak-ng     # then re-run this script"
fi
