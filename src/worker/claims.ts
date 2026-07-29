// Atomic claiming. SQLite's single-writer lock makes the UPDATE..RETURNING
// claim race-free even with multiple worker processes. After claiming a task
// we double-check predecessor artifacts actually exist — if not, the task is
// honestly blocked, never silently started.
import type { Db } from '../shared/db.ts';
import { emitEvent } from '../shared/events.ts';
import type { SystemConfig } from '../shared/config.ts';

export interface ClaimedTask {
  id: string;
  plan_id: string;
  objective_id: string;
  step_id: string;
  agent_key: string;
  title: string;
  spec: string;
  required_inputs: string;
  expected_artifacts: string;
  acceptance_criteria: string;
  verification: string;
  priority: number;
  status: string;
  attempt_count: number;
  max_attempts: number;
  blocker: string | null;
}

export function claimNextTask(db: Db, cfg: SystemConfig, workerId: string): ClaimedTask | null {
  const now = Date.now();
  const row = db.get<{ id: string }>(
    `UPDATE tasks
     SET status = 'running', claimed_by = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = (
       SELECT t.id FROM tasks t
       WHERE t.status IN ('queued','waiting_for_dependency') AND t.not_before <= ?
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d
           JOIN tasks p ON p.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND p.status != 'completed'
         )
       ORDER BY t.priority ASC, t.created_at ASC LIMIT 1
     )
     RETURNING id`,
    workerId, now + cfg.leaseMs, now, now,
  );
  if (!row) return null;
  const task = db.get<ClaimedTask>('SELECT * FROM tasks WHERE id = ?', row.id) as ClaimedTask;

  emitEvent(db, {
    type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
    payload: { from: 'queued', to: 'running', source: 'worker_claim', workerId, attempt: task.attempt_count },
  });

  // Post-claim honesty check: predecessors are completed (SQL enforced), but
  // their expected artifacts must actually exist on disk records too.
  const deps = db.all<{ id: string; step_id: string; expected_artifacts: string }>(
    `SELECT p.id, p.step_id, p.expected_artifacts FROM task_dependencies d
     JOIN tasks p ON p.id = d.depends_on_task_id WHERE d.task_id = ?`,
    task.id,
  );
  for (const dep of deps) {
    const expected = JSON.parse(dep.expected_artifacts) as string[];
    for (const name of expected) {
      const artifact = db.get('SELECT id FROM artifacts WHERE task_id = ? AND name = ?', dep.id, name);
      if (!artifact) {
        const nowB = Date.now();
        db.run(
          `UPDATE tasks SET status = 'blocked', claimed_by = NULL, lease_expires_at = NULL, blocker = ?, updated_at = ? WHERE id = ?`,
          `dependency ${dep.step_id} completed but artifact "${name}" is missing`, nowB, task.id,
        );
        emitEvent(db, {
          type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
          payload: { from: 'running', to: 'blocked', source: 'dependency_artifact_missing', dep: dep.step_id, artifact: name },
        });
        return null;
      }
    }
  }
  return task;
}

export interface ClaimedObjective {
  id: string;
  title: string;
  description: string;
  status: string;
  conversation_id: string | null;
}

export function claimNextPlanningObjective(db: Db, cfg: SystemConfig, workerId: string): ClaimedObjective | null {
  const now = Date.now();
  const row = db.get<{ id: string }>(
    `UPDATE objectives SET status = 'planning', claimed_by = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = (SELECT id FROM objectives WHERE status = 'open' ORDER BY created_at ASC LIMIT 1)
     RETURNING id`,
    workerId, now + cfg.leaseMs * 5, now,
  );
  if (!row) return null;
  emitEvent(db, { type: 'planning.started', orgId: cfg.orgId, payload: { objectiveId: row.id, workerId } });
  return db.get<ClaimedObjective>('SELECT * FROM objectives WHERE id = ?', row.id) as ClaimedObjective;
}

/** Fencing: every state-mutating step re-checks the claim inside the transaction. */
export function taskStillMine(db: Db, taskId: string, workerId: string): { mine: boolean; status: string } {
  const row = db.get<{ claimed_by: string | null; lease_expires_at: number | null; status: string }>(
    'SELECT claimed_by, lease_expires_at, status FROM tasks WHERE id = ?', taskId,
  );
  if (!row) return { mine: false, status: 'missing' };
  const mine = row.claimed_by === workerId && (row.lease_expires_at ?? 0) > Date.now() &&
    ['running', 'waiting_for_tool', 'waiting_for_approval', 'verifying'].includes(row.status);
  return { mine, status: row.status };
}
