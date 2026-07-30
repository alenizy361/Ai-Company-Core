#!/usr/bin/env bash
# Deploys the local Chatterbox Multilingual V3 TTS microservice as a
# systemd --user unit (same pattern as sira-api/sira-worker), then points
# SIRA at it. This is why "the voice didn't change" after wiring
# CHATTERBOX_URL into ~/.config/sira/env: SIRA's relay tries Chatterbox
# first, but nothing was listening on that port until this service exists
# and actually runs — it silently fell through to Fish/espeak, same as
# before.
#
# Prerequisite: an existing Python environment with chatterbox-tts (and its
# torch/perth deps) already installed and verified working — this script
# does NOT install the model itself, only the persistent HTTP service around
# it (see chatterbox/app.py).
#
#   ./scripts/install-chatterbox.sh [--python-env /path/to/venv] [--voice /path/to/reference.wav]
#
# Env var overrides (same names work if you prefer exporting instead of
# flags): CHATTERBOX_PYTHON_ENV, CHATTERBOX_SERVICE_DIR (default
# ~/chatterbox-service), CHATTERBOX_VOICE_WAV, CHATTERBOX_PORT (default 8765).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$*" >&2; exit 1; }

PYTHON_ENV="${CHATTERBOX_PYTHON_ENV:-}"
VOICE_WAV="${CHATTERBOX_VOICE_WAV:-}"
SERVICE_DIR="${CHATTERBOX_SERVICE_DIR:-$HOME/chatterbox-service}"
PORT="${CHATTERBOX_PORT:-8765}"
while [ $# -gt 0 ]; do
  case "$1" in
    --python-env) PYTHON_ENV="$2"; shift 2 ;;
    --voice) VOICE_WAV="$2"; shift 2 ;;
    --service-dir) SERVICE_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac
done

# 1. Find the existing Chatterbox Python environment ------------------------
say "Locating the existing Chatterbox Python environment"
if [ -z "$PYTHON_ENV" ]; then
  for candidate in "$HOME/chatterbox-env" "$HOME/.venvs/chatterbox" "$HOME/venvs/chatterbox"; do
    if [ -x "$candidate/bin/python" ]; then PYTHON_ENV="$candidate"; break; fi
  done
fi
[ -n "$PYTHON_ENV" ] || die "Could not auto-detect a Chatterbox venv. Re-run with:
      ./scripts/install-chatterbox.sh --python-env /path/to/your/chatterbox-env
    (the directory that has bin/python and the chatterbox package installed)"
PY="$PYTHON_ENV/bin/python"
[ -x "$PY" ] || die "$PY is not an executable — check --python-env"
ok "using $PY"

say "Verifying the Chatterbox model package imports"
"$PY" -c "from chatterbox.mtl_tts import ChatterboxMultilingualTTS" \
  || die "chatterbox.mtl_tts did not import in $PYTHON_ENV — install/fix Chatterbox there first (this script only adds the HTTP service around it)"
ok "chatterbox.mtl_tts imports cleanly"

# 2. Lay out the service directory ------------------------------------------
say "Deploying the service to $SERVICE_DIR"
mkdir -p "$SERVICE_DIR/voices" "$SERVICE_DIR/logs"
cp "$REPO_DIR/chatterbox/app.py" "$SERVICE_DIR/app.py"
if [ -n "$VOICE_WAV" ]; then
  [ -f "$VOICE_WAV" ] || die "--voice file not found: $VOICE_WAV"
  cp "$VOICE_WAV" "$SERVICE_DIR/voices/sira.wav"
  ok "reference voice installed at $SERVICE_DIR/voices/sira.wav"
else
  warn "no --voice given — the model's built-in conditionals will be used (still one steady voice, just not a custom clone)"
fi

# 3. Install the thin FastAPI wrapper deps into the SAME venv ---------------
say "Installing the service's own dependencies (fastapi/uvicorn/…) into $PYTHON_ENV"
# Some venvs (esp. ones created with `python -m venv --without-pip`, or a
# uv-managed venv) have no pip at all. Bootstrap it before installing.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  warn "no pip in this venv — bootstrapping it"
  "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if "$PY" -m pip --version >/dev/null 2>&1; then
  "$PY" -m pip install --quiet -r "$REPO_DIR/chatterbox/requirements-service.txt"
