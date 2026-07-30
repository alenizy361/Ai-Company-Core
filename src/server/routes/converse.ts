// POST /api/converse — the owner's conversation with SIRA (voice or text;
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
import { SayStreamExtractor, SentenceBuffer } from '../../shared/say-stream.ts';
import { converseModel } from '../../shared/model-tier.ts';
import { getActiveCoreBundle } from '../../promptreg/registry.ts';
import { createObjective, confirmPlan, rejectPlan } from '../../planning/plan-service.ts';
import { assertTransitionTask, type TaskStatus } from '../../shared/statuses.ts';
import { AdapterError, type ModelAdapter, type ChatMessage } from '../../adapters/types.ts';
import { recordTransition, verifyVoiceToken } from '../../voice/session.ts';
import { cascadeDependencyFailure, maybeCompleteObjective } from '../../worker/handoff.ts';
import type { SiraManager } from '../../sira/session.ts';
import { SpeakableStream, speakableSentence } from '../../sira/speakable.ts';

/**
 * The reply-language rule lives IN the system contract: when the owner locks
 * a reply language, the mirror-the-speaker rule must be REPLACED, not
 * contradicted by a note buried in the user turn (the model resolves that
 * contradiction in favor of the system rule and keeps mirroring).
 */
function converseContract(replyLang: 'en' | 'ar' | null): string {
  const sayLanguageRule = replyLang
    ? `ALWAYS in ${replyLang === 'en' ? 'English' : 'Arabic'} — the owner locked the reply language in settings; do NOT mirror the owner's input language`
    : `in the owner's language (Arabic in -> Arabic out; mirror code-switching)`;
  return `
# CONVERSE MODE — you are SIRA, the owner's company operating system, speaking with the owner.

Respond with EXACTLY ONE JSON object:
{"route":"reply","say":"<spoken answer>"}
{"route":"create_objective","title":"<short objective title>","description":"<what the owner wants, complete>","say":"<confirm what you'll do + that a plan will follow for approval>"}
{"route":"confirm_plan","plan_id":"<id from the plans-awaiting list>","say":"<confirmation that the team is starting>"}
{"route":"reject_plan","plan_id":"<id from the plans-awaiting list>","reason":"<the owner's reason>","say":"<confirmation>"}
{"route":"approve","approval_id":"<id from the pending approvals list>","decision":"approved"|"rejected","say":"<confirmation>"}
{"route":"cancel_task","task_id":"<id>","say":"<confirmation>"}
{"route":"clarify","say":"<one specific question>"}

Rules:
- "say" is SPOKEN aloud: short, natural, complete sentences ${sayLanguageRule}. No JSON, ids, URLs, paths, or markdown inside "say" — say counts and names in words.
- Ground every claim in the COMPANY STATE section below — it is the live truth. Never invent tasks, progress, or results. If state shows nothing running, say so.
- A request to do work = create_objective (planning + execution happen in the background and need owner confirmation before agents run). A question = reply.
- When the owner approves/starts a plan from "Plans awaiting owner confirmation" = confirm_plan (this is what actually starts execution). "approve" is ONLY for tool approvals in the "Pending approvals" list.
- Never claim an action was taken beyond what your route actually does.`;
}

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

