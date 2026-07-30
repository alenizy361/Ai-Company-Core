// SIRA Desktop Bridge — GNOME Shell extension.
//
// Modern GNOME/Wayland deliberately blocks external processes from taking
// screenshots or injecting synthetic input (the security model, not a
// missing feature). The only fully headless way around it is code running
// INSIDE the compositor — this extension — using the same privileged APIs
// GNOME's own accessibility/remote-desktop features use internally:
// Shell.Screenshot for capture, Clutter.Seat virtual input devices for
// mouse/keyboard. It exports a single D-Bus method on the session bus;
// the Node.js daemon (src/desktop-bridge/backends/gnome-wayland.ts) calls
// it via `gdbus call`. Enabling this extension (a one-time, explicit act
// via GNOME Extensions) IS the consent step — there is no per-action
// dialog, matching what SIRA's owner explicitly asked for.
//
// Wire format: both the D-Bus argument and return value are base64-encoded
// JSON, wrapped in GVariant string-literal syntax. This sidesteps GVariant
// text-mode string escaping (fragile for arbitrary typed text) since
// base64 has no characters that need escaping — see gnome-wayland.ts for
// the full rationale. Payload in: {"action":"...","args":{...}}.
// Reply out: {"ok":true,"data":{...}} or {"ok":false,"error":"..."}.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// Promisified once at module scope — the same pattern gnome-shell's own
// js/ui/screenshot.js uses for this exact class, rather than re-wrapping
// the prototype method on every screenshot request.
Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

