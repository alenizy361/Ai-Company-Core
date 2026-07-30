// The pluggable interface every browser-control implementation satisfies.
// Mirrors ../backend.ts's DesktopBackend split: dispatch-level code (added in
// a later task) only ever talks to this interface — it never knows or cares
// whether the real work happens via Playwright driving a real browser, or an
// in-memory fake for tests. This is a PARALLEL automation layer to the
// desktop bridge, not a replacement — it acts on page semantics (CSS
// selectors, tab ids) instead of raw screen coordinates.
import type { ScreenshotResult } from '../backend.ts';

export type { ScreenshotResult };

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
}

export interface BrowserBackend {
  navigate(url: string, tabId?: string): Promise<TabInfo>;
  click(selector: string, tabId?: string): Promise<void>;
  fill(selector: string, value: string, tabId?: string): Promise<void>;
  fillForm(fields: { selector: string; value: string }[], submitSelector?: string, tabId?: string): Promise<void>;
  getText(selector: string, tabId?: string): Promise<string>;
  extract(selectors: Record<string, string>, tabId?: string): Promise<Record<string, string | null>>;
  waitFor(
    cond: {
      kind: 'selector_visible' | 'selector_hidden' | 'selector_attached' | 'load_state' | 'url_matches';
      selector?: string;
      pattern?: string;
      timeoutMs?: number;
    },
    tabId?: string,
  ): Promise<void>;
  screenshotPage(tabId?: string): Promise<ScreenshotResult>;
  listTabs(): Promise<TabInfo[]>;
  newTab(url?: string): Promise<{ tabId: string }>;
  closeTab(tabId: string): Promise<void>;
}

export type BrowserBackendKind = 'playwright' | 'fake';

export interface ResolvedBrowserBackend {
  backend: BrowserBackend;
  kind: BrowserBackendKind;
  ready: boolean;
  reason: string;
  dependencies: Record<string, boolean>;
}
