// In-memory fake AtspiBackend — mirrors ../../backends/mock.ts's role for
// DesktopBackend and ../../browser/backends/fake.ts's role for
// BrowserBackend. Runs against SIRA_ATSPI_BACKEND=fake since this dev
// environment has no real AT-SPI session. Records every call for
// assertions; NEVER spawns Python or imports host.ts — fully in-memory,
// zero subprocess.
import type { AtspiBackend, AtspiMatch } from '../backend.ts';

export interface RecordedAtspiCall {
  action: string;
  args: Record<string, unknown>;
}

export class FakeAtspiBackend implements AtspiBackend {
  calls: RecordedAtspiCall[] = [];
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

  async listApps(): Promise<{ name: string }[]> {
    this.record('list_apps', {});
    this.maybeFail('list_apps');
    return [{ name: 'Files' }, { name: 'Terminal' }];
  }

  async find(app: string | undefined, role: string | undefined, namePattern: string | undefined): Promise<AtspiMatch[]> {
    this.record('find', { app, role, namePattern });
    this.maybeFail('find');
    // One deterministic match echoing whatever was asked for — enough for
    // callers to assert on without this fake pretending to model a real tree.
    return [{ app: app ?? 'fake-app', role: role ?? 'push button', name: namePattern ?? 'fake-widget' }];
  }

  async click(app: string | undefined, role: string | undefined, namePattern: string): Promise<void> {
    this.record('click', { app, role, namePattern });
    this.maybeFail('click');
  }

  async setText(app: string | undefined, role: string | undefined, namePattern: string, text: string): Promise<void> {
    this.record('set_text', { app, role, namePattern, text });
    this.maybeFail('set_text');
  }

  async getText(app: string | undefined, role: string | undefined, namePattern: string): Promise<string> {
    this.record('get_text', { app, role, namePattern });
    this.maybeFail('get_text');
    return `fake-text:${namePattern}`;
  }

  async waitFor(app: string | undefined, role: string | undefined, namePattern: string, timeoutMs: number): Promise<boolean> {
    this.record('wait_for', { app, role, namePattern, timeoutMs });
    this.maybeFail('wait_for');
    return true;
  }
}