const DBUS_NAME = 'org.sira.DesktopBridge';
const DBUS_PATH = '/org/sira/DesktopBridge';
const DBUS_IFACE_XML = `
<node>
  <interface name="org.sira.DesktopBridge">
    <method name="Dispatch">
      <arg type="s" direction="in" name="payload"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

const MODIFIER_KEYVALS = {
  ctrl: Clutter.KEY_Control_L, control: Clutter.KEY_Control_L,
  alt: Clutter.KEY_Alt_L,
  shift: Clutter.KEY_Shift_L,
  super: Clutter.KEY_Super_L, meta: Clutter.KEY_Super_L, cmd: Clutter.KEY_Super_L,
};

const BUTTON_CODES = {
  left: Clutter.BUTTON_PRIMARY,
  middle: Clutter.BUTTON_MIDDLE,
  right: Clutter.BUTTON_SECONDARY,
};

const SCROLL_DIRECTIONS = {
  up: Clutter.ScrollDirection.UP,
  down: Clutter.ScrollDirection.DOWN,
  left: Clutter.ScrollDirection.LEFT,
  right: Clutter.ScrollDirection.RIGHT,
};

/**
 * A single key NAME (e.g. "Return", "a", "ك") to an X11 keyval.
 * Named keys (anything matching a Clutter.KEY_<Name> constant — the full
 * X11 keysymdef.h table, auto-generated onto Clutter) resolve directly.
 * A single character falls back to the X11 "Unicode keysym" convention:
 * Latin-1 codepoints (0x20-0xFF) ARE their own keysym; anything above that
 * (e.g. Arabic script) is 0x01000000 + codepoint. This is the exact
 * algorithm gdk_unicode_to_keyval() implements — reimplemented directly so
 * this file only touches GI modules gnome-shell itself already loads
 * (Clutter/Gio/GLib/Shell/St), not Gdk.
 */
function resolveKeyval(name) {
  const direct = Clutter[`KEY_${name}`];
  if (typeof direct === 'number') return direct;
  const chars = [...name];
  if (chars.length === 1) {
    const cp = name.codePointAt(0);
    if (cp >= 0x20 && cp <= 0xff) return cp;
    return 0x01000000 + cp;
  }
  return null;
}

function parseKeyCombo(combo) {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const mainName = parts[parts.length - 1];
  const modifierNames = parts.slice(0, -1);
  const modifierKeyvals = [];
  for (const m of modifierNames) {
    const kv = MODIFIER_KEYVALS[m.toLowerCase()];
    if (kv === undefined) return null;
    modifierKeyvals.push(kv);
  }
  const mainKeyval = resolveKeyval(mainName);
  if (mainKeyval === null) return null;
  return { modifierKeyvals, mainKeyval };
}

class DesktopBridgeService {
  constructor() {
    this._keyboard = null;
    this._pointer = null;
    this._indicator = null;
    this._dbusImpl = null;
    this._ownerId = 0;
  }

  enable() {
    const seat = Clutter.get_default_backend().get_default_seat();
    this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE_XML, this);
    this._ownerId = Gio.bus_own_name(
      Gio.BusType.SESSION, DBUS_NAME, Gio.BusNameOwnerFlags.NONE,
      (connection) => this._dbusImpl.export(connection, DBUS_PATH),
      null, null,
    );

    this._indicator = new PanelMenu.Button(0.0, 'SIRA Desktop Bridge', true);
    const icon = new St.Icon({ icon_name: 'input-mouse-symbolic', style_class: 'system-status-icon' });
    this._indicator.add_child(icon);
    this._indicator.reactive = false; // status-only — no menu, no click target
    Main.panel.addToStatusArea('sira-desktop-bridge', this._indicator);
  }

  disable() {
    if (this._dbusImpl) {
      try { this._dbusImpl.unexport(); } catch { /* already unexported */ }
      this._dbusImpl = null;
    }
    if (this._ownerId) {
      Gio.bus_unown_name(this._ownerId);
      this._ownerId = 0;
    }
    this._indicator?.destroy();
    this._indicator = null;
    // ClutterVirtualInputDevice has no explicit destroy — dropping the
    // reference is enough; GNOME's own remote-input consumers do the same.
    this._keyboard = null;
    this._pointer = null;
  }

  // ---- D-Bus entry point (async: screenshot capture is async) ----
  DispatchAsync(params, invocation) {
    const [payloadB64] = params;
    this._handle(payloadB64)
      .then((resultB64) => invocation.return_value(new GLib.Variant('(s)', [resultB64])))
      .catch((err) => {
        // A bug HERE must still answer the D-Bus call (never leave the
        // Node client hanging on its own timeout) — encode the failure the
        // same way a normal action failure would be.
        const body = { ok: false, error: `extension internal error: ${err instanceof Error ? err.message : String(err)}` };
        const resultB64 = GLib.base64_encode(new TextEncoder().encode(JSON.stringify(body)));
        try { invocation.return_value(new GLib.Variant('(s)', [resultB64])); } catch { /* connection gone */ }
      });
  }

  async _handle(payloadB64) {
    let action, args;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(GLib.base64_decode(payloadB64)));
      action = decoded.action;
      args = decoded.args ?? {};
    } catch (err) {
      return this._encode({ ok: false, error: `bad payload: ${err instanceof Error ? err.message : String(err)}` });
    }
    try {
      const data = await this._run(action, args);
      return this._encode({ ok: true, data: data ?? {} });
    } catch (err) {
      return this._encode({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  _encode(body) {
    return GLib.base64_encode(new TextEncoder().encode(JSON.stringify(body)));
  }

  async _run(action, args) {
    switch (action) {
      case 'screenshot': return this._screenshot();
      case 'click': return this._click(args);
      case 'move_mouse': return this._moveMouse(args);
      case 'type': return this._type(args);
      case 'key': return this._key(args);
      case 'scroll': return this._scroll(args);
      default: throw new Error(`unknown action: ${action}`);
    }
  }

  async _screenshot() {
    const shooter = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    const [area] = await shooter.screenshot(false, stream);
    stream.close(null);
    const bytes = stream.steal_as_bytes();
    const base64Png = GLib.base64_encode(bytes.toArray());
    const width = area?.width ?? global.screen_width;
    const height = area?.height ?? global.screen_height;
    return { base64Png, width, height };
  }

  _click({ x, y, button, clicks }) {
    const code = BUTTON_CODES[button ?? 'left'];
    if (code === undefined) throw new Error(`unknown button: ${button}`);
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const n = Math.max(1, Math.min(10, clicks ?? 1));
    for (let i = 0; i < n; i++) {
      this._pointer.notify_button(GLib.get_monotonic_time(), code, Clutter.ButtonState.PRESSED);
      this._pointer.notify_button(GLib.get_monotonic_time(), code, Clutter.ButtonState.RELEASED);
    }
    return {};
  }

  _moveMouse({ x, y }) {
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    return {};
  }

  _type({ text }) {
    for (const ch of text) {
      const keyval = resolveKeyval(ch === '\n' ? 'Return' : ch === '\t' ? 'Tab' : ch);
      if (keyval === null) continue; // best-effort: skip characters with no resolvable keysym
      this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
      this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    }
    return {};
  }

  _key({ key }) {
    const combo = parseKeyCombo(key);
    if (!combo) throw new Error(`unrecognized key: ${key}`);
    const { modifierKeyvals, mainKeyval } = combo;
    for (const kv of modifierKeyvals) this._keyboard.notify_keyval(GLib.get_monotonic_time(), kv, Clutter.KeyState.PRESSED);
    this._keyboard.notify_keyval(GLib.get_monotonic_time(), mainKeyval, Clutter.KeyState.PRESSED);
    this._keyboard.notify_keyval(GLib.get_monotonic_time(), mainKeyval, Clutter.KeyState.RELEASED);
    for (const kv of modifierKeyvals.slice().reverse()) this._keyboard.notify_keyval(GLib.get_monotonic_time(), kv, Clutter.KeyState.RELEASED);
    return {};
  }

  _scroll({ direction, amount }) {
    const dir = SCROLL_DIRECTIONS[direction];
    if (dir === undefined) throw new Error(`unknown scroll direction: ${direction}`);
    const n = Math.max(1, Math.min(50, amount ?? 3));
    for (let i = 0; i < n; i++) {
      this._pointer.notify_discrete_scroll(GLib.get_monotonic_time(), dir, Clutter.ScrollSource.WHEEL);
    }
    return {};
  }
}

export default class SiraDesktopBridgeExtension extends Extension {
  enable() {
    this._service = new DesktopBridgeService();
    this._service.enable();
  }

  disable() {
    this._service?.disable();
    this._service = null;
  }
}