export function registerConverseRoutes(
  router: Router,
  db: Db,
  getAdapter: () => ModelAdapter,
  sira: SiraManager | null = null,
): void {
  const cfg = loadSystemConfig();

  router.post('/api/converse', async ({ res, body }) => {
    const b = body as {
      conversationId?: string; text?: string; modality?: 'voice' | 'text'; lang?: string;
      replyLang?: string; delegate?: boolean; voiceSessionId?: string; voiceToken?: string;
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

    // Owner setting: force the reply language instead of mirroring the input.
    // Applied in the SYSTEM contract so it replaces (not fights) the mirror rule.
    const replyLang = b.replyLang === 'en' || b.replyLang === 'ar' ? b.replyLang : null;

    // ---- Agent SDK engine: the persistent parent SIRA session owns the
    // conversation, the execution loop, subagents, and the final synthesis.
    // The legacy contract path below remains the honest fallback (mock mode /
    // no real Claude auth).
    if (sira) {
      await runSiraTurn({
        db, cfg, res, sira, conversationId, text: b.text, modality, replyLang, voiceSession,
        lang: b.lang ?? '', delegate: b.delegate !== false,
      });
      return;
    }

    // System prompt: core truth/communication rules + converse contract.
    let coreText = '';
    try {
      coreText = getActiveCoreBundle(db).text;
    } catch { /* pre-seed: converse still works with the bare contract */ }
    const system = `${coreText}\n\n${converseContract(replyLang)}`;

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

    // Cancellation: the client tearing down the stream aborts the model call.
    // Nothing is persisted as an assistant turn and no route executes — the
    // client re-syncs from GET /api/conversations/:id and sees only the user
    // turn (honest; there is no half-answer on record). res 'close' before
    // writableEnded is the premature-disconnect signal.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);

    // Streaming path: delta events carry newly-stable decoded say text as it
    // is generated; say events carry sentence-safe segments for TTS
    // pipelining. Non-streaming adapters keep the buffered behavior.
    const extractor = new SayStreamExtractor();
    const sentences = new SentenceBuffer();
    let streamed = false;
    let text: string;
    try {
      let result;
      if (adapter.completeStream) {
        streamed = true;
        result = await adapter.completeStream(
          { system, messages, purpose: 'converse', model: converseModel(cfg) },
          {
            signal: abort.signal,
            onDelta: (delta) => {
              const stable = extractor.push(delta);
              if (!stable) return;
              sse(res, 'delta', { text: stable });
              for (const segment of sentences.push(stable)) sse(res, 'say', { text: segment });
            },
          },
        );
        const tail = extractor.finish();
        if (tail) {
          sse(res, 'delta', { text: tail });
          for (const segment of sentences.push(tail)) sse(res, 'say', { text: segment });
        }
      } else {
        result = await adapter.complete({ system, messages, purpose: 'converse', model: converseModel(cfg) });
      }
      text = result.text;
      db.run(
        `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, 'converse', ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
        requestId, adapter.name, result.model, system.length + messages.reduce((n, m) => n + m.content.length, 0),
        text.slice(0, 50000), result.usage.input, result.usage.output, Date.now() - started, Date.now(),
      );
    } catch (err) {
      const aborted = err instanceof AdapterError && err.aborted;
      const detail = aborted ? 'aborted by client' : err instanceof Error ? err.message : String(err);
      db.run(
        `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, error, duration_ms, created_at)
         VALUES (?, 'converse', ?, '', 0, '', 'adapter_error', ?, ?, ?)`,
        requestId, adapter.name, detail.slice(0, 1000), Date.now() - started, Date.now(),
      );
      if (voiceSession) recordTransition(db, voiceSession, aborted ? 'ready' : 'failed', 'server');
      if (!aborted) {
        // A safety-classifier decline is not an outage — label it honestly so
        // the client can phrase it correctly.
        const code = err instanceof AdapterError && err.kind === 'refusal' ? 'refusal' : 'unavailable';
        sse(res, 'error', { code, message: code === 'refusal' ? 'model declined' : 'model unavailable', reference: requestId, detail: detail.slice(0, 200) });
        sse(res, 'done', {});
      }
      res.end();
      return;
    } finally {
      res.off('close', onClose);
    }

    // Parse the converse contract; unparseable output degrades to a plain reply.
    let route = 'reply';
    let say = text.trim();
    let routePayload: Record<string, unknown> = {};
    let contractOk = false;
    const extracted = extractFirstJsonObject(text);
    if (extracted.ok) {
      const obj = extracted.value as Record<string, unknown>;
      if (typeof obj.say === 'string' && typeof obj.route === 'string') {
        route = obj.route;
        say = obj.say;
        routePayload = obj;
        contractOk = true;
      }
    }
    if (!contractOk) {
      // Record the contract failure honestly (the row was inserted as 'ok'
      // before parsing), and prefer the decoded say value the extractor
      // already streamed over echoing a raw JSON blob into the transcript.
      db.run(`UPDATE model_requests SET parse_status = 'parse_error', error = ? WHERE id = ?`,
        `converse contract violated: ${extracted.ok ? 'object lacks route/say strings' : extracted.error}`.slice(0, 500), requestId);
      if (streamed && !extractor.rawMode && extractor.emitted.trim()) say = extractor.emitted.trim();
    }

    // Execute the route against real records. sayReplaced is set ONLY when a
    // route outcome overwrites the model's say post-hoc — it is the sole
    // trigger for re-speaking (a text mismatch between streamed and parsed
    // say must never re-emit, or the owner hears the reply twice).
    let sayReplaced = false;
    const correctedLang = replyLang ?? (/[؀-ۿ]/.test(b.text) ? 'ar' : 'en');
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
      } else if (route === 'confirm_plan' || route === 'reject_plan') {
        // The voice path to actually starting execution: without this route
        // a proposed plan could only be confirmed by tapping the UI card.
        const proposed = db.all<{ id: string }>(`SELECT id FROM plans WHERE status = 'proposed' ORDER BY created_at DESC`);
        let planId = String(routePayload.plan_id ?? '');
        if (!proposed.some((p) => p.id === planId)) planId = proposed.length === 1 ? proposed[0].id : '';
        if (!planId) {
          routeResult = { error: 'no matching proposed plan' };
          say = correctedLang === 'ar'
            ? 'لم أجد خطة معلّقة مطابقة بانتظار موافقتك.'
            : 'I could not find a matching plan awaiting your confirmation.';
          sayReplaced = true;
        } else if (route === 'confirm_plan') {
          // No voice-session transition here: connecting_agents is a DERIVED
          // client state driven by the real plan.confirmed/task.created
          // events this call just emitted.
          const confirmed = confirmPlan(db, planId, 'owner', modality === 'voice' ? 'voice' : 'api');
          routeResult = { planId, taskIds: confirmed.taskIds };
        } else {
          rejectPlan(db, planId, 'owner', String(routePayload.reason ?? 'rejected by owner (voice)'));
          routeResult = { planId, rejected: true };
        }
      } else if (route === 'approve') {
        const approvalId = String(routePayload.approval_id ?? '');
        // The decision must be EXPLICIT: defaulting anything unexpected to
        // 'approved' would let model slop authorize real actions.
        const decision = routePayload.decision === 'rejected' ? 'rejected'
          : routePayload.decision === 'approved' ? 'approved' : null;
        const approval = db.get<{ id: string; status: string; execution_id: string | null; task_id: string | null; summary: string }>(
          'SELECT id, status, execution_id, task_id, summary FROM approvals WHERE id = ?', approvalId,
        );
        if (!decision) {
          routeResult = { error: 'decision must be exactly "approved" or "rejected"' };
          say = correctedLang === 'ar'
            ? 'لم أفهم القرار — قل وافق أو ارفض بوضوح.'
            : 'I did not catch the decision — say approve or reject explicitly.';
          sayReplaced = true;
        } else if (approval && approval.status === 'pending') {
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
          // Models often say "approve" for a proposed PLAN. Fall through to
          // the plan ONLY when the intent is genuinely unambiguous: zero
          // pending tool approvals (nothing else the owner could mean) and
          // exactly one plan awaiting confirmation — and say what actually
          // happened, since the model's line described a tool approval.
          const pendingApprovals = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)?.n ?? 0;
          const proposed = db.all<{ id: string; objective_id: string }>(`SELECT id, objective_id FROM plans WHERE status = 'proposed'`);
          if (pendingApprovals === 0 && proposed.length === 1) {
            const objTitle = db.get<{ title: string }>('SELECT title FROM objectives WHERE id = ?', proposed[0].objective_id)?.title ?? '';
            if (decision === 'approved') {
              const confirmed = confirmPlan(db, proposed[0].id, 'owner', modality === 'voice' ? 'voice' : 'api');
              routeResult = { planId: proposed[0].id, taskIds: confirmed.taskIds, viaApproveFallback: true };
              say = correctedLang === 'ar'
                ? `اعتمدتُ الخطة وبدأ الفريق العمل على: ${objTitle}`
                : `Plan confirmed — the team is starting on: ${objTitle}`;
            } else {
              rejectPlan(db, proposed[0].id, 'owner', 'rejected by owner (voice)');
              routeResult = { planId: proposed[0].id, rejected: true, viaApproveFallback: true };
              say = correctedLang === 'ar'
                ? `رفضتُ الخطة المقترحة لهدف: ${objTitle}`
                : `Rejected the proposed plan for: ${objTitle}`;
            }
            sayReplaced = true;
          } else {
            routeResult = { error: 'approval not found or not pending' };
            say = correctedLang === 'ar'
              ? 'لم أجد طلب موافقة معلّقًا بهذا الوصف.'
              : 'I could not find that pending approval.';
            sayReplaced = true;
          }
        }
      } else if (route === 'cancel_task') {
        const taskId = String(routePayload.task_id ?? '');
        const task = db.get<{ id: string; status: TaskStatus; agent_key: string; objective_id: string }>(
          'SELECT id, status, agent_key, objective_id FROM tasks WHERE id = ?', taskId);
        if (task) {
          try {
            assertTransitionTask(task.status, 'cancelled');
            // Conditional on the validated status: the worker can commit a
            // different terminal state between our read and this write.
            const didCancel = db.transaction(() => {
              const changed = db.run(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = ?`, Date.now(), task.id, task.status);
              if (Number(changed.changes) === 0) return false;
              emitEvent(db, {
                type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
                payload: { from: task.status, to: 'cancelled', source: modality === 'voice' ? 'owner_voice' : 'owner' },
              });
              audit(db, cfg.orgId, 'owner', 'task.cancel', 'task', task.id, { via: modality });
              return true;
            });
            if (didCancel) {
              // Dependents can never run and the objective may now be terminal.
              cascadeDependencyFailure(db, cfg, task.id);
              maybeCompleteObjective(db, cfg, task.objective_id);
              routeResult = { taskId, cancelled: true };
            } else {
              routeResult = { error: 'task changed state concurrently; not cancelled' };
            }
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
    if (!streamed || extractor.emitted.trim() === '') {
      // Non-streaming adapter, or the stream never surfaced a say value.
      for (const segment of sentenceSegments(say)) sse(res, 'say', { text: segment });
    } else {
      const rest = sentences.flush();
      if (rest) sse(res, 'say', { text: rest });
      if (sayReplaced) {
        // Route execution replaced the reply post-hoc (e.g. approval not
        // found): speak the corrected line; done.say stays authoritative for
        // the displayed text. This is the ONLY re-speak trigger — a mere
        // difference between streamed and parsed text must never re-emit
        // (that was the "same greeting spoken twice" bug).
        for (const segment of sentenceSegments(say)) sse(res, 'say', { text: segment });
      }
    }
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

/**
 * One owner turn through the persistent Agent SDK session. Keeps the exact
 * SSE surface the client already speaks (state -> delta* -> say* -> route ->
 * done), so voice and text flow unchanged while the engine underneath is the
 * real Claude Code loop. The final `done.say` is ALWAYS the parent session's
 * own conversational synthesis — never a task-status string; execution
 * progress reaches the interface as persisted sira.* events instead.
 */
async function runSiraTurn(deps: {
  db: Db;
  cfg: ReturnType<typeof loadSystemConfig>;
  res: ServerResponse;
  sira: SiraManager;
  conversationId: string;
  text: string;
  modality: 'voice' | 'text';
  replyLang: 'en' | 'ar' | null;
  voiceSession: string | null;
  lang: string;
  delegate: boolean;
}): Promise<void> {
  const { db, cfg, res, sira, conversationId, text, modality, replyLang, voiceSession } = deps;
  if (voiceSession) recordTransition(db, voiceSession, 'thinking', 'server');
  sse(res, 'state', { state: 'thinking' });

  const session = sira.getOrCreate(conversationId, replyLang);
  // Runtime toggle: the canUseTool gate reads this flag on every Task call.
  session.delegationEnabled = deps.delegate;
  const speakable = new SpeakableStream();
  const sentences = new SentenceBuffer();
  const requestId = ulid('mr');
  const started = Date.now();

  let interrupted = false;
  const onClose = (): void => {
    if (!res.writableEnded) {
      // Barge-in/disconnect: stop THIS turn only — the session survives for
      // the next turn (and any background subagents keep running).
      interrupted = true;
      void session.interrupt();
    }
  };
  res.on('close', onClose);

  const settingLines = [
    replyLang ? `[Owner setting: reply only in ${replyLang === 'en' ? 'English' : 'Arabic'}.]` : '',
    deps.delegate ? '' : '[Owner setting: subagent delegation is OFF — do the work yourself; the Task tool will be denied.]',
  ].filter(Boolean);
  const turnText = settingLines.length ? `${text}\n\n${settingLines.join('\n')}` : text;

  const emitSpeakable = (chunk: string): void => {
    for (const segment of sentences.push(chunk)) {
      const spoken = speakableSentence(segment);
      if (spoken) sse(res, 'say', { text: spoken });
    }
  };

  let finalText = '';
  let usage = { input: 0, output: 0 };
  let errorMessage: string | null = null;
  try {
    for await (const event of session.send(turnText)) {
      if (event.kind === 'delta') {
        sse(res, 'delta', { text: event.text });
        emitSpeakable(speakable.push(event.text));
      } else if (event.kind === 'activity') {
        // Live execution hint for this stream; the durable record is the
        // persisted sira.* event on /api/events.
        sse(res, 'exec', { type: event.type, agentKey: event.agentKey ?? null, tool: event.tool ?? null });
      } else if (event.kind === 'final') {
        finalText = event.text;
        usage = event.usage;
      } else {
        errorMessage = event.message;
      }
    }
  } finally {
    res.off('close', onClose);
  }

  if (interrupted) {
    db.run(
      `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, error, duration_ms, created_at)
       VALUES (?, 'converse', 'agent-sdk', ?, ?, '', 'adapter_error', 'aborted by client', ?, ?)`,
      requestId, session.model, text.length, Date.now() - started, Date.now(),
    );
    if (voiceSession) recordTransition(db, voiceSession, 'ready', 'server');
    res.end();
    return;
  }

  if (errorMessage !== null && finalText === '') {
    db.run(
      `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, error, duration_ms, created_at)
       VALUES (?, 'converse', 'agent-sdk', ?, ?, '', 'adapter_error', ?, ?, ?)`,
      requestId, session.model, text.length, errorMessage.slice(0, 1000), Date.now() - started, Date.now(),
    );
    if (voiceSession) recordTransition(db, voiceSession, 'failed', 'server');
    sse(res, 'error', { code: 'unavailable', message: 'SIRA could not complete this turn', reference: requestId, detail: errorMessage.slice(0, 200) });
    sse(res, 'done', {});
    res.end();
    return;
  }

  // Flush the speakable remainder of the stream.
  emitSpeakable(speakable.flush());
  const rest = sentences.flush();
  if (rest) {
    const spoken = speakableSentence(rest);
    if (spoken) sse(res, 'say', { text: spoken });
  }

  db.run(
    `INSERT INTO model_requests (id, purpose, adapter, model, prompt_chars, response_text, parse_status, input_tokens, output_tokens, duration_ms, created_at)
     VALUES (?, 'converse', 'agent-sdk', ?, ?, ?, 'ok', ?, ?, ?, ?)`,
    requestId, session.model, text.length, finalText.slice(0, 50000), usage.input, usage.output, Date.now() - started, Date.now(),
  );
  const assistantMessageId = ulid('msg');
  db.run(
    `INSERT INTO messages (id, conversation_id, role, modality, lang, content, route, model_request_id, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'reply', ?, ?)`,
    assistantMessageId, conversationId, modality, deps.lang, finalText, requestId, Date.now(),
  );
  db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now(), conversationId);

  sse(res, 'route', { route: 'reply', engine: 'agent-sdk', sdkSessionId: session.sdkSessionId });
  if (voiceSession) recordTransition(db, voiceSession, 'ready', 'server');
  sse(res, 'done', { assistantMessageId, say: finalText });
  res.end();
}
