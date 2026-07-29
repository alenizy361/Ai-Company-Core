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
  // across restarts. The candidate list is a stale read: each task is
  // re-validated INSIDE its transaction (another process may have cancelled,
  // completed, or re-claimed it in the meantime — acting on the stale row
  // would resurrect cancelled work or double-execute).
  const orphaned = db.all<{ id: string }>(
    `SELECT id FROM tasks
     WHERE status IN ('running','waiting_for_tool','waiting_for_approval','verifying') AND lease_expires_at < ?`,
    now,
  );
  for (const candidate of orphaned) {
    db.transaction(() => {
      const task = db.get<{ id: string; status: string; agent_key: string; attempt_count: number; max_attempts: number; objective_id: string; lease_expires_at: number | null }>(
        'SELECT id, status, agent_key, attempt_count, max_attempts, objective_id, lease_expires_at FROM tasks WHERE id = ?',
        candidate.id,
      );
      if (!task || !CLAIMED_STATES.includes(task.status) || (task.lease_expires_at ?? 0) >= now) return;
      requeueOrFail(db, cfg, task, task.agent_key, now);
    });
  }

  // Backstop for the dependency cascade: a crash between a terminal task
  // transition and its cascade can leave dependents waiting on a task that
  // will never complete. Cancel them here (same semantics as
  // cascadeDependencyFailure) and re-evaluate their objectives.
  const stranded = db.all<{ id: string; status: string; agent_key: string; objective_id: string; dep_id: string }>(
    `SELECT t.id, t.status, t.agent_key, t.objective_id, p.id AS dep_id FROM tasks t
     JOIN task_dependencies d ON d.task_id = t.id
     JOIN tasks p ON p.id = d.depends_on_task_id
     WHERE t.status IN ('waiting_for_dependency','queued','blocked') AND p.status IN ('failed','cancelled')`,
  );
  const strandedObjectives = new Set<string>();
  for (const task of stranded) {
    db.transaction(() => {
      const changed = db.run(
        `UPDATE tasks SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL, blocker = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
        `a task this depends on failed or was cancelled (${task.dep_id})`, now, task.id, task.status,
      );
      if (Number(changed.changes) === 0) return;
      emitEvent(db, {
        type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
        payload: { from: task.status, to: 'cancelled', source: 'dependency_failed', dependency: task.dep_id },
      });
      strandedObjectives.add(task.objective_id);
    });
  }
  for (const objectiveId of strandedObjectives) maybeCompleteObjective(db, cfg, objectiveId);

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
