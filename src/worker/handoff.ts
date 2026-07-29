// On verified completion: build structured handoff records for each dependent
// task, then promote dependents whose dependencies are all complete.
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import type { SystemConfig } from '../shared/config.ts';

export interface CompletionInfo {
  summary: string;
  assumptions: string[];
  unresolved: string[];
  nextAction: string;
}

export function createHandoffsAndUnblock(
  db: Db,
  cfg: SystemConfig,
  task: { id: string; agent_key: string; objective_id: string },
  executionId: string,
  completion: CompletionInfo,
): void {
  const now = Date.now();
  const artifacts = db.all<{ id: string }>('SELECT id FROM artifacts WHERE task_id = ? AND execution_id = ?', task.id, executionId);
  const artifactIds = artifacts.map((a) => a.id);

  const dependents = db.all<{ id: string; agent_key: string; step_id: string; acceptance_criteria: string; status: string }>(
    `SELECT t.id, t.agent_key, t.step_id, t.acceptance_criteria, t.status FROM task_dependencies d
     JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ?`,
    task.id,
  );

  db.transaction(() => {
    for (const dependent of dependents) {
      db.run(
        `INSERT INTO handoffs (id, from_task_id, to_task_id, from_agent, to_agent, execution_id, artifact_ids,
           summary, assumptions, unresolved_issues, next_action, acceptance_criteria, created_at, verified_at, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'artifacts_confirmed')`,
        ulid('hnd'), task.id, dependent.id, task.agent_key, dependent.agent_key, executionId,
        JSON.stringify(artifactIds), completion.summary.slice(0, 4000), JSON.stringify(completion.assumptions),
        JSON.stringify(completion.unresolved), completion.nextAction.slice(0, 1000), dependent.acceptance_criteria, now, now,
      );
      emitEvent(db, {
        type: 'handoff.created', orgId: cfg.orgId, taskId: dependent.id, executionId,
        payload: { fromTask: task.id, fromAgent: task.agent_key, toAgent: dependent.agent_key, artifactIds },
      });

      // Promote dependent if ALL its dependencies are now complete.
      if (dependent.status === 'waiting_for_dependency') {
        const unmet = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id
           WHERE d.task_id = ? AND p.status != 'completed'`,
          dependent.id,
        );
        if ((unmet?.n ?? 1) === 0) {
          db.run(`UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'waiting_for_dependency'`, now, dependent.id);
          emitEvent(db, {
            type: 'task.status', orgId: cfg.orgId, taskId: dependent.id, agentKey: dependent.agent_key,
            payload: { from: 'waiting_for_dependency', to: 'queued', source: 'dependencies_satisfied' },
          });
        }
      }
    }
  });
}

/** If every task of the objective is terminal, finish the objective (+ notification). */
export function maybeCompleteObjective(db: Db, cfg: SystemConfig, objectiveId: string): void {
  const counts = db.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM tasks WHERE objective_id = ? GROUP BY status', objectiveId,
  );
  const total = counts.reduce((s, c) => s + c.n, 0);
  if (total === 0) return;
  const terminal = counts.filter((c) => ['completed', 'failed', 'cancelled'].includes(c.status)).reduce((s, c) => s + c.n, 0);
  if (terminal !== total) return;

  const failed = counts.find((c) => c.status === 'failed')?.n ?? 0;
  const cancelled = counts.find((c) => c.status === 'cancelled')?.n ?? 0;
  const finalStatus = failed > 0 ? 'failed' : 'completed';
  const now = Date.now();

  const objective = db.get<{ title: string; status: string }>('SELECT title, status FROM objectives WHERE id = ?', objectiveId);
  if (!objective || ['completed', 'failed', 'cancelled'].includes(objective.status)) return;

  db.transaction(() => {
    db.run('UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?', finalStatus, now, objectiveId);
    emitEvent(db, {
      type: 'objective.finished', orgId: cfg.orgId,
      payload: { objectiveId, status: finalStatus, completed: total - failed - cancelled, failed, cancelled },
    });
    notify(db, cfg.orgId, {
      kind: finalStatus === 'completed' ? 'objective_completed' : 'objective_failed',
      priority: finalStatus === 'completed' ? 'normal' : 'high',
      title: finalStatus === 'completed' ? `Objective completed: ${objective.title}` : `Objective failed: ${objective.title}`,
      body: `${total - failed - cancelled}/${total} tasks completed${failed ? `, ${failed} failed` : ''}${cancelled ? `, ${cancelled} cancelled` : ''}`,
      payload: { objectiveId },
    });
  });
}
