// In-memory fake BrowserBackend — mirrors ../../backends/mock.ts's role for
// DesktopBackend. Runs against SIRA_BROWSER_BACKEND=fake since this dev
// environment has no real browser session. Records every call for
// assertions; touches nothing on the real OS or network.
import type { BrowserBackend, ScreenshotResult, TabInfo } from '../backend.ts';

// A real, valid 1x1 transparent PNG, base64-encoded — same constant value as
// ../../backends/mock.ts's TINY_PNG_BASE64, so it round-trips through the
// same image-content-block path a real screenshot would.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export interface RecordedBrowserCall {
  action: string;
  args: Record<string, unknown>;
}

export class FakeBrowserBackend implements BrowserBackend {
  calls: RecordedBrowserCall[] = [];
  /** Test hook: when set, the next matching action rejects instead of succeeding. */
  failNext: { action: string; error: string } | null = null;

  private tabs = new Map<string, { url: string; title: string }>([['tab-1', { url: 'about:blank', title: 'about:blank' }]]);

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

  private resolveTabId(tabId?: string): string {
    return tabId ?? 'tab-1';
  }

  async navigate(url: string, tabId?: string): Promise<TabInfo> {
    this.record('navigate', { url, tabId });
    this.maybeFail('navigate');
    const id = this.resolveTabId(tabId);
    // title = url for simplicity — the fake never renders a real page.
    const tab = { url, title: url };
    this.tabs.set(id, tab);
    return { tabId: id, ...tab };
  }

  async click(selector: string, tabId?: string): Promise<void> {
    this.record('click', { selector, tabId });
    this.maybeFail('click');
  }

  async fill(selector: string, value: string, tabId?: string): Promise<void> {
    this.record('fill', { selector, value, tabId });
    this.maybeFail('fill');
  }

  async fillForm(fields: { selector: string; value: string }[], submitSelector?: string, tabId?: string): Promise<void> {
    this.record('fill_form', { fields, submitSelector, tabId });
    this.maybeFail('fill_form');
  }

  async getText(selector: string, tabId?: string): Promise<string> {
    this.record('get_text', { selector, tabId });
    this.maybeFail('get_text');
    return `fake-text:${selector}`;
  }

  async extract(selectors: Record<string, string>, tabId?: string): Promise<Record<string, string | null>> {
    this.record('extract', { selectors, tabId });
    this.maybeFail('extract');
    const result: Record<string, string | null> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      result[name] = `fake-text:${selector}`;
    }
    return result;
  }

  async waitFor(
    cond: {
      kind: 'selector_visible' | 'selector_hidden' | 'selector_attached' | 'load_state' | 'url_matches';
      selector?: string;
      pattern?: string;
      timeoutMs?: number;
    },
    tabId?: string,
  ): Promise<void> {
    this.record('wait_for', { cond, tabId });
    this.maybeFail('wait_for');
  }

  async screenshotPage(tabId?: string): Promise<ScreenshotResult> {
    this.record('screenshot_page', { tabId });
    this.maybeFail('screenshot_page');
    return { base64Png: TINY_PNG_BASE64, width: 1, height: 1 };
  }

  async listTabs(): Promise<TabInfo[]> {
    this.record('list_tabs', {});
    this.maybeFail('list_tabs');
    return [...this.tabs.entries()].map(([tabId, tab]) => ({ tabId, ...tab }));
  }

  async newTab(url = 'about:blank'): Promise<{ tabId: string }> {
    this.record('new_tab', { url });
    this.maybeFail('new_tab');
    const tabId = `tab-${this.calls.length + 1}`;
    this.tabs.set(tabId, { url, title: url });
    return { tabId };
  }

  async closeTab(tabId: string): Promise<void> {
    this.record('close_tab', { tabId });
    this.maybeFail('close_tab');
    if (this.tabs.size <= 1) throw new Error('cannot close the last remaining tab');
    if (!this.tabs.has(tabId)) throw new Error(`no such tab "${tabId}"`);
    this.tabs.delete(tabId);
  }
}
