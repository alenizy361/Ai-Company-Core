// Lease sweeper: reaps executions/tasks/objectives whose worker died. Runs in
// every worker on startup and on an interval. Expired running executions
// become 'abandoned' (honest state) and their task is re-queued if attempts
// remain — never silently resumed, never left looking active. Tasks that died
// in the claim window (claimed, lease expired, but no execution row yet) are
// swept directly, and every terminal failure cascades to dependents and
// re-evaluates the objective so nothing hangs 'in_progress' forever.
import type { Db } from '../shared/db.ts';
import { emitEvent } from '../shared/events.ts';
import type { SystemConfig } from '../shared/config.ts';
import { cascadeDependencyFailure, maybeCompleteObjective } from './handoff.ts';

const CLAIMED_STATES = ['running', 'waiting_for_tool', 'waiting_for_approval', 'verifying'];

function requeueOrFail(
  db: Db,
  cfg: SystemConfig,
  task: { id: string; status: string; attempt_count: number; max_attempts: number; objective_id: string },
  agentKey: string,
  now: number,
): void {
  const canRetry = task.attempt_count < task.max_attempts;
  db.run(
    `UPDATE tasks SET status = ?, claimed_by = NULL, lease_expires_at = NULL, blocker = ?, not_before = ?, updated_at = ? WHERE id = ?`,
    canRetry ? 'queued' : 'failed',
    canRetry ? 'previous execution abandoned (worker died)' : 'abandoned after max attempts',
    now + 5000, now, task.id,
  );
  emitEvent(db, {
    type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey,
    payload: { from: task.status, to: canRetry ? 'queued' : 'failed', source: 'lease_expired' },
  });
  if (!canRetry) {
    cascadeDependencyFailure(db, cfg, task.id);
    maybeCompleteObjective(db, cfg, task.objective_id);
  }
}

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
      const task = db.get<{ id: string; status: string; attempt_count: number; max_attempts: number; objective_id: string }>(
        'SELECT id, status, attempt_count, max_attempts, objective_id FROM tasks WHERE id = ?', execution.task_id,
      );
      if (task && CLAIMED_STATES.includes(task.status)) {
        requeueOrFail(db, cfg, task, execution.agent_key, now);
      }
      emitEvent(db, {
        type: 'execution.finished', orgId: cfg.orgId, executionId: execution.id, taskId: execution.task_id,
        agentKey: execution.agent_key, payload: { status: 'abandoned', reason: 'lease_expired' },
      });
    });
  }

  // Claim-window orphans: a task claimed to 'running' whose worker died
  // BEFORE the executions row was inserted has no execution for the sweep
  // above to find — without this pass it would stay 'running' forever, even
  // across restarts.
  const orphaned = db.all<{ id: string; status: string; agent_key: string; attempt_count: number; max_attempts: number; objective_id: string }>(
    `SELECT id, status, agent_key, attempt_count, max_attempts, objective_id FROM tasks
     WHERE status IN ('running','waiting_for_tool','waiting_for_approval','verifying') AND lease_expires_at < ?`,
    now,
  );
  for (const task of orphaned) {
    db.transaction(() => requeueOrFail(db, cfg, task, task.agent_key, now));
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
