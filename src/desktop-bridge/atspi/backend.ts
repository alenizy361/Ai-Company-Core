// The pluggable interface every AT-SPI-control implementation satisfies.
// Mirrors ../backend.ts's DesktopBackend split and ../browser/backend.ts's
// BrowserBackend split: dispatch-level code (added in a later task) only
// ever talks to this interface. This is a THIRD, PARALLEL automation layer
// alongside the desktop bridge (raw screen coordinates) and the browser
// bridge (CSS selectors) — it acts on accessible role/name semantics against
// native Linux GTK/Qt apps via AT-SPI, for apps with no web page to select
// into and where raw coordinates would be fragile across themes/DPI/layout.
import { AtspiHost } from './host.ts';

export interface AtspiMatch {
  app: string;
  role: string;
  name: string;
}

export interface AtspiBackend {
  listApps(): Promise<{ name: string }[]>;
  find(app: string | undefined, role: string | undefined, namePattern: string | undefined): Promise<AtspiMatch[]>;
  click(app: string | undefined, role: string | undefined, namePattern: string): Promise<void>;
  setText(app: string | undefined, role: string | undefined, namePattern: string, text: string): Promise<void>;
  getText(app: string | undefined, role: string | undefined, namePattern: string): Promise<string>;
  waitFor(app: string | undefined, role: string | undefined, namePattern: string, timeoutMs: number): Promise<boolean>;
}

export type AtspiBackendKind = 'atspi' | 'fake';

export interface ResolvedAtspiBackend {
  backend: AtspiBackend;
  kind: AtspiBackendKind;
  ready: boolean;
  reason: string;
  dependencies: Record<string, boolean>;
}

/**
 * Thin wrapper delegating each method to one shared AtspiHost — the real
 * work happens in helper.py; this class only shapes args/results and turns
 * an {ok:false} response into a thrown Error, matching every other real
 * backend in this codebase (GnomeWaylandBackend's callOrThrow, etc.).
 */
export class RealAtspiBackend implements AtspiBackend {
  // One AtspiHost per backend instance (not per call) — its whole purpose is
  // to keep the same persistent Python process alive across every action.
  private readonly host = new AtspiHost();

  private async callOrThrow(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.host.call(action, args);
    if (!result.ok) throw new Error(result.error ?? `${action} failed`);
    return result.data ?? {};
  }

  async listApps(): Promise<{ name: string }[]> {
    const data = await this.callOrThrow('list_apps', {});
    return (data.apps as { name: string }[] | undefined) ?? [];
  }

  async find(app: string | undefined, role: string | undefined, namePattern: string | undefined): Promise<AtspiMatch[]> {
    const data = await this.callOrThrow('find', { app, role, name_pattern: namePattern });
    return (data.matches as AtspiMatch[] | undefined) ?? [];
  }

  async click(app: string | undefined, role: string | undefined, namePattern: string): Promise<void> {
    await this.callOrThrow('click', { app, role, name_pattern: namePattern });
  }

  async setText(app: string | undefined, role: string | undefined, namePattern: string, text: string): Promise<void> {
    await this.callOrThrow('set_text', { app, role, name_pattern: namePattern, text });
  }

  async getText(app: string | undefined, role: string | undefined, namePattern: string): Promise<string> {
    const data = await this.callOrThrow('get_text', { app, role, name_pattern: namePattern });
    return String(data.text ?? '');
  }

  async waitFor(app: string | undefined, role: string | undefined, namePattern: string, timeoutMs: number): Promise<boolean> {
    const data = await this.callOrThrow('wait_for', { app, role, name_pattern: namePattern, timeout_ms: timeoutMs });
    return Boolean(data.found);
  }
}
