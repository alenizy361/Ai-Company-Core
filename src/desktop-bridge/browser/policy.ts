// Browser bridge policy: same deliberately-simple shape as ../policy.ts (the
// desktop bridge's policy) — no per-action approval gate, only a hard-denied
// URL list plus the runtime kill switch (kill-switch.ts, shared with the
// desktop bridge) as the safety net. Unlike the desktop bridge's command
// patterns, there's no path-sensitivity check here — that concept is
// specific to shell command arguments, not navigation URLs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../shared/config.ts';

export interface BrowserPolicy {
  enabled: boolean;
  deniedUrlPatterns: RegExp[];
}

interface BrowserPolicyFile {
  enabled: boolean;
  deniedUrlPatterns: string[];
}

export function loadBrowserPolicy(): BrowserPolicy {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'browser-bridge.json'), 'utf8')) as BrowserPolicyFile;
  return {
    enabled: raw.enabled,
    deniedUrlPatterns: raw.deniedUrlPatterns.map((p) => new RegExp(p, 'i')),
  };
}

/**
 * Hard-denied regardless of "full permission" — local/internal URL schemes
 * (file://, chrome://, javascript:, etc.) that would let navigation escape
 * the intended web-page sandbox.
 */
export function isNavigationDenied(policy: BrowserPolicy, url: string): { denied: boolean; reason?: string } {
  for (const pattern of policy.deniedUrlPatterns) {
    if (pattern.test(url)) {
      return { denied: true, reason: `matches denied pattern: ${pattern.source}` };
    }
  }
  return { denied: false };
}
