// Honest backend selection for the browser automation layer — mirrors
// ../backend.ts's resolveBackend(). Priority: explicit SIRA_BROWSER_BACKEND
// override (fake, for every test in this repo's own suite) > real Playwright
// driving the system Chrome, reported not-ready with a clear reason (never
// a crash) if Chrome isn't installed.
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResolvedBrowserBackend } from './backend.ts';

function binAvailable(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 2000 }).status !== null;
  } catch {
    return false;
  }
}

// Playwright's own launcher resolves 'chrome' via well-known install paths
// (and PATH) per-OS — this probe is just for an honest /health reason
// string before we ever actually try to launch.
function chromeAvailable(): boolean {
  return binAvailable('google-chrome') || binAvailable('google-chrome-stable') || binAvailable('chromium') || binAvailable('chromium-browser');
}

/** varDir: this daemon's paths.varDir — the persistent Chrome profile
 *  (cookies/localStorage, i.e. "stays logged in across calls") lives at
 *  varDir/browser-profile/, never wiped between actions or restarts. */
export async function resolveBrowserBackend(varDir: string): Promise<ResolvedBrowserBackend> {
  const forced = process.env.SIRA_BROWSER_BACKEND;
  if (forced === 'fake') {
    const { FakeBrowserBackend } = await import('./backends/fake.ts');
    return { backend: new FakeBrowserBackend(), kind: 'fake', ready: true, reason: 'SIRA_BROWSER_BACKEND=fake', dependencies: {} };
  }

  const chrome = chromeAvailable();
  const { PlaywrightBackend } = await import('./backends/playwright-backend.ts');
  return {
    backend: new PlaywrightBackend(join(varDir, 'browser-profile')),
    kind: 'playwright',
    ready: chrome,
    reason: chrome ? 'system Chrome found' : 'no system Chrome/Chromium found on PATH — install google-chrome-stable (or chromium)',
    dependencies: { chrome },
  };
}
