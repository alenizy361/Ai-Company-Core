// Emergency stop for the desktop bridge — the owner's explicit "last line of
// defense" requirement alongside the audit log and catastrophic-action
// denylist (see policy.ts). Two independent layers:
//   1. A lock file, checked FIRST on every action (kill-switch.ts, here) —
//      zero DB dependency, so it still works even if SQLite is somehow
//      unavailable, and both the API server (writing it) and the daemon
//      process (polling it, see daemon.ts) can observe it without an RPC.
//   2. settings.desktop_bridge.armed — the human-facing/UI mirror of that
//      same state, NOT the enforcement source of truth (the lock file is).
// systemctl --user stop sira-desktop-bridge is documented separately as the
// absolute last resort if this process's own event loop were ever wedged.
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../shared/db.ts';
import type { Paths } from '../shared/config.ts';
import { audit } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import { setSetting } from '../shared/settings.ts';

export function lockFilePath(paths: Paths): string {
  return join(paths.varDir, 'desktop-bridge.kill');
}

export function isKilled(paths: Paths): boolean {
  return existsSync(lockFilePath(paths));
}

export function kill(db: Db, paths: Paths, orgId: string, reason: string): void {
  writeFileSync(lockFilePath(paths), `${new Date().toISOString()} ${reason}\n`, 'utf8');
  setSetting(db, 'desktop_bridge.armed', 'false');
  audit(db, orgId, 'owner', 'desktop_bridge.kill', 'desktop_bridge', 'singleton', { reason });
  notify(db, orgId, {
    kind: 'desktop_bridge_killed', priority: 'critical',
    title: 'Desktop bridge stopped', body: reason.slice(0, 500),
  });
}

export function resume(db: Db, paths: Paths, orgId: string): void {
  const path = lockFilePath(paths);
  if (existsSync(path)) unlinkSync(path);
  setSetting(db, 'desktop_bridge.armed', 'true');
  audit(db, orgId, 'owner', 'desktop_bridge.resume', 'desktop_bridge', 'singleton', {});
  notify(db, orgId, {
    kind: 'desktop_bridge_resumed', priority: 'normal',
    title: 'Desktop bridge resumed', body: 'Desktop control is active again.',
  });
}
