// POST /api/converse — the owner's conversation with RABIT (voice or text;
// both share one persisted conversation). Streams SSE events:
//   meta -> state -> say (sentence-safe speakable segments) -> route -> done
// The model replies in a converse contract; the server executes route actions
// (create objective / approve / cancel) against real records and persists
// every message. In mock mode the reply is honestly labeled MOCK MODE.
import type { ServerResponse } from 'node:http';
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { errorJson } from '../router.ts';
import { ulid } from '../../shared/ids.ts';
import { emitEvent, audit } from '../../shared/events.ts';
import { loadSystemConfig } from '../../shared/config.ts';
import { hasFreshWorker } from '../../shared/derive.ts';
import { extractFirstJsonObject } from '../../shared/extract-json.ts';
import { getActiveCoreBundle } from '../../promptreg/registry.ts';
import { createObjective } from '../../planning/plan-service.ts';
import { assertTransitionTask, type TaskStatus } from '../../shared/statuses.ts';
import type { ModelAdapter, ChatMessage } from '../../adapters/types.ts';
import { recordTransition, verifyVoiceToken } from '../../voice/session.ts';

const CONVERSE_CONTRACT = `
# CONVERSE MODE — you are RABIT, the owner's company operating system, speaking with the owner.

Respond with EXACTLY ONE JSON object:
{"route":"reply","say":"<spoken answer>"}
{"route":"create_objective","title":"<short objective title>","description":"<what the owner wants, complete>","say":"<confirm what you'll do + that a plan will follow for approval>"}
{"route":"approve","approval_id":"<id from the pending list>","decision":"approved"|"rejected","say":"<confirmation>"}
{"route":"cancel_task","task_id":"<id>","say":"<confirmation>"}
{"route":"clarify","say":"<one specific question>"}

Rules:
- "say" is SPOKEN aloud: short, natural, complete sentences in the owner's language (Arabic in -> Arabic out; mirror code-switching). No JSON, ids, URLs, paths, or markdown inside "say" — say counts and names in words.
- Ground every claim in the COMPANY STATE section below — it is the live truth. Never invent tasks, progress, or results. If state shows nothing running, say so.
- A request to do work = create_objective (planning + execution happen in the background and need owner confirmation before agents run). A question = reply. An explicit approval/rejection of a listed pending approval = approve.
- Never claim an action was taken beyond what your route actually does.`;

