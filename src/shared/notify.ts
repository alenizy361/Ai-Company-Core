// Single write path for owner notifications: persists the row and emits a
// notification.created event so the interface learns about it over SSE
// instead of polling.
import type { Db } from './db.ts';
import { ulid } from './ids.ts';
import { emitEvent } from './events.ts';

export interface NotificationInput {
  kind: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

export function notify(db: Db, orgId: string, n: NotificationInput): string {
  const id = ulid('ntf');
  db.run(
    `INSERT INTO notifications (id, org_id, kind, priority, title, body, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, orgId, n.kind, n.priority, n.title, n.body, JSON.stringify(n.payload ?? {}), Date.now(),
  );
  emitEvent(db, {
    type: 'notification.created', orgId,
    payload: { notificationId: id, kind: n.kind, priority: n.priority, title: n.title },
  });
  return id;
}
