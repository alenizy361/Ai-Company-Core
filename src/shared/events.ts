// Persisted execution events are the single source of truth for everything
// the interface displays live. The SSE hub streams rows from this table;
// nothing user-visible may be invented client-side.
import type { Db } from './db.ts';
import { ulid } from './ids.ts';

export interface EventInput {
  type: string;
  orgId: string;
  executionId?: string | null;
  taskId?: string | null;
  agentKey?: string | null;
  payload?: Record<string, unknown>;
}

export function emitEvent(db: Db, ev: EventInput): void {
  db.run(
    `INSERT INTO execution_events (id, org_id, execution_id, task_id, agent_key, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ulid('ev'),
    ev.orgId,
    ev.executionId ?? null,
    ev.taskId ?? null,
    ev.agentKey ?? null,
    ev.type,
    JSON.stringify(ev.payload ?? {}),
    Date.now(),
  );
}

export function audit(
  db: Db,
  orgId: string,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown> = {},
): void {
  db.run(
    `INSERT INTO audit_logs (id, org_id, actor, action, entity_type, entity_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ulid('aud'),
    orgId,
    actor,
    action,
    entityType,
    entityId,
    JSON.stringify(payload),
    Date.now(),
  );
}
