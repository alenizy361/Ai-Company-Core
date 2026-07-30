// Autopilot: the "company that never stops". When the owner enables it:
//   1. Proposed plans are confirmed automatically (actor 'autopilot', with a
//      notification each time — auto never means silent).
//   2. When the board is idle, a new work cycle is created from the owner's
//      STANDING DIRECTIVE (a goal the owner wrote once), time-gated and
//      token-budget-gated so a dedicated machine works around the clock
//      without burning the whole subscription quota in one hour.
// Safety unchanged: dangerous tools still stop for owner approval, plans are
// still validated, verification still gates completion. Autopilot removes
// WAITING, not oversight of irreversible actions.
import type { Db } from '../shared/db.ts';
import type { SystemConfig } from '../shared/config.ts';
import { getSetting, setSetting } from '../shared/settings.ts';
import { notify } from '../shared/notify.ts';
import { audit } from '../shared/events.ts';
import { confirmPlan, createObjective } from '../planning/plan-service.ts';

const CYCLE_MS = Number(process.env.SIRA_AUTOPILOT_CYCLE_MS ?? 6 * 3600_000);      // new self-directed cycle every 6h
const TOKEN_BUDGET_5H = Number(process.env.SIRA_AUTOPILOT_TOKENS_5H ?? 3_000_000); // pause when the 5h window is this hot

export function autopilotEnabled(db: Db): boolean {
  return getSetting(db, 'autopilot') === 'on';
}

function tokensInCurrent5hWindow(db: Db, now: number): number {
  const row = db.get<{ total: number | null }>(
    `SELECT SUM(input_tokens + output_tokens) AS total FROM usage_windows
     WHERE kind = 'session_5h' AND window_end > ?`, now,
  );
  return row?.total ?? 0;
}

/** Called from the worker sweeper (every sweepMs) and once at boot. */
export function runAutopilotSweep(db: Db, cfg: SystemConfig): void {
  if (!autopilotEnabled(db)) return;
  const now = Date.now();

  // Quota guard: a hot usage window pauses autopilot (it resumes by itself).
  const tokens = tokensInCurrent5hWindow(db, now);
  if (tokens >= TOKEN_BUDGET_5H) {
    if (getSetting(db, 'autopilot.pausedNotified') !== 'yes') {
      setSetting(db, 'autopilot.pausedNotified', 'yes');
      notify(db, cfg.orgId, {
        kind: 'autopilot_paused', priority: 'normal',
        title: 'Autopilot paused: usage budget reached',
        body: `The current 5-hour window used ${tokens.toLocaleString()} tokens (budget ${TOKEN_BUDGET_5H.toLocaleString()}). Autopilot resumes automatically in the next window.`,
        payload: { tokens },
      });
    }
    return;
  }
  if (getSetting(db, 'autopilot.pausedNotified') === 'yes') setSetting(db, 'autopilot.pausedNotified', 'no');

  // 1. Auto-confirm every proposed plan (the step that used to wait on the
  //    owner). Notified per plan; audited as actor 'autopilot'.
  const proposed = db.all<{ id: string; objective_id: string }>(`SELECT id, objective_id FROM plans WHERE status = 'proposed'`);
  for (const plan of proposed) {
    try {
      const result = confirmPlan(db, plan.id, 'autopilot', 'api');
      const title = db.get<{ title: string }>('SELECT title FROM objectives WHERE id = ?', plan.objective_id)?.title ?? plan.objective_id;
      notify(db, cfg.orgId, {
        kind: 'autopilot_confirmed', priority: 'normal',
        title: `Autopilot confirmed the plan: ${title}`,
        body: `${result.taskIds.length} task(s) started without waiting. Disable autopilot to review plans yourself.`,
        payload: { planId: plan.id, objectiveId: plan.objective_id },
      });
    } catch { /* plan changed state concurrently — next sweep re-evaluates */ }
  }

  // 2. Self-directed cycle: when the board is idle and a standing directive
  //    exists, open the next work cycle from it.
  const directive = (getSetting(db, 'autopilot.directive') ?? '').trim();
  if (!directive) return;
  const active = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM objectives WHERE status IN ('open','planning','plan_proposed','in_progress')`,
  )?.n ?? 0;
  if (active > 0) return;
  const lastCycleAt = Number(getSetting(db, 'autopilot.lastCycleAt') ?? 0);
  if (now - lastCycleAt < CYCLE_MS) return;

  setSetting(db, 'autopilot.lastCycleAt', String(now));
  const objective = createObjective(db, cfg, {
    title: `Autopilot cycle: ${directive.slice(0, 70)}`,
    description:
      `${directive}\n\nThis objective was opened automatically by autopilot from the owner's standing directive. ` +
      `Plan the single most valuable next increment of this directive (small, completable, verifiable) — not the whole directive at once. ` +
      `Build on prior cycles' results in company memory and artifacts; do not repeat work that is already done.`,
    createdBy: 'autopilot',
  });
  audit(db, cfg.orgId, 'autopilot', 'objective.create', 'objective', objective.id, { directive: directive.slice(0, 200) });
  notify(db, cfg.orgId, {
    kind: 'autopilot_cycle', priority: 'normal',
    title: 'Autopilot opened a new work cycle',
    body: directive.slice(0, 300),
    payload: { objectiveId: objective.id },
  });
}
