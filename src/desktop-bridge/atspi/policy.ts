// AT-SPI bridge policy: same deliberately-simple shape as ../policy.ts (the
// desktop bridge's policy) and ../browser/policy.ts (the browser bridge's
// policy) — except there's no denylist at all here. Every AT-SPI action is a
// structured find/click/set_text against a matched accessible widget, never
// a free-text command or URL, so there's nothing shaped like a "denied
// pattern" to check. The safety net is the kill switch (shared with the
// desktop and browser bridges) plus the full audit trail dispatch.ts writes
// for every call — not a denylist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../shared/config.ts';

export interface AtspiPolicy {
  enabled: boolean;
}

export function loadAtspiPolicy(): AtspiPolicy {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'atspi-bridge.json'), 'utf8')) as AtspiPolicy;
  return { enabled: raw.enabled };
}
