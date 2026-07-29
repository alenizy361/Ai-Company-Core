// Derived state: the board never stores an agent's runtime status. It is
// computed here, from worker heartbeats + task rows, on every snapshot.
// Rule (interface truth): if no worker heartbeat is fresh, nothing is
// "running" — every activatable agent renders offline.
import type { Db } from './db.ts';

export type DerivedAgentStatus =
  | 'not_configured'
  | 'offline'
  | 'idle'
  | 'queued'
  | 'blocked'
  | 'running'
  | 'waiting_for_tool'
  | 'waiting_for_dependency'
  | 'waiting_for_approval'
  | 'verifying'
  | 'failed'
  | 'cancelled'
  | 'completed';

export interface AgentRow {
  key: string;
  lifecycle: string;
}

const ACTIVE_TASK_STATUSES = new Set([
  'running',
  'waiting_for_tool',
  'waiting_for_approval',
  'verifying',
]);

export function hasFreshWorker(db: Db, staleWorkerMs: number, now = Date.now()): boolean {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workers WHERE status = 'online' AND last_heartbeat_at > ?`,
    now - staleWorkerMs,
  );
  return (row?.n ?? 0) > 0;
}

export function deriveAgentStatuses(
  db: Db,
  agents: AgentRow[],
  staleWorkerMs: number,
  now = Date.now(),
): Record<string, { status: DerivedAgentStatus; taskId: string | null }> {
  const workerFresh = hasFreshWorker(db, staleWorkerMs, now);
  const out: Record<string, { status: DerivedAgentStatus; taskId: string | null }> = {};

  for (const agent of agents) {
    if (agent.lifecycle !== 'active') {
      out[agent.key] = { status: 'not_configured', taskId: null };
      continue;
    }
    if (!workerFresh) {
      out[agent.key] = { status: 'offline', taskId: null };
      continue;
    }
    // The agent's visible state is its most advanced in-flight task, if any.
    const task = db.get<{ id: string; status: string }>(
      `SELECT id, status FROM tasks
       WHERE agent_key = ? AND status IN ('running','waiting_for_tool','waiting_for_approval','verifying','queued','waiting_for_dependency','blocked')
       ORDER BY CASE status
         WHEN 'running' THEN 0 WHEN 'verifying' THEN 1 WHEN 'waiting_for_tool' THEN 2
         WHEN 'waiting_for_approval' THEN 3 WHEN 'blocked' THEN 4
         WHEN 'queued' THEN 5 WHEN 'waiting_for_dependency' THEN 6 END,
       updated_at DESC LIMIT 1`,
      agent.key,
    );
    if (!task) {
      out[agent.key] = { status: 'idle', taskId: null };
    } else if (ACTIVE_TASK_STATUSES.has(task.status)) {
      out[agent.key] = { status: task.status as DerivedAgentStatus, taskId: task.id };
    } else if (task.status === 'waiting_for_dependency') {
      out[agent.key] = { status: 'waiting_for_dependency', taskId: task.id };
    } else {
      out[agent.key] = { status: task.status as DerivedAgentStatus, taskId: task.id };
    }
  }
  return out;
}