function sentenceSegments(text: string): string[] {
  const parts = text.match(/[^.!?؟…\n]+[.!?؟…]?\s*/g) ?? [text];
  const merged: string[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + part.length < 60) merged[merged.length - 1] = last + part;
    else merged.push(part);
  }
  return merged.map((s) => s.trim()).filter(Boolean);
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function companyStateSummary(db: Db, cfg: ReturnType<typeof loadSystemConfig>): string {
  const objectives = db.all<{ id: string; title: string; status: string }>(
    `SELECT id, title, status FROM objectives ORDER BY created_at DESC LIMIT 6`,
  );
  const running = db.all<{ agent_key: string; title: string }>(
    `SELECT e.agent_key, t.title FROM executions e JOIN tasks t ON t.id = e.task_id
     WHERE e.status IN ('running','waiting_for_tool','verifying','waiting_for_approval')`,
  );
  const taskCounts = db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`);
  const approvals = db.all<{ id: string; summary: string }>(
    `SELECT id, summary FROM approvals WHERE status = 'pending' ORDER BY requested_at LIMIT 5`,
  );
  const plansProposed = db.all<{ id: string; objective_id: string; reply: string }>(
    `SELECT id, objective_id, reply FROM plans WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 3`,
  );
  const workerOnline = hasFreshWorker(db, cfg.staleWorkerMs);
  return [
    `Worker: ${workerOnline ? 'ONLINE' : 'OFFLINE — nothing can execute until a worker runs'}`,
    `Objectives: ${objectives.map((o) => `${o.title} [${o.status}] (id ${o.id})`).join('; ') || 'none'}`,
    `Currently executing: ${running.map((r) => `${r.agent_key}: ${r.title}`).join('; ') || 'nothing'}`,
    `Task counts: ${taskCounts.map((t) => `${t.status}=${t.n}`).join(', ') || 'none'}`,
    `Plans awaiting owner confirmation: ${plansProposed.map((p) => `plan ${p.id}: ${p.reply.slice(0, 120)}`).join('; ') || 'none'}`,
    `Pending approvals: ${approvals.map((a) => `${a.id}: ${a.summary}`).join('; ') || 'none'}`,
  ].join('\n');
}

export function registerConverseRoutes(router: Router, db: Db, getAdapter: () => ModelAdapter): void {
  const cfg = loadSystemConfig();

  router.post('/api/converse', async ({ res, body }) => {
    const b = body as {
      conversationId?: string; text?: string; modality?: 'voice' | 'text'; lang?: string;
      voiceSessionId?: string; voiceToken?: string;
    } | undefined;
    if (!b?.text || typeof b.text !== 'string' || !b.text.trim()) {
      return errorJson(res, 400, 'BAD_REQUEST', 'text is required');
    }
    const modality = b.modality === 'voice' ? 'voice' : 'text';
    const voiceSession =
      b.voiceSessionId && b.voiceToken && verifyVoiceToken(db, b.voiceSessionId, b.voiceToken) ? b.voiceSessionId : null;

    const now = Date.now();
    let conversationId = b.conversationId ?? null;
    if (conversationId) {
      const exists = db.get('SELECT id FROM conversations WHERE id = ?', conversationId);
      if (!exists) conversationId = null;
    }
    if (!conversationId) {
      conversationId = ulid('cnv');
      db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        conversationId, cfg.orgId, b.text.slice(0, 80), now, now);
    }
    const userMessageId = ulid('msg');
    db.run(
      `INSERT INTO messages (id, conversation_id, role, modality, lang, content, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      userMessageId, conversationId, modality, b.lang ?? '', b.text, now,
    );

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    sse(res, 'meta', { conversationId, userMessageId });

    // System prompt: core truth/communication rules + converse contract.
    let coreText = '';
    try {
      coreText = getActiveCoreBundle(db).text;
    } catch { /* pre-seed: converse still works with the bare contract */ }
    const system = `${coreText}\n\n${CONVERSE_CONTRACT}`;

    const history = db.all<{ role: string; content: string; route: string | null }>(
      `SELECT role, content, route FROM messages WHERE conversation_id = ? AND id != ? ORDER BY created_at DESC LIMIT 12`,
      conversationId, userMessageId,
    ).reverse();

    const messages: ChatMessage[] = [];
    for (const m of history) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content });
    }
    messages.push({
      role: 'user',
      content: `# COMPANY STATE (live, authoritative)\n${companyStateSummary(db, cfg)}\n\n# OWNER SAYS (${modality})\n${b.text}\n\nRespond with exactly one converse-contract JSON object.`,
    });

    if (voiceSession) recordTransition(db, voiceSession, 'thinking', 'server');
    sse(res, 'state', { state: 'thinking' });

    const adapter = getAdapter();
    const requestId = ulid('mr');
    const started = Date.now();
    let text: string;
    try {
      const result = await adapter.complete({ system, messages, purpose: 'converse' });
      text = result.text;
      db.run(
        `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, 'converse', ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
        requestId, adapter.name, result.model, system.length + messages.reduce((n, m) => n + m.content.length, 0),
        text.slice(0, 50000), result.usage.input, result.usage.output, Date.now() - started, Date.now(),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      db.run(
        `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, error, duration_ms, created_at)
         VALUES (?, 'converse', ?, '', 0, '', 'adapter_error', ?, ?, ?)`,
        requestId, adapter.name, detail.slice(0, 1000), Date.now() - started, Date.now(),
      );
      if (voiceSession) recordTransition(db, voiceSession, 'failed', 'server');
      sse(res, 'error', { message: 'model unavailable', reference: requestId, detail: detail.slice(0, 200) });
      sse(res, 'done', {});
      res.end();
      return;
    }

    // Parse the converse contract; unparseable output degrades to a plain reply.
    let route = 'reply';
    let say = text.trim();
    let routePayload: Record<string, unknown> = {};
    const extracted = extractFirstJsonObject(text);
    if (extracted.ok) {
      const obj = extracted.value as Record<string, unknown>;
      if (typeof obj.say === 'string' && typeof obj.route === 'string') {
        route = obj.route;
        say = obj.say;
        routePayload = obj;
      }
    }

    // Execute the route against real records.
    let routeResult: Record<string, unknown> = {};
    try {
      if (route === 'create_objective') {
        const title = String(routePayload.title ?? b.text.slice(0, 80));
        const objective = createObjective(db, cfg, {
          title,
          description: String(routePayload.description ?? b.text),
          createdBy: modality === 'voice' ? 'owner_voice' : 'owner',
          conversationId,
        });
        routeResult = { objectiveId: objective.id };
        if (voiceSession) recordTransition(db, voiceSession, 'creating_plan', 'server');
        sse(res, 'state', { state: 'creating_plan' });
      } else if (route === 'approve') {
        const approvalId = String(routePayload.approval_id ?? '');
        const decision = routePayload.decision === 'rejected' ? 'rejected' : 'approved';
        const approval = db.get<{ id: string; status: string; execution_id: string | null; task_id: string | null; summary: string }>(
          'SELECT id, status, execution_id, task_id, summary FROM approvals WHERE id = ?', approvalId,
        );
        if (approval && approval.status === 'pending') {
          db.transaction(() => {
            db.run(`UPDATE approvals SET status = ?, decided_at = ?, decided_by = 'owner', decided_via = ? WHERE id = ?`,
              decision, Date.now(), modality === 'voice' ? 'voice' : 'ui', approval.id);
            emitEvent(db, {
              type: 'approval.decided', orgId: cfg.orgId, executionId: approval.execution_id, taskId: approval.task_id,
              payload: { approvalId: approval.id, decision, via: modality === 'voice' ? 'voice' : 'ui' },
            });
            audit(db, cfg.orgId, 'owner', `approval.${decision}`, 'approval', approval.id,
              { via: modality === 'voice' ? 'voice' : 'ui', summary: approval.summary });
          });
          routeResult = { approvalId, decision };
        } else {
          routeResult = { error: 'approval not found or not pending' };
          say = modality === 'voice' && /[؀-ۿ]/.test(b.text)
            ? 'لم أجد طلب موافقة معلّقًا بهذا الوصف.'
            : 'I could not find that pending approval.';
        }
      } else if (route === 'cancel_task') {
        const taskId = String(routePayload.task_id ?? '');
        const task = db.get<{ id: string; status: TaskStatus; agent_key: string }>(
          'SELECT id, status, agent_key FROM tasks WHERE id = ?', taskId);
        if (task) {
          try {
            assertTransitionTask(task.status, 'cancelled');
            db.transaction(() => {
              db.run(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`, Date.now(), task.id);
              emitEvent(db, {
                type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
                payload: { from: task.status, to: 'cancelled', source: modality === 'voice' ? 'owner_voice' : 'owner' },
              });
              audit(db, cfg.orgId, 'owner', 'task.cancel', 'task', task.id, { via: modality });
            });
            routeResult = { taskId, cancelled: true };
          } catch {
            routeResult = { error: `task is ${task.status}; cannot cancel` };
          }
        } else routeResult = { error: 'task not found' };
      }
    } catch (err) {
      routeResult = { error: err instanceof Error ? err.message : String(err) };
    }

    const assistantMessageId = ulid('msg');
    db.run(
      `INSERT INTO messages (id, conversation_id, role, modality, lang, content, route, model_request_id, objective_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`,
      assistantMessageId, conversationId, modality, b.lang ?? '', say, route, requestId,
      (routeResult.objectiveId as string | undefined) ?? null, Date.now(),
    );
    db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now(), conversationId);

    sse(res, 'route', { route, ...routeResult });
    for (const segment of sentenceSegments(say)) sse(res, 'say', { text: segment });
    if (voiceSession) recordTransition(db, voiceSession, 'ready', 'server');
    sse(res, 'done', { assistantMessageId, say });
    res.end();
  });

  router.get('/api/conversations/:id', ({ res, params }) => {
    const rows = db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', params.id);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rows));
  });
}
