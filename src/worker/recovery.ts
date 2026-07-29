// Lease sweeper: reaps executions/objectives whose worker died. Runs in every
// worker on startup and on an interval. Expired running executions become
// 'abandoned' (honest state) and their task is re-queued if attempts remain —
// never silently resumed, never left looking active.
import type { Db } from '../shared/db.ts';
import { emitEvent } from '../shared/events.ts';
import type { SystemConfig } from '../shared/config.ts';

export function sweepExpiredLeases(db: Db, cfg: SystemConfig): void {
  const now = Date.now();

  const expired = db.all<{ id: string; task_id: string; agent_key: string }>(
    `SELECT id, task_id, agent_key FROM executions
     WHERE status IN ('running','waiting_for_tool','waiting_for_approval','verifying') AND lease_expires_at < ?`,
    now,
  );
  for (const execution of expired) {
    db.transaction(() => {
      db.run(`UPDATE executions SET status = 'abandoned', failure_reason = 'lease expired (worker died or stalled)', finished_at = ? WHERE id = ? AND status IN ('running','waiting_for_tool','waiting_for_approval','verifying')`,
        now, execution.id);
      const task = db.get<{ id: string; status: string; attempt_count: number; max_attempts: number }>(
        'SELECT id, status, attempt_count, max_attempts FROM tasks WHERE id = ?', execution.task_id,
      );
      if (task && ['running', 'waiting_for_tool', 'waiting_for_approval', 'verifying'].includes(task.status)) {
        const canRetry = task.attempt_count < task.max_attempts;
        db.run(
          `UPDATE tasks SET status = ?, claimed_by = NULL, lease_expires_at = NULL, blocker = ?, not_before = ?, updated_at = ? WHERE id = ?`,
          canRetry ? 'queued' : 'failed',
          canRetry ? 'previous execution abandoned (worker died)' : 'abandoned after max attempts',
          now + 5000, now, task.id,
        );
        emitEvent(db, {
          type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: execution.agent_key,
          payload: { from: task.status, to: canRetry ? 'queued' : 'failed', source: 'lease_expired' },
        });
      }
      emitEvent(db, {
        type: 'execution.finished', orgId: cfg.orgId, executionId: execution.id, taskId: execution.task_id,
        agentKey: execution.agent_key, payload: { status: 'abandoned', reason: 'lease_expired' },
      });
    });
  }

  // Planning claims that expired go back to open.
  db.transaction(() => {
    const stalePlanning = db.all<{ id: string }>(
      `SELECT id FROM objectives WHERE status = 'planning' AND lease_expires_at < ?`, now,
    );
    for (const objective of stalePlanning) {
      db.run(`UPDATE objectives SET status = 'open', claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, now, objective.id);
      emitEvent(db, { type: 'planning.reclaimed', orgId: cfg.orgId, payload: { objectiveId: objective.id } });
    }
  });

  // Stale worker rows.
  db.run(`UPDATE workers SET status = 'stopped' WHERE status = 'online' AND last_heartbeat_at < ?`, now - cfg.staleWorkerMs * 2);

  // Prune old heartbeat events (they are frequent and only useful recently).
  db.run(`DELETE FROM execution_events WHERE type = 'worker.heartbeat' AND created_at < ?`, now - 24 * 3600_000);
}
