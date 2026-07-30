// Honest backend selection for the browser automation layer — mirrors
// ../backend.ts's resolveBackend(). Priority: explicit SIRA_BROWSER_BACKEND
// override (fake, for every test in this repo's own suite) > an explicit
// not-ready state with a clear reason, never a crash. The real Playwright
// backend is added in a later task; until then any non-fake selection is
// honestly reported as not ready rather than pretending to work.
import type { ResolvedBrowserBackend } from './backend.ts';

export async function resolveBrowserBackend(): Promise<ResolvedBrowserBackend> {
  const forced = process.env.SIRA_BROWSER_BACKEND;
  if (forced === 'fake') {
    const { FakeBrowserBackend } = await import('./backends/fake.ts');
    return { backend: new FakeBrowserBackend(), kind: 'fake', ready: true, reason: 'SIRA_BROWSER_BACKEND=fake', dependencies: {} };
  }

  // The real Playwright backend (backends/playwright-backend.ts) doesn't
  // exist yet — a later task swaps this fallback for a real dynamic import.
  const { FakeBrowserBackend } = await import('./backends/fake.ts');
  return {
    backend: new FakeBrowserBackend(),
    kind: 'fake',
    ready: false,
    reason: 'real Playwright backend not yet implemented — set SIRA_BROWSER_BACKEND=fake for testing',
    dependencies: {},
  };
}
