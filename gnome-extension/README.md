# SIRA Desktop Bridge — GNOME Shell extension

Lets SIRA's parent conversation see the screen and control the mouse/keyboard
on a machine you have fully dedicated to it. This is a real, unrestricted
capability — read this whole file before turning it on.

## What this is (and isn't)

Modern GNOME on Wayland deliberately blocks external processes from taking
screenshots or injecting synthetic input — that's the security model, not a
bug. The only fully headless way around it is code running *inside* the
compositor itself, which is exactly what `sira-desktop-bridge@sira.local/`
is: a small extension that exposes one D-Bus method
(`org.sira.DesktopBridge.Dispatch`) and does the real work with the same
privileged APIs GNOME's own accessibility/remote-desktop features use
internally (`Shell.Screenshot`, `Clutter.Seat` virtual input devices).

Enabling the extension is the one-time consent step. There is **no
per-action confirmation dialog** after that — every desktop action SIRA
takes runs immediately, gated only by:

- `config/desktop-bridge.json`'s catastrophic-action denylist (disk wipe,
  root deletion, stopping SIRA's own services, etc. — hard-denied no matter
  what),
- the kill switch (`POST /api/desktop-bridge/kill`, or
  `systemctl --user stop sira-desktop-bridge` as the absolute last resort),
- a full audit trail of every action (`GET /api/desktop-bridge/actions`).

Only enable this on a machine with nothing sensitive on it — no personal
accounts, no financial access, nothing you wouldn't want an AI agent to be
able to click on.

## Install

`scripts/install-sira.sh --services` does this automatically: copies this
directory to `~/.local/share/gnome-shell/extensions/sira-desktop-bridge@sira.local/`
and runs `gnome-extensions enable sira-desktop-bridge@sira.local`.

To do it by hand:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r "gnome-extension/sira-desktop-bridge@sira.local" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable sira-desktop-bridge@sira.local
```

**Then log out and back in.** GNOME/Wayland only loads a newly-installed
extension at Shell startup — there is no live-reload for an extension GNOME
has never seen before.

Targets GNOME Shell 45+ (the current ESM extension format — Ubuntu 23.10+
or 24.04+). Ubuntu 22.04 ships GNOME 42, which uses the older
`imports.misc.extensionUtils`-based format; this extension has not been
ported to it.

## Turning it on

The feature is **off by default** even once the extension and the
`sira-desktop-bridge` systemd service are both installed and running — the
daemon just reports itself not-ready.

The one-command way — installs everything above AND flips it on:

```sh
./scripts/install-sira.sh --enable-desktop-bridge
```

Or by hand, on an existing `--services` install:

1. Set `"enabled": true` in `config/desktop-bridge.json`.
2. `systemctl --user restart sira-api sira-desktop-bridge`

Either way, you still need to log out and back in once for GNOME to load
the extension itself (see above) — nothing scripts around that.

## Verifying it's really working

```sh
curl -s http://127.0.0.1:4600/api/desktop-bridge/status | jq
# backend.ready should be true, backend.kind should be "gnome-wayland"
```

Then ask SIRA (voice or chat) to take a screenshot, and confirm a real
`desktop_screenshot` row shows up:

```sh
curl -s http://127.0.0.1:4600/api/desktop-bridge/actions | jq
```

## Emergency stop

```sh
curl -s -X POST http://127.0.0.1:4600/api/desktop-bridge/kill \
  -H 'content-type: application/json' -d '{"reason":"manual stop"}'
```

Resume with the same call against `/api/desktop-bridge/resume`. If the
daemon's own event loop is ever wedged, the absolute last resort is:

```sh
systemctl --user stop sira-desktop-bridge
```
