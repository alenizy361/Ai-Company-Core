// In-memory fake DesktopBackend — every test in this repo's own suite runs
// against this (SIRA_DESKTOP_BACKEND=mock), since this dev environment has
// no real GNOME session. Records every call for assertions; touches nothing
// on the real OS.
import type { DesktopBackend, ScreenshotResult, CommandResult } from '../backend.ts';

// A real, valid 1x1 transparent PNG, base64-encoded — small enough to keep
// test fixtures light while still round-tripping through the same
// image-content-block path a real screenshot would.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export interface RecordedCall {
  action: string;
  args: Record<string, unknown>;
}

export class MockBackend implements DesktopBackend {
  calls: RecordedCall[] = [];
  /** Test hook: when set, the next matching action rejects instead of succeeding. */
  failNext: { action: string; error: string } | null = null;

  private record(action: string, args: Record<string, unknown>): void {
    this.calls.push({ action, args });
  }

  private maybeFail(action: string): void {
    if (this.failNext?.action === action) {
      const err = this.failNext.error;
      this.failNext = null;
      throw new Error(err);
    }
  }

  async screenshot(): Promise<ScreenshotResult> {
    this.record('screenshot', {});
    this.maybeFail('screenshot');
    return { base64Png: TINY_PNG_BASE64, width: 1, height: 1 };
  }

  async click(x: number, y: number, button = 'left', clicks = 1): Promise<void> {
    this.record('click', { x, y, button, clicks });
    this.maybeFail('click');
  }

  async moveMouse(x: number, y: number): Promise<void> {
    this.record('move_mouse', { x, y });
    this.maybeFail('move_mouse');
  }

  async typeText(text: string): Promise<void> {
    this.record('type', { text });
    this.maybeFail('type');
  }

  async keyPress(key: string): Promise<void> {
    this.record('key', { key });
    this.maybeFail('key');
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<void> {
    this.record('scroll', { direction, amount });
    this.maybeFail('scroll');
  }

  async openApp(desktopFile: string | undefined, fallbackBin: string): Promise<void> {
    this.record('open_app', { desktopFile, fallbackBin });
    this.maybeFail('open_app');
  }

  async runCommand(cmd: string, timeoutMs: number): Promise<CommandResult> {
    this.record('run_command', { cmd, timeoutMs });
    this.maybeFail('run_command');
    return { exitCode: 0, stdout: `mock ran: ${cmd}`, stderr: '' };
  }
}
