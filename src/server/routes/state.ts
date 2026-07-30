// GET /api/state — the full snapshot a client renders from before following
// SSE events. Everything here is read from persisted rows or derived from
// them; nothing is invented.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { SseHub } from '../sse.ts';
import type { SystemConfig } from '../../shared/config.ts';
import { loadAgentsConfig } from '../../shared/config.ts';
import { deriveAgentStatuses, hasFreshWorker } from '../../shared/derive.ts';
import { getSetting } from '../../shared/settings.ts';

export function registerStateRoutes(router: Router, db: Db, hub: SseHub, cfg: SystemConfig): void {
  router.get('/api/state', ({ res }) => {
    const now = Date.now();
    const boardCfg = new Map(loadAgentsConfig().map((a) => [a.key, a]));
    const agents = db.all<{
      key: string; short: string; name_en: string; name_ar: string; color: string;
      reports_to: string | null; lifecycle: string; active_prompt_version_id: string | null;
    }>('SELECT key, short, name_en, name_ar, color, reports_to, lifecycle, active_prompt_version_id FROM agents ORDER BY key');

    const derived = deriveAgentStatuses(db, agents, cfg.staleWorkerMs, now);

    const taskCounts = Object.fromEntries(
      db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
        .map((r) => [r.status, r.n]),
    );

    const objectives = db.all(
      `SELECT id, title, status, created_at, updated_at FROM objectives
       ORDER BY created_at DESC LIMIT 20`,
    );

    const workers = db.all(
      `SELECT id, pid, hostname, started_at, last_heartbeat_at, status FROM workers
       WHERE last_heartbeat_at > ? ORDER BY last_heartbeat_at DESC`,
      now - cfg.staleWorkerMs * 4,
    );

    const pendingApprovals = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`,
    )?.n ?? 0;

    const runningExecutions = db.all(
      `SELECT id, task_id, agent_key, status, started_at, lease_expires_at, turns_used
       FROM executions WHERE status IN ('running','waiting_for_tool','waiting_for_approval','verifying')
       ORDER BY started_at`,
    );

    json(res, 200, {
      serverTime: now,
      lastSeq: hub.lastSeq(),
      autopilot: getSetting(db, 'autopilot') === 'on',
      workerFresh: hasFreshWorker(db, cfg.staleWorkerMs, now),
      workers,
      agents: agents.map((a) => ({
        key: a.key,
        short: a.short,
        nameEn: a.name_en,
        nameAr: a.name_ar,
        color: a.color,
        reportsTo: a.reports_to,
        lifecycle: a.lifecycle,
        promptVersionId: a.active_prompt_version_id,
        board: boardCfg.get(a.key)?.board ?? { x: 50, y: 50 },
        ...derived[a.key],
      })),
      taskCounts,
      objectives,
      pendingApprovals,
      runningExecutions,
    });
  });
}