elif command -v uv >/dev/null 2>&1; then
  ok "using uv (no pip in this venv)"
  uv pip install --quiet --python "$PY" -r "$REPO_DIR/chatterbox/requirements-service.txt"
elif command -v "$HOME/.local/bin/uv" >/dev/null 2>&1; then
  ok "using ~/.local/bin/uv (no pip in this venv)"
  "$HOME/.local/bin/uv" pip install --quiet --python "$PY" -r "$REPO_DIR/chatterbox/requirements-service.txt"
else
  die "this venv has neither pip nor ensurepip, and uv is not installed. Fix one of:
      $PY -m ensurepip --upgrade
      curl -LsSf https://astral.sh/uv/install.sh | sh   # installs uv, then re-run this script"
fi
ok "service dependencies installed"

# 4. systemd --user unit (same convention as sira-api / sira-worker) --------
say "Installing the systemd --user service"
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  die "systemd user services are not available on this machine — cannot run Chatterbox as a persistent service here."
fi
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
CPU_COUNT="$(nproc 2>/dev/null || echo 4)"
TORCH_THREADS=$(( CPU_COUNT > 1 ? CPU_COUNT - 1 : 1 ))
cat > "$UNIT_DIR/chatterbox-tts.service" <<UNIT
[Unit]
Description=Local Chatterbox Multilingual V3 TTS (SIRA voice engine)
After=network.target

[Service]
Type=simple
WorkingDirectory=$SERVICE_DIR
Environment=PYTHONUNBUFFERED=1
Environment=HF_HOME=$HOME/.cache/huggingface
Environment=CHATTERBOX_SERVICE_DIR=$SERVICE_DIR
Environment=CHATTERBOX_TORCH_THREADS=$TORCH_THREADS
Environment=CHATTERBOX_MAX_TEXT_LENGTH=400
Environment=CHATTERBOX_MAX_QUEUE_DEPTH=3
Environment=LOG_LEVEL=INFO
ExecStart=$PY -m uvicorn app:app --host 127.0.0.1 --port $PORT --workers 1
Restart=on-failure
RestartSec=5
TimeoutStartSec=0
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable chatterbox-tts.service
systemctl --user restart chatterbox-tts.service
ok "chatterbox-tts.service enabled and (re)started"

# 5. Wait for the model to actually finish loading (can take a while on CPU) -
say "Waiting for the model to load (CPU inference — first load can take a minute or two)"
warn "first boot also downloads the fast-tier voices (facebook/mms-tts-ara/-eng, ~a few hundred MB total) — needs internet ONCE, then fully offline"
READY=false
for i in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; then READY=true; break; fi
  sleep 2
done
if [ "$READY" = true ]; then
  ok "Chatterbox (quality tier) is ready on http://127.0.0.1:$PORT"
  FAST_LANGS="$(curl -fs "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -o '"languages_ready":\[[^]]*\]' || true)"
  if [ -n "$FAST_LANGS" ]; then ok "fast tier: $FAST_LANGS"; else warn "fast tier not ready yet — check: curl -s http://127.0.0.1:$PORT/health"; fi
else
  warn "not ready yet after 2 minutes — check:  journalctl --user -u chatterbox-tts -f"
fi

# 6. Wire SIRA to it ----------------------------------------------------------
ENV_FILE="$HOME/.config/sira/env"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
if ! grep -q '^CHATTERBOX_URL=' "$ENV_FILE" 2>/dev/null; then
  printf 'CHATTERBOX_URL=http://127.0.0.1:%s\nCHATTERBOX_VOICE=default\n' "$PORT" >> "$ENV_FILE"
  ok "added CHATTERBOX_URL to $ENV_FILE"
else
  sed -i "s|^CHATTERBOX_URL=.*|CHATTERBOX_URL=http://127.0.0.1:$PORT|" "$ENV_FILE"
  ok "updated CHATTERBOX_URL in $ENV_FILE"
fi

say "Done"
echo "    Service:  systemctl --user status chatterbox-tts"
echo "    Logs:     journalctl --user -u chatterbox-tts -f"
echo "    Test:     curl -s http://127.0.0.1:$PORT/health"
if command -v loginctl >/dev/null 2>&1; then
  warn "so it keeps running after you log out:  sudo loginctl enable-linger $USER"
fi
echo
echo "    Now restart SIRA so it picks up CHATTERBOX_URL:"
echo "        systemctl --user restart sira-api sira-worker"
