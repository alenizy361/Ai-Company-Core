// Fallback backend for an X11 session (e.g. "Ubuntu on Xorg"). Not the
// owner's confirmed environment (they run GNOME/Wayland — see
// gnome-wayland.ts) but kept behind the same DesktopBackend interface for
// completeness, since X11 has no equivalent restriction on external
// screenshot/input tools. Uses xdotool (mouse/keyboard) + scrot
// (screenshots), both spawned shell-free.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopBackend, ScreenshotResult, CommandResult } from '../backend.ts';
import { runShellFreeCommand } from './process-utils.ts';

const BUTTON_CODES: Record<string, string> = { left: '1', middle: '2', right: '3' };
const SCROLL_BUTTON_CODES: Record<string, string> = { up: '4', down: '5', left: '6', right: '7' };

function runXdotool(args: string[], timeoutMs = 5000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('xdotool', args, { shell: false, stdio: 'ignore', timeout: timeoutMs });
    child.on('error', (err) => reject(new Error(`xdotool failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`xdotool exited with code ${code}`));
    });
  });
}

/** Reads width/height directly out of the PNG IHDR chunk (bytes 16-23) —
 *  avoids depending on ImageMagick's `identify` just for two integers. */
function readPngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export class X11Backend implements DesktopBackend {
  async screenshot(): Promise<ScreenshotResult> {
    const dir = mkdtempSync(join(tmpdir(), 'sira-desktop-shot-'));
    const path = join(dir, 'shot.png');
    try {
      const result = spawnSync('scrot', ['-o', path], { stdio: 'ignore', timeout: 8000 });
      if (result.status !== 0) throw new Error(`scrot exited with code ${result.status}`);
      const buf = readFileSync(path);
      const { width, height } = readPngDimensions(buf);
      return { base64Png: buf.toString('base64'), width, height };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async click(x: number, y: number, button = 'left', clicks = 1): Promise<void> {
    const code = BUTTON_CODES[button] ?? BUTTON_CODES.left;
    await runXdotool(['mousemove', String(x), String(y)]);
    await runXdotool(['click', '--repeat', String(Math.max(1, clicks)), code]);
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await runXdotool(['mousemove', String(x), String(y)]);
  }

  async typeText(text: string): Promise<void> {
    await runXdotool(['type', '--clearmodifiers', '--', text]);
  }

  async keyPress(key: string): Promise<void> {
    await runXdotool(['key', '--clearmodifiers', key]);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<void> {
    const code = SCROLL_BUTTON_CODES[direction] ?? SCROLL_BUTTON_CODES.down;
    await runXdotool(['click', '--repeat', String(Math.max(1, amount)), code]);
  }

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
