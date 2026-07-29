// State-changing API routes: objective creation, plan confirm/reject, task
// cancellation, approval decisions, notification reads. Every mutation is
// audited and emits persisted events; status changes go through the legal
// transition maps only.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json, errorJson } from '../router.ts';
import { loadSystemConfig } from '../../shared/config.ts';
import { emitEvent, audit } from '../../shared/events.ts';
import { assertTransitionTask, type TaskStatus } from '../../shared/statuses.ts';
import { createObjective, confirmPlan, rejectPlan } from '../../planning/plan-service.ts';
import { cascadeDependencyFailure, maybeCompleteObjective } from '../../worker/handoff.ts';

export function registerWriteRoutes(router: Router, db: Db): void {
  const cfg = loadSystemConfig();

  router.post('/api/objectives', ({ res, body }) => {
    const b = body as { title?: string; description?: string; conversationId?: string } | undefined;
    if (!b?.title || typeof b.title !== 'string' || !b.title.trim()) {
      return errorJson(res, 400, 'BAD_REQUEST', 'title is required');
    }
    const objective = createObjective(db, cfg, {
      title: b.title.trim(),
      description: typeof b.description === 'string' ? b.description : '',
      conversationId: b.conversationId ?? null,
    });
    json(res, 201, objective);
  });

  router.post('/api/agents/:key/model', ({ res, params, body }) => {
    const b = body as { tier?: string; customModel?: string; actor?: string } | undefined;
    const tier = String(b?.tier ?? '');
    if (!['fast', 'balanced', 'reasoning', 'custom'].includes(tier)) {
      return errorJson(res, 400, 'BAD_REQUEST', 'tier must be fast | balanced | reasoning | custom');
    }
    if (tier === 'custom' && (!b?.customModel || typeof b.customModel !== 'string')) {
      return errorJson(res, 400, 'BAD_REQUEST', 'customModel is required for the custom tier');
    }
    const agent = db.get<{ key: string; model_tier: string }>('SELECT key, model_tier FROM agents WHERE key = ?', params.key);
    if (!agent) return errorJson(res, 404, 'NOT_FOUND', 'unknown agent');
    db.run('UPDATE agents SET model_tier = ?, model_custom = ?, updated_at = ? WHERE key = ?',
      tier, tier === 'custom' ? b!.customModel! : null, Date.now(), params.key);
    audit(db, cfg.orgId, b?.actor ?? 'owner', 'agent.model_tier', 'agent', params.key,
      { from: agent.model_tier, to: tier, customModel: tier === 'custom' ? b?.customModel : null });
    json(res, 200, { ok: true, tier });
  });

  router.post('/api/plans/:id/confirm', ({ res, params, body }) => {
    const decidedBy = (body as { decidedBy?: string } | undefined)?.decidedBy ?? 'owner';
    try {
      const result = confirmPlan(db, params.id, decidedBy, 'ui');
      json(res, 200, { ok: true, taskIds: result.taskIds });
    } catch (err) {
      errorJson(res, 409, 'CONFLICT', err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/plans/:id/reject', ({ res, params, body }) => {
    const b = body as { reason?: string; decidedBy?: string } | undefined;
    try {
      rejectPlan(db, params.id, b?.decidedBy ?? 'owner', b?.reason ?? 'rejected by owner');
      json(res, 200, { ok: true });
    } catch (err) {
      errorJson(res, 409, 'CONFLICT', err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/tasks/:id/cancel', ({ res, params }) => {
    const task = db.get<{ id: string; status: TaskStatus; agent_key: string; objective_id: string }>(
      'SELECT id, status, agent_key, objective_id FROM tasks WHERE id = ?', params.id,
    );
    if (!task) return errorJson(res, 404, 'NOT_FOUND', 'unknown task');
    try {
      assertTransitionTask(task.status, 'cancelled');
    } catch (err) {
      return errorJson(res, 409, 'ILLEGAL_TRANSITION', err instanceof Error ? err.message : String(err));
    }
    const now = Date.now();
    // TOCTOU guard: the worker may commit a different status (e.g. completed)
    // between our read and this transaction — the UPDATE is conditional on
    // the status we validated, and 0 rows changed means hands off.
    const cancelled = db.transaction(() => {
      const changed = db.run(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = ?`, now, task.id, task.status);
      if (Number(changed.changes) === 0) return false;
      emitEvent(db, {
        type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
        payload: { from: task.status, to: 'cancelled', source: 'owner' },
      });
      audit(db, cfg.orgId, 'owner', 'task.cancel', 'task', task.id, { from: task.status });
      return true;
    });
    if (!cancelled) return errorJson(res, 409, 'CONFLICT', 'task changed state concurrently; re-check and retry');
    // Dependents of a cancelled task can never run; the objective may now be
    // fully terminal — both must be handled here, not just on worker paths.
    cascadeDependencyFailure(db, cfg, task.id);
    maybeCompleteObjective(db, cfg, task.objective_id);
    json(res, 200, { ok: true });
  });

  router.post('/api/tasks/:id/retry', ({ res, params }) => {
    const task = db.get<{ id: string; status: TaskStatus; agent_key: string; attempt_count: number; max_attempts: number }>(
      'SELECT id, status, agent_key, attempt_count, max_attempts FROM tasks WHERE id = ?', params.id,
    );
    if (!task) return errorJson(res, 404, 'NOT_FOUND', 'unknown task');
    if (task.status !== 'failed' && task.status !== 'blocked') {
      return errorJson(res, 409, 'ILLEGAL_TRANSITION', `task is ${task.status}; only failed/blocked tasks can be retried`);
    }
    const now = Date.now();
    db.transaction(() => {
      // Owner-initiated retry resets the attempt budget for one more round.
      db.run(
        `UPDATE tasks SET status = 'queued', max_attempts = MAX(max_attempts, attempt_count + 1),
           blocker = NULL, not_before = 0, updated_at = ? WHERE id = ?`,
        now, task.id,
      );
      emitEvent(db, {
        type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
        payload: { from: task.status, to: 'queued', source: 'owner_retry' },
      });
      audit(db, cfg.orgId, 'owner', 'task.retry', 'task', task.id, {});
    });
    json(res, 200, { ok: true });
  });

  router.post('/api/approvals/:id/decide', ({ res, params, body }) => {
    const b = body as { decision?: 'approved' | 'rejected'; reason?: string; decidedBy?: string; via?: 'ui' | 'voice' | 'api' } | undefined;
    const decision = b?.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return errorJson(res, 400, 'BAD_REQUEST', 'decision must be "approved" or "rejected"');
    }
    const approval = db.get<{ id: string; status: string; execution_id: string | null; task_id: string | null }>(
      'SELECT id, status, execution_id, task_id FROM approvals WHERE id = ?', params.id,
    );
    if (!approval) return errorJson(res, 404, 'NOT_FOUND', 'unknown approval');
    if (approval.status !== 'pending') {
      return errorJson(res, 409, 'CONFLICT', `approval already ${approval.status}`);
    }
    const now = Date.now();
    db.transaction(() => {
      db.run(
        `UPDATE approvals SET status = ?, reason = ?, decided_at = ?, decided_by = ?, decided_via = ? WHERE id = ?`,
        decision, b?.reason ?? null, now, b?.decidedBy ?? 'owner', b?.via ?? 'ui', approval.id,
      );
      emitEvent(db, {
        type: 'approval.decided', orgId: cfg.orgId, executionId: approval.execution_id, taskId: approval.task_id,
        payload: { approvalId: approval.id, decision, via: b?.via ?? 'ui' },
      });
      audit(db, cfg.orgId, b?.decidedBy ?? 'owner', `approval.${decision}`, 'approval', approval.id, { via: b?.via ?? 'ui', reason: b?.reason });
    });
    json(res, 200, { ok: true });
  });

  router.post('/api/notifications/:id/read', ({ res, params }) => {
    const changed = db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', Date.now(), params.id);
    json(res, 200, { ok: true, updated: Number(changed.changes) });
  });

  router.get('/api/notifications', ({ res, query }) => {
    const unreadOnly = query.get('unread') === '1';
    json(res, 200, db.all(
      `SELECT * FROM notifications ${unreadOnly ? 'WHERE read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`,
    ));
  });
}
