// The pluggable interface every desktop-control implementation satisfies.
// dispatch.ts (the enforcement point) only ever talks to this interface —
// it never knows or cares whether the real OS-level work happens via a
// GNOME Shell extension over D-Bus, xdotool/scrot on X11, or an in-memory
// fake for tests. Keeping this interface small and composable is itself a
// safety property: every method here is something dispatch.ts can audit,
// deny, and time-bound uniformly.
import { spawnSync } from 'node:child_process';

export interface ScreenshotResult {
  base64Png: string;
  width: number;
  height: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface DesktopBackend {
  screenshot(): Promise<ScreenshotResult>;
  click(x: number, y: number, button?: string, clicks?: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  keyPress(key: string): Promise<void>;
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
  /** Tries `desktopFile` via gtk-launch first (the standard, sandboxed way
   *  to start a GUI app from its .desktop entry); if that's absent or
   *  fails, spawns `fallbackBin` directly as a last resort. */
  openApp(desktopFile: string | undefined, fallbackBin: string): Promise<void>;
  runCommand(cmd: string, timeoutMs: number): Promise<CommandResult>;
}

export type BackendKind = 'gnome-wayland' | 'x11' | 'mock';

export interface ResolvedBackend {
  backend: DesktopBackend;
  kind: BackendKind;
  ready: boolean;
  reason: string;
  dependencies: Record<string, boolean>;
}

function binAvailable(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 2000 }).status !== null;
  } catch {
    return false;
  }
}

/**
 * Honest backend selection — never silently pretends to work. Priority:
 * explicit SIRA_DESKTOP_BACKEND override (mock, for every test in this
 * repo's own suite) > auto-detect GNOME/Wayland (the owner's confirmed
 * environment, and the only fully headless option there) > X11 fallback >
 * an explicit not-ready state with a clear reason, never a crash.
 */
export async function resolveBackend(): Promise<ResolvedBackend> {
  const forced = process.env.SIRA_DESKTOP_BACKEND;
  if (forced === 'mock') {
    const { MockBackend } = await import('./backends/mock.ts');
    return { backend: new MockBackend(), kind: 'mock', ready: true, reason: 'SIRA_DESKTOP_BACKEND=mock', dependencies: {} };
  }

  const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
  const isX11 = Boolean(process.env.DISPLAY) && !isWayland;

  if (forced === 'x11' || (!forced && isX11)) {
    const { X11Backend } = await import('./backends/x11.ts');
    const deps = { xdotool: binAvailable('xdotool'), scrot: binAvailable('scrot') };
    const ready = deps.xdotool && deps.scrot;
    return {
      backend: new X11Backend(),
      kind: 'x11',
      ready,
      reason: ready ? 'X11 session detected; xdotool + scrot available' : `X11 session detected but missing dependencies: ${Object.entries(deps).filter(([, v]) => !v).map(([k]) => k).join(', ')}`,
      dependencies: deps,
    };
  }

  // Default target: GNOME/Wayland via the SIRA Shell extension (the only
  // fully headless option on modern GNOME — see gnome-extension/).
  const { GnomeWaylandBackend, probeExtension } = await import('./backends/gnome-wayland.ts');
  const probe = await probeExtension();
  return {
    backend: new GnomeWaylandBackend(),
    kind: 'gnome-wayland',
    ready: probe.ready,
    reason: probe.reason,
    dependencies: { gdbus: probe.gdbusAvailable, extension: probe.extensionRegistered },
  };
}
