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

/**
 * A task that reaches 'failed' or 'cancelled' permanently strands every task
 * that depends on it: the claim filter requires ALL dependencies completed,
 * so dependents would sit in 'waiting_for_dependency' forever and the
 * objective would never finish. Cascade-cancel them (transitively) with an
 * honest blocker, then let maybeCompleteObjective finalize the objective.
 */
export function cascadeDependencyFailure(db: Db, cfg: SystemConfig, fromTaskId: string): void {
  const queue = [fromTaskId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const dependents = db.all<{ id: string; status: string; agent_key: string; step_id: string }>(
      `SELECT t.id, t.status, t.agent_key, t.step_id FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ?`,
      id,
    );
    const now = Date.now();
    for (const dependent of dependents) {
      if (!['waiting_for_dependency', 'queued', 'blocked'].includes(dependent.status)) continue;
      db.run(
        `UPDATE tasks SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL, blocker = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
        `a task this depends on failed or was cancelled (${id})`, now, dependent.id, dependent.status,
      );
      emitEvent(db, {
        type: 'task.status', orgId: cfg.orgId, taskId: dependent.id, agentKey: dependent.agent_key,
        payload: { from: dependent.status, to: 'cancelled', source: 'dependency_failed', dependency: id },
      });
      queue.push(dependent.id);
    }
  }
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
  const completed = total - failed - cancelled;
  // Honest finalization: cancelled work never counts toward "completed".
  // Any failure -> failed; everything cancelled -> cancelled; a mix of
  // completed + cancelled stays 'completed' but the notification says
  // exactly how much of the plan actually ran.
  const finalStatus = failed > 0 ? 'failed' : completed === 0 ? 'cancelled' : 'completed';
  const now = Date.now();

  const objective = db.get<{ title: string; status: string; conversation_id: string | null }>(
    'SELECT title, status, conversation_id FROM objectives WHERE id = ?', objectiveId,
  );
  if (!objective || ['completed', 'failed', 'cancelled'].includes(objective.status)) return;

  const titles: Record<string, string> = {
    completed: cancelled > 0
      ? `Objective completed (partial — ${cancelled} of ${total} tasks cancelled): ${objective.title}`
      : `Objective completed: ${objective.title}`,
    failed: `Objective failed: ${objective.title}`,
    cancelled: `Objective cancelled: ${objective.title}`,
  };
  db.transaction(() => {
    // Background Objective Completion Bridge: an objective that was opened
    // FROM a conversation must return its result to that SAME persistent
    // SIRA session — completing here only marks it terminal, so arm the
    // async completion sweep (src/sira/objective-bridge.ts, runs in the API
    // process, where SiraManager actually lives) rather than treating the
    // generic notification below as the owner's answer.
    //
    // The status check above is NOT atomic with this write (multiple
    // workers, or a worker and the API process, can both reach here for the
    // same objective around the same time) — so finalize with a conditional
    // UPDATE and bail out if another caller already won the race, instead
    // of re-finalizing (which would re-arm an already-completed bridge and
    // produce a duplicate assistant message). completion_summary_status
    // only ever moves out of NULL here, once — the sweep owns every
    // transition after that.
    const won = db.run(
      `UPDATE objectives SET status = ?, completed_at = ?, updated_at = ?,
         completion_summary_status = CASE WHEN conversation_id IS NOT NULL THEN 'pending' ELSE completion_summary_status END
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      finalStatus, now, now, objectiveId,
    );
    if (Number(won.changes) === 0) return;
    emitEvent(db, {
      type: 'objective.finished', orgId: cfg.orgId,
      payload: { objectiveId, status: finalStatus, completed, failed, cancelled, conversationId: objective.conversation_id },
    });
    notify(db, cfg.orgId, {
      kind: finalStatus === 'completed' ? 'objective_completed' : finalStatus === 'cancelled' ? 'objective_cancelled' : 'objective_failed',
      priority: finalStatus === 'failed' ? 'high' : 'normal',
      title: titles[finalStatus],
      body: `${completed}/${total} tasks completed${failed ? `, ${failed} failed` : ''}${cancelled ? `, ${cancelled} cancelled` : ''}`,
      payload: { objectiveId },
    });
  });
}
