// The real BrowserBackend — owner-machine-only, not exercised in CI (same
// status the real GNOME/X11 desktop backends have: code-complete, verified
// on the owner's actual hardware, never spawned here since this dev
// container has no real browser session).
//
// ONE persistent Chrome context, launched lazily on first call and kept
// alive for the daemon's lifetime — this IS the "stays logged into sites
// across calls" mechanism: cookies/localStorage live in userDataDir, never
// closed between actions. Drives the owner's already-installed system
// Chrome via channel:'chrome' rather than downloading Playwright's own
// bundled Chromium (saves real disk/bandwidth, and one browser install to
// maintain, not two).
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { BrowserBackend, ScreenshotResult, TabInfo } from '../backend.ts';

function isHeadless(): boolean {
  // Headless by default (faster, no display server dependency) — the
  // owner can opt into a visible browser (e.g. to watch what SIRA is
  // doing, or for a site that behaves differently headless) with
  // SIRA_BROWSER_HEADLESS=0. Matches the "off unless asked" default this
  // whole feature already uses everywhere else.
  const v = process.env.SIRA_BROWSER_HEADLESS;
  return v !== '0' && v !== 'false';
}

export class PlaywrightBackend implements BrowserBackend {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private pages = new Map<string, Page>();
  private nextTabSeq = 1;
  private readonly userDataDir: string;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.launching) {
      this.launching = chromium.launchPersistentContext(this.userDataDir, {
        channel: 'chrome',
        headless: isHeadless(),
      }).then((ctx) => {
        this.context = ctx;
        // A context can close out from under us (owner closes the window,
        // Chrome crashes) — clear state so the NEXT call relaunches rather
        // than operating against a dead context.
        ctx.on('close', () => { this.context = null; this.pages.clear(); this.launching = null; });
        return ctx;
      });
    }
    return this.launching;
  }

  private tabIdFor(page: Page): string {
    for (const [id, p] of this.pages) if (p === page) return id;
    const id = `tab-${this.nextTabSeq++}`;
    this.pages.set(id, page);
    return id;
  }

  private async pageFor(tabId?: string): Promise<Page> {
    const ctx = await this.ensureContext();
    if (tabId) {
      const existing = this.pages.get(tabId);
      if (existing && !existing.isClosed()) return existing;
    }
    // No tab_id given, or it's stale/closed — fall back to the most
    // recently opened still-open page, or open a fresh one.
    const openPages = ctx.pages().filter((p) => !p.isClosed());
    if (openPages.length > 0) {
      const page = openPages[openPages.length - 1];
      this.tabIdFor(page);
      return page;
    }
    const page = await ctx.newPage();
    this.tabIdFor(page);
    return page;
  }

  private async tabInfo(page: Page): Promise<TabInfo> {
    return { tabId: this.tabIdFor(page), url: page.url(), title: await page.title().catch(() => '') };
  }

  async navigate(url: string, tabId?: string): Promise<TabInfo> {
    const page = await this.pageFor(tabId);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.tabInfo(page);
  }

  async click(selector: string, tabId?: string): Promise<void> {
    const page = await this.pageFor(tabId);
    // CSS selector first (the common case); if that finds nothing, try
    // Playwright's own text/role locator strategies before giving up —
    // this IS the legitimate in-layer fallback chain (see the plan's
    // "genuine code-level fallback chains stay inside one layer" section),
    // reusing Playwright's built-in retry rather than reinventing it.
    const bySelector = page.locator(selector).first();
    if (await bySelector.count() > 0) {
      await bySelector.click();
      return;
    }
    await page.getByText(selector, { exact: false }).first().click();
  }

  async fill(selector: string, value: string, tabId?: string): Promise<void> {
    const page = await this.pageFor(tabId);
    await page.locator(selector).first().fill(value);
  }

  async fillForm(fields: { selector: string; value: string }[], submitSelector?: string, tabId?: string): Promise<void> {
    const page = await this.pageFor(tabId);
    for (const field of fields) {
      await page.locator(field.selector).first().fill(field.value);
    }
    if (submitSelector) await page.locator(submitSelector).first().click();
  }

  async getText(selector: string, tabId?: string): Promise<string> {
    const page = await this.pageFor(tabId);
    return (await page.locator(selector).first().innerText()) ?? '';
  }

  async extract(selectors: Record<string, string>, tabId?: string): Promise<Record<string, string | null>> {
    const page = await this.pageFor(tabId);
    const result: Record<string, string | null> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      try {
        result[name] = await page.locator(selector).first().innerText();
      } catch {
        result[name] = null; // element not found — honest null, not a thrown error mid-batch
      }
    }
    return result;
  }

  async waitFor(
    cond: { kind: 'selector_visible' | 'selector_hidden' | 'selector_attached' | 'load_state' | 'url_matches'; selector?: string; pattern?: string; timeoutMs?: number },
    tabId?: string,
  ): Promise<void> {
    const page = await this.pageFor(tabId);
    const timeout = cond.timeoutMs ?? 10000;
    switch (cond.kind) {
      case 'selector_visible':
        await page.locator(cond.selector ?? '').first().waitFor({ state: 'visible', timeout });
        return;
      case 'selector_hidden':
        await page.locator(cond.selector ?? '').first().waitFor({ state: 'hidden', timeout });
        return;
      case 'selector_attached':
        await page.locator(cond.selector ?? '').first().waitFor({ state: 'attached', timeout });
        return;
      case 'load_state':
        await page.waitForLoadState('load', { timeout });
        return;
      case 'url_matches':
        await page.waitForURL(new RegExp(cond.pattern ?? '.*'), { timeout });
        return;
    }
  }

  async screenshotPage(tabId?: string): Promise<ScreenshotResult> {
    const page = await this.pageFor(tabId);
    const buf = await page.screenshot({ type: 'png' });
    const viewport = page.viewportSize();
    return { base64Png: buf.toString('base64'), width: viewport?.width ?? 0, height: viewport?.height ?? 0 };
  }

  async listTabs(): Promise<TabInfo[]> {
    const ctx = await this.ensureContext();
    const infos: TabInfo[] = [];
    for (const page of ctx.pages()) {
      if (page.isClosed()) continue;
      infos.push(await this.tabInfo(page));
    }
    return infos;
  }

  async newTab(url?: string): Promise<{ tabId: string }> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    const tabId = this.tabIdFor(page);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { tabId };
  }

  async closeTab(tabId: string): Promise<void> {
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`no such tab "${tabId}"`);
    await page.close();
    this.pages.delete(tabId);
  }

  // App launching and command running never touch the browser at all —
  // those are src/desktop-bridge/backend.ts's job (openApp/runCommand),
  // not this backend's; BrowserBackend deliberately has no such methods.
}
