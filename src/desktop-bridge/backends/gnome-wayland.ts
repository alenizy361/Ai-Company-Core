// The primary backend for the owner's confirmed environment (GNOME on
// Wayland). Modern GNOME/Wayland deliberately blocks external processes
// from injecting synthetic input or taking screenshots — this is the
// security model, not a missing feature. The only fully headless (no
// per-call consent dialog) way around it is code running INSIDE the
// compositor itself: the SIRA GNOME Shell Extension
// (gnome-extension/sira-desktop-bridge@sira.local/), which exposes a
// single D-Bus method and does the real work via GNOME's own privileged
// Shell.Screenshot class and Clutter.Seat.create_virtual_device() — the
// same mechanism GNOME's own accessibility/remote-desktop features use.
//
// D-Bus wire format: every argument and return value is base64-encoded
// JSON wrapped in GVariant string literal syntax ('...'). This is
// deliberate — GVariant's text-mode string escaping (single quotes,
// backslashes) is genuinely fragile to hand-roll for arbitrary
// user-controlled text (e.g. typeText's content); base64 has no characters
// that need escaping in GVariant syntax, so this sidesteps that whole
// class of parsing bugs rather than trying to get manual escaping right.
import { spawn, spawnSync } from 'node:child_process';
import type { DesktopBackend, ScreenshotResult, CommandResult } from '../backend.ts';
import { runShellFreeCommand } from './process-utils.ts';

const DBUS_NAME = 'org.sira.DesktopBridge';
const DBUS_PATH = '/org/sira/DesktopBridge';
const DBUS_METHOD = `${DBUS_NAME}.Dispatch`;
const GDBUS_TIMEOUT_MS = 10000;

function gdbusAvailable(): boolean {
  try {
    return spawnSync('gdbus', ['--help'], { stdio: 'ignore', timeout: 2000 }).status !== null;
  } catch {
    return false;
  }
}

function extensionRegistered(): boolean {
  try {
    const result = spawnSync('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', DBUS_NAME,
    ], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0 && /\(true,?\)/.test(result.stdout ?? '');
  } catch {
    return false;
  }
}

export async function probeExtension(): Promise<{ ready: boolean; reason: string; gdbusAvailable: boolean; extensionRegistered: boolean }> {
  const hasGdbus = gdbusAvailable();
  if (!hasGdbus) {
    return { ready: false, reason: 'gdbus not found — install glib2-utils/libglib2.0-bin', gdbusAvailable: false, extensionRegistered: false };
  }
  const registered = extensionRegistered();
  if (!registered) {
    return {
      ready: false,
      reason: 'the SIRA GNOME Shell extension is not registered on the session bus — install it (gnome-extension/) and enable it via GNOME Extensions, then log out/in',
      gdbusAvailable: true, extensionRegistered: false,
    };
  }
  return { ready: true, reason: 'extension registered and reachable', gdbusAvailable: true, extensionRegistered: true };
}

interface DispatchResult { ok: boolean; data?: Record<string, unknown>; error?: string }

function callExtension(action: string, args: Record<string, unknown>): Promise<DispatchResult> {
  return new Promise((resolvePromise) => {
    const payload = Buffer.from(JSON.stringify({ action, args })).toString('base64');
    const child = spawn('gdbus', [
      'call', '--session', '--dest', DBUS_NAME,
      '--object-path', DBUS_PATH,
      '--method', DBUS_METHOD,
      `'${payload}'`,
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolvePromise({ ok: false, error: `gdbus call timed out after ${GDBUS_TIMEOUT_MS}ms` });
    }, GDBUS_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, error: `failed to spawn gdbus: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolvePromise({ ok: false, error: `gdbus call failed (exit ${code}): ${stderr.trim() || stdout.trim()}` });
        return;
      }
      // Expected shape for a single-string return: ('BASE64...',)
      const match = /^\('([^']*)',?\)\s*$/.exec(stdout.trim());
      if (!match) {
        resolvePromise({ ok: false, error: `unexpected gdbus output: ${stdout.trim().slice(0, 200)}` });
        return;
      }
      try {
        const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as DispatchResult;
        resolvePromise(decoded);
      } catch (err) {
        resolvePromise({ ok: false, error: `failed to parse extension response: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  });
}

async function callOrThrow(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callExtension(action, args);
  if (!result.ok) throw new Error(result.error ?? `${action} failed`);
  return result.data ?? {};
}

export class GnomeWaylandBackend implements DesktopBackend {
  async screenshot(): Promise<ScreenshotResult> {
    const data = await callOrThrow('screenshot', {});
    return { base64Png: String(data.base64Png ?? ''), width: Number(data.width ?? 0), height: Number(data.height ?? 0) };
  }

  async click(x: number, y: number, button = 'left', clicks = 1): Promise<void> {
    await callOrThrow('click', { x, y, button, clicks });
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await callOrThrow('move_mouse', { x, y });
  }

  async typeText(text: string): Promise<void> {
    await callOrThrow('type', { text });
  }

  async keyPress(key: string): Promise<void> {
    await callOrThrow('key', { key });
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<void> {
    await callOrThrow('scroll', { direction, amount });
  }

  // App launching and command running never touch the Wayland-restricted
  // surface (spawning a process isn't synthetic input or screen content),
  // so they go straight through a normal shell-free subprocess — no need
  // to route through the extension at all.
  async openApp(desktopFile: string | undefined, fallbackBin: string): Promise<void> {
    if (desktopFile) {
      const launched = spawnSync('gtk-launch', [desktopFile.replace(/\.desktop$/, '')], { stdio: 'ignore', timeout: 5000 });
      if (launched.status === 0) return;
    }
    spawn(fallbackBin, [], { detached: true, stdio: 'ignore' }).unref();
  }

  async runCommand(cmd: string, timeoutMs: number): Promise<CommandResult> {
    return runShellFreeCommand(cmd, timeoutMs);
  }
}
