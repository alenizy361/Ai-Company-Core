# SIRA Browser Automation (Playwright) + Linux Accessibility Automation (AT-SPI)

Two additional, faster automation layers alongside the raw-coordinate
[desktop bridge](gnome-extension/README.md): semantic, selector-based control
of a real browser (Playwright) and semantic, accessible-name-based control of
native Linux apps (AT-SPI). This is a real, unrestricted capability — read
this whole file before turning either on.

## What this is (and isn't)

The desktop bridge's loop is screenshot → model reasons about pixels →
click(x,y) → repeat: slow (a vision round trip every step) and fragile
(coordinates break the moment a layout shifts). These two layers replace that
loop with structured, named targets wherever one is available:

- **Browser layer** — `browser_navigate`, `browser_click`, `browser_fill`,
  `browser_fill_form`, `browser_get_text`, `browser_extract`,
  `browser_wait_for`, `browser_screenshot`, `browser_list_tabs`,
  `browser_new_tab`, `browser_switch_tab`, `browser_close_tab`. Drives the
  system Chrome via Playwright, targeting CSS selectors instead of pixels.
- **AT-SPI layer** — `atspi_list_apps`, `atspi_find`, `atspi_click`,
  `atspi_set_text`, `atspi_get_text`, `atspi_wait_for`. Targets native
  GTK/Qt Linux app widgets by accessible role/name via the same tree GNOME's
  own screen readers use.
- **Saved workflows** — `workflow_save` / `workflow_list` / `workflow_run`:
  a named, ordered sequence of browser_* or atspi_* steps (never raw
  desktop_click coordinates), replayed only after checking the live page/app
  still matches what the workflow was recorded against.

**Not a replacement for the desktop bridge.** Anything with no accessible
tree — canvas apps, games, some Electron apps — still has no semantic target
to click, so the coordinate-based desktop bridge stays the fallback SIRA
reaches for in those cases (see `gnome-extension/README.md`).

Turning either layer on is the one-time consent step. There is **no
per-action confirmation dialog** after that — every browser/AT-SPI action
SIRA takes runs immediately, gated only by:

- the browser layer's URL denylist (`config/browser-bridge.json` —
  `file://`, `chrome://`, `javascript:`, etc. always blocked),
- the **same kill switch** the desktop bridge already has
  (`POST /api/desktop-bridge/kill` stops all three layers at once —
  there is only one switch),
- a full audit trail of every action, unified with the desktop bridge's own
  (`GET /api/desktop-bridge/actions`).

Only enable this on a machine with nothing sensitive on it — no personal
accounts, no financial access, nothing you wouldn't want an AI agent to be
able to click on.

## Install

`scripts/install-sira.sh --services` installs the dependencies for both
layers automatically (checks for a system Chrome/Chromium and for AT-SPI's
Python bindings, reporting what it finds — it does not force-install
anything neither flag below explicitly asks for).

## Turning it on

Both layers are **off by default**, same as the desktop bridge — the daemon
just reports itself not-ready until you opt in.

The one-command way — installs everything AND flips a layer on:

```sh
./scripts/install-sira.sh --enable-browser-bridge   # browser layer
./scripts/install-sira.sh --enable-atspi-bridge     # AT-SPI layer
```

These combine freely with each other and with `--enable-desktop-bridge` in a
single run, e.g.:

```sh
./scripts/install-sira.sh --enable-desktop-bridge --enable-browser-bridge --enable-atspi-bridge
```

Or by hand, on an existing `--services` install:

- **Browser**: set `"enabled": true` in `config/browser-bridge.json`, then
  `systemctl --user restart sira-api sira-desktop-bridge`.
- **AT-SPI**: run
  `gsettings set org.gnome.desktop.interface toolkit-accessibility true`
  (GTK/Qt apps don't expose an accessibility tree until this is on), set
  `"enabled": true` in `config/atspi-bridge.json`, then
  `systemctl --user restart sira-api sira-desktop-bridge`.

## Verifying it's really working

```sh
curl -s http://127.0.0.1:4600/api/desktop-bridge/status | jq .browser
# enabled: true, kind: "playwright", ready should be true
curl -s http://127.0.0.1:4600/api/desktop-bridge/status | jq .atspi
# enabled: true, ready should be true
```

Then ask SIRA to open a website and read something on it, or to click a
button in a native app, and confirm real `browser_*`/`atspi_*` rows show up
in the same unified feed the desktop bridge uses:

```sh
curl -s http://127.0.0.1:4600/api/desktop-bridge/actions | jq
```

## Saved workflows

Ask SIRA to save a working sequence by name (`workflow_save`), then re-run it
later by name (`workflow_run`) instead of re-describing every step. Replay
checks the live state first — the tab's URL against the pattern recorded at
save time for a browser workflow, or that the app is running for an AT-SPI
one — and runs **zero steps** on a mismatch, handing the decision back to
SIRA rather than guessing. Every replayed step goes through the exact same
audited dispatch a live call does, so a replay is exactly as visible in
`GET /api/desktop-bridge/actions` as a live sequence would be.

## Benchmarking

```sh
npm run bench:automation
```

Compares call counts between granular multi-call sequences and their
composite equivalents (`browser_fill_form`, `browser_extract`) and between a
manual sequence and a saved-workflow replay. This runs entirely against fake
backends in a throwaway database — it measures audit/harness overhead, **not
real Playwright/AT-SPI/GNOME timing**. For genuine timing, re-run the same
command on the owner's machine with `SIRA_BROWSER_BACKEND` and
`SIRA_ATSPI_BACKEND` unset (i.e. don't set them at all — the default already
uses the real backends once a layer is enabled). The report also lands at
`var/bench/<timestamp>.json`.

## Emergency stop

Same switch as the desktop bridge — engaging it halts all three layers:

```sh
curl -s -X POST http://127.0.0.1:4600/api/desktop-bridge/kill \
  -H 'content-type: application/json' -d '{"reason":"manual stop"}'
```

Resume with the same call against `/api/desktop-bridge/resume`. If the
daemon's own event loop is ever wedged, the absolute last resort is:

```sh
systemctl --user stop sira-desktop-bridge
```
