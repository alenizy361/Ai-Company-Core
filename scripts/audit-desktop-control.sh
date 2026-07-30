#!/usr/bin/env bash
# READ-ONLY audit of the machine SIRA's desktop-bridge runs on — collects
# everything needed to design adding Playwright (browser automation) and
# AT-SPI (Linux accessibility automation) as ADDITIONAL, faster routing
# options alongside the existing GNOME-extension/Clutter screen-and-input
# control (see gnome-extension/, src/desktop-bridge/) — not a replacement.
#
# Changes NOTHING. Installs nothing. Safe to run any time.
#
#   ./scripts/audit-desktop-control.sh
#
# Prints a report and also writes it to performance-audit-before.md in the
# repo root (a local snapshot, not meant to be committed).
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
OUT="$REPO_DIR/performance-audit-before.md"

# Deliberately NOT `set -e` — the whole point is to report what's missing,
# not abort the first time something isn't installed. `-u` stays on; every
# variable read below has a `:-default`.
set -uo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

# Runs "$@" as a real argv (never a string re-parsed by eval), prints its
# stdout, or "(unavailable)" if the command is missing/fails/prints nothing.
val() {
  local out
  if out="$("$@" 2>/dev/null)" && [ -n "$out" ]; then printf '%s' "$out"; else printf '(unavailable)'; fi
}

{
  echo "# SIRA desktop-control audit"
  echo
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(val hostname)"
  echo

  echo "## OS / kernel / session"
  echo '```'
  if [ -r /etc/os-release ]; then
    # /etc/os-release is itself shell-sourceable (PRETTY_NAME=... etc.) —
    # sourced in a subshell so it can't clobber this script's own variables.
    echo "os-release:      $(. /etc/os-release; echo "${PRETTY_NAME:-unavailable}")"
  else
    echo "os-release:      (unavailable)"
  fi
  echo "kernel:          $(val uname -r)"
  echo "arch:            $(val uname -m)"
  echo "desktop:         ${XDG_CURRENT_DESKTOP:-unset}"
  echo "session type:    ${XDG_SESSION_TYPE:-unset}   (wayland or x11 — critical for the backend choice)"
  echo "wayland display: ${WAYLAND_DISPLAY:-unset}"
  echo "x11 display:     ${DISPLAY:-unset}"
  echo "gnome-shell:     $(val gnome-shell --version)"
  echo '```'
  echo

  echo "## Hardware"
  echo '```'
  echo "cpu model:  $(val lscpu | grep 'Model name' | sed 's/Model name:[[:space:]]*//')"
  echo "cpu cores:  $(val nproc)"
  echo "memory:"
  if have free; then free -h | sed 's/^/  /'; else echo "  (unavailable)"; fi
  echo "load avg:   $(val uptime)"
  echo "gpu:"
  if have lspci; then lspci 2>/dev/null | grep -iE 'vga|3d controller' | sed 's/^/  /' || echo "  (unavailable)"; else echo "  (unavailable)"; fi
  echo '```'
  echo

  echo "## Language runtimes"
  echo '```'
  echo "node:    $(val node --version)"
  echo "npm:     $(val npm --version)"
  echo "python3: $(val python3 --version)"
  echo "pip3:    $(val pip3 --version)"
  echo "rustc:   $(val rustc --version)"
  echo "cargo:   $(val cargo --version)"
  echo '```'
  echo

  echo "## Claude Code"
  echo '```'
  echo "claude CLI:   $(val claude --version)"
  echo "auth status:  $(val claude auth status)"
  if have claude; then
    echo "registered MCP servers (claude mcp list):"
    claude mcp list 2>/dev/null | sed 's/^/  /' || echo "  (unavailable)"
  else
    echo "registered MCP servers: claude CLI not found — skipped"
  fi
  echo '```'
  echo

  echo "## Existing browser-automation / accessibility tooling"
  echo '```'
  for bin in npx playwright chromium chromium-browser google-chrome firefox xdotool scrot gdbus gtk-launch; do
    if have "$bin"; then echo "$bin: found ($(command -v "$bin"))"; else echo "$bin: NOT FOUND"; fi
  done
  echo
  echo "repo node_modules/@playwright present: $([ -d "$REPO_DIR/node_modules/@playwright" ] && echo yes || echo no)"
  atspi_ok="no"
  if have python3 && python3 -c "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi" >/dev/null 2>&1; then
    atspi_ok="yes"
  fi
  echo "python atspi bindings importable: $atspi_ok"
  echo "GNOME accessibility (toolkit-accessibility) enabled: $(val gsettings get org.gnome.desktop.interface toolkit-accessibility)"
  echo '```'
  echo

  echo "## SIRA repo state"
  echo '```'
  echo "path:          $REPO_DIR"
  echo "branch:        $(val git -C "$REPO_DIR" branch --show-current)"
  echo "commit:        $(val git -C "$REPO_DIR" rev-parse --short HEAD)"
  if have git; then
    echo "dirty:         $(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ') uncommitted file(s)"
  else
    echo "dirty:         (unavailable)"
  fi
  echo '```'
  echo

  echo "## SIRA systemd services"
  echo '```'
  if have systemctl; then
    for svc in sira-api sira-worker sira-desktop-bridge; do
      echo "-- $svc --"
      systemctl --user status "$svc" --no-pager -n 3 2>&1 | sed 's/^/  /' || echo "  (unavailable)"
      echo
    done
    echo "lingering enabled: $(val loginctl show-user "${USER:-$(whoami)}" -p Linger)"
  else
    echo "systemctl not available"
  fi
  echo '```'
  echo

  echo "## SIRA desktop-bridge policy + GNOME extension"
  echo '```'
  if [ -f "$REPO_DIR/config/desktop-bridge.json" ] && have python3; then
    echo "config/desktop-bridge.json 'enabled': $(python3 -c "import json;print(json.load(open('$REPO_DIR/config/desktop-bridge.json'))['enabled'])" 2>/dev/null || echo "(couldn't parse)")"
  else
    echo "config/desktop-bridge.json: not found or python3 unavailable"
  fi
  if have gnome-extensions; then
    echo "extension state:"
    gnome-extensions info sira-desktop-bridge@sira.local 2>&1 | sed 's/^/  /' || echo "  (unavailable)"
  else
    echo "gnome-extensions CLI not found"
  fi
  echo '```'
  echo

  echo "## Live probes (SIRA API assumed at 127.0.0.1:4600)"
  echo '```'
  if have curl; then
    echo "-- /api/health --"
    curl -s -o /dev/null -w 'http %{http_code} in %{time_total}s\n' http://127.0.0.1:4600/api/health 2>&1 || echo "(unreachable)"
    echo "-- /api/desktop-bridge/status --"
    curl -s -w '\nhttp %{http_code} in %{time_total}s\n' http://127.0.0.1:4600/api/desktop-bridge/status 2>&1 || echo "(unreachable)"
  else
    echo "curl not found"
  fi
  echo '```'
} | tee "$OUT"

echo
echo "Written to: $OUT"
echo "Paste the full output above (or that file's contents) back to continue."
