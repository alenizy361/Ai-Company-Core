// Owner-facing control surface for the desktop bridge daemon (a separate OS
// process — see src/desktop-bridge/). Kill/resume write the shared lock file
// directly (this process and the daemon share the same filesystem/paths.varDir)
// AND best-effort notify the daemon over HTTP for an immediate in-flight-
// subprocess signal — both outcomes are reported honestly, never assumed.
import type { Db } from '../../shared/db.ts';
import type { SystemConfig, Paths } from '../../shared/config.ts';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import { kill, resume, isKilled } from '../../desktop-bridge/kill-switch.ts';
import { killDesktopBridgeDaemon, resumeDesktopBridgeDaemon, getDesktopBridgeStatus } from '../../desktop-bridge/client.ts';

export function registerDesktopBridgeRoutes(router: Router, db: Db, cfg: SystemConfig, paths: Paths): void {
  router.post('/api/desktop-bridge/kill', async ({ res, body }) => {
    const reason = (body as { reason?: string } | undefined)?.reason?.slice(0, 500) || 'owner-triggered kill switch';
    kill(db, paths, cfg.orgId, reason);
    const daemon = await killDesktopBridgeDaemon(cfg, reason);
    json(res, 200, { ok: true, armed: false, daemonNotified: daemon.ok, daemonError: daemon.error ?? null });
  });

  router.post('/api/desktop-bridge/resume', async ({ res }) => {
    resume(db, paths, cfg.orgId);
    const daemon = await resumeDesktopBridgeDaemon(cfg);
    json(res, 200, { ok: true, armed: true, daemonNotified: daemon.ok, daemonError: daemon.error ?? null });
  });

  router.get('/api/desktop-bridge/status', async ({ res }) => {
    const status = await getDesktopBridgeStatus(cfg);
    json(res, 200, { ...status, armed: !isKilled(paths) });
  });

  router.get('/api/desktop-bridge/actions', ({ res, query }) => {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    const conversationId = query.get('conversationId');
    const rows = conversationId
      ? db.all(
          `SELECT id, conversation_id, agent_key, tool, args_json, decision, denial_reason, status, result_summary, result_artifact_id, started_at, finished_at
           FROM tool_calls WHERE tool LIKE 'desktop_%' AND conversation_id = ? ORDER BY started_at DESC LIMIT ?`,
          conversationId, limit,
        )
      : db.all(
          `SELECT id, conversation_id, agent_key, tool, args_json, decision, denial_reason, status, result_summary, result_artifact_id, started_at, finished_at
           FROM tool_calls WHERE tool LIKE 'desktop_%' ORDER BY started_at DESC LIMIT ?`,
          limit,
        );
    json(res, 200, { actions: rows });
  });
}
