// Desktop bridge policy: NOT a reuse of src/tools/policy.ts's approval/path
// model — that concept doesn't map to a mouse click or a screenshot. This is
// a much simpler policy deliberately shaped around the owner's explicit
// choice for this feature: no per-action approval gate, only a hard-denied
// catastrophic-action list plus the runtime kill switch (kill-switch.ts) as
// the safety net. Every action is still fully audited (dispatch.ts) — "no
// approval gate" is not "no accountability".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/config.ts';
import { isSensitivePath } from '../sira/session.ts';

export interface CuratedApp {
  desktopFile?: string;
  fallbackBin: string;
}

export interface DesktopPolicy {
  enabled: boolean;
  deniedCommandPatterns: RegExp[];
  curatedApps: Record<string, CuratedApp>;
}

interface DesktopPolicyFile {
  enabled: boolean;
  deniedCommandPatterns: string[];
  curatedApps: Record<string, CuratedApp>;
}

export function loadDesktopPolicy(): DesktopPolicy {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'desktop-bridge.json'), 'utf8')) as DesktopPolicyFile;
  return {
    enabled: raw.enabled,
    deniedCommandPatterns: raw.deniedCommandPatterns.map((p) => new RegExp(p, 'i')),
    curatedApps: raw.curatedApps,
  };
}

/**
 * Hard-denied regardless of "full permission" — catastrophic commands
 * (disk wipe, root deletion, self-sabotage, etc.) plus any argument that
 * resolves to a sensitive credential/system path (reusing the same
 * isSensitivePath check the live SDK session's native Read/Glob/Grep use).
 */
export function isCatastrophic(policy: DesktopPolicy, commandLine: string): { denied: boolean; reason?: string } {
  for (const pattern of policy.deniedCommandPatterns) {
    if (pattern.test(commandLine)) {
      return { denied: true, reason: `matches denied pattern: ${pattern.source}` };
    }
  }
  for (const token of commandLine.split(/\s+/)) {
    if (token.startsWith('/') && isSensitivePath(token)) {
      return { denied: true, reason: `references a sensitive path: ${token}` };
    }
  }
  return { denied: false };
}

export function resolveCuratedApp(policy: DesktopPolicy, name: string): CuratedApp | undefined {
  return policy.curatedApps[name];
}
