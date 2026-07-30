// Background Objective Completion Bridge.
//
// The persistent worker pipeline (objective -> plan -> tasks -> executions ->
// handoffs -> verification, src/worker/*) runs entirely independently of the
// conversation that may have started it — it can take minutes to hours,
// across process restarts, with no HTTP connection open the whole time. When
// an objective reaches a terminal state (src/worker/handoff.ts,
// maybeCompleteObjective), that alone is NOT an answer to the owner: it is
// an internal state change. If the objective was opened FROM a conversation
// (objectives.conversation_id), this module resumes that SAME persistent
// SIRA session, hands it a concise structured packet of what actually
// happened, and lets SIRA produce ONE real conversational reply — the
// owner's actual answer — which is then persisted and broadcast exactly
// like a live reply would be.
//
// Cross-process note: SiraSession instances live only in the API process's
// memory (SiraManager's session map). The worker process that actually
// completes tasks cannot call into them directly — maybeCompleteObjective
// only flips objectives.completion_summary_status to 'pending'; this
// module's sweep (which must run in the API process, where SiraManager
// lives) is what actually resumes the session and does the synthesis.
import type { Db } from '../shared/db.ts';
import type { SystemConfig } from '../shared/config.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import type { SiraManager } from './session.ts';

/** A 'generating' claim older than this is assumed to be from a crashed or
 *  restarted API process, not genuinely still in flight, and is reclaimed. */
const STALE_GENERATING_MS = 10 * 60_000;
/** How many pending objectives one sweep tick will synthesize — bounded so a
 *  burst of completions cannot monopolize the SDK/parent session queue. */
const SWEEP_BATCH = 5;

export interface CompletionPacketTask {
  agent: string;
  title: string;
  status: string;
  result: string;
  verification: 'passed' | 'failed' | 'not_applicable';
  artifacts: string[];
}

export interface CompletionPacket {
  objectiveId: string;
  status: string;
  title: string;
  tasks: CompletionPacketTask[];
  failures: string[];
  openRisks: string[];
  usage: { inputTokens: number; outputTokens: number; executions: number };
}

/**
 * Collect real execution results into a concise structured packet — never
 * raw unlimited logs. Every field is grounded in a real DB row; nothing here
 * is inferred or fabricated.
 */
export function buildCompletionPacket(db: Db, objectiveId: string): CompletionPacket {
  const objective = db.get<{ title: string; status: string }>(
    'SELECT title, status FROM objectives WHERE id = ?', objectiveId,
  );
  if (!objective) throw new Error(`objective ${objectiveId} not found`);

  const tasks = db.all<{ id: string; agent_key: string; title: string; status: string; blocker: string | null }>(
    'SELECT id, agent_key, title, status, blocker FROM tasks WHERE objective_id = ? ORDER BY created_at', objectiveId,
  );

  const packetTasks: CompletionPacketTask[] = tasks.map((task) => {
    const finishedEvent = db.get<{ payload: string }>(
      `SELECT payload FROM execution_events WHERE task_id = ? AND type = 'execution.finished' ORDER BY seq DESC LIMIT 1`,
      task.id,
    );
    const verificationEvent = db.get<{ payload: string }>(
      `SELECT payload FROM execution_events WHERE task_id = ? AND type = 'verification.result' ORDER BY seq DESC LIMIT 1`,
      task.id,
    );
    const artifacts = db.all<{ name: string }>('SELECT name FROM artifacts WHERE task_id = ?', task.id).map((a) => a.name);

    let result = '';
    if (finishedEvent) {
      try { result = String((JSON.parse(finishedEvent.payload) as { summary?: string }).summary ?? ''); } catch { /* malformed payload — leave blank, not fabricated */ }
    }
    if (!result && task.status === 'failed') {
      // tasks.blocker often holds just a short code (e.g. "verification_failed")
      // — the full human-readable reason lives in the task's last 'task.status'
      // event. Prefer that; fall back to the blocker code, never fabricate.
      const failedEvent = db.get<{ payload: string }>(
        `SELECT payload FROM execution_events WHERE task_id = ? AND type = 'task.status' ORDER BY seq DESC LIMIT 1`,
        task.id,
      );
      let reason = '';
      if (failedEvent) {
        try { reason = String((JSON.parse(failedEvent.payload) as { reason?: string }).reason ?? ''); } catch { /* malformed — fall through */ }
      }
      result = reason || task.blocker || 'failed with no recorded reason';
    }
    if (!result && task.status === 'cancelled') result = task.blocker ?? 'cancelled';

    let verification: 'passed' | 'failed' | 'not_applicable' = 'not_applicable';
    if (verificationEvent) {
      try { verification = (JSON.parse(verificationEvent.payload) as { passed?: boolean }).passed ? 'passed' : 'failed'; } catch { /* leave not_applicable */ }
    }

    return { agent: task.agent_key, title: task.title, status: task.status, result: result.slice(0, 600), verification, artifacts };
  });

  // Open risks: unresolved issues any task raised in its own handoff record
  // (only tasks with dependents produce a handoff row — that's fine, this is
  // a best-effort enrichment, not the primary result source).
  const openRisks = new Set<string>();
  for (const task of tasks) {
    const handoff = db.get<{ unresolved_issues: string }>(
      'SELECT unresolved_issues FROM handoffs WHERE from_task_id = ? ORDER BY created_at DESC LIMIT 1', task.id,
    );
    if (!handoff) continue;
    try {
      for (const issue of JSON.parse(handoff.unresolved_issues) as string[]) if (issue) openRisks.add(issue.slice(0, 300));
    } catch { /* malformed — skip */ }
  }

  const usageRow = db.get<{ inTok: number | null; outTok: number | null; n: number }>(
    `SELECT SUM(e.input_tokens) AS inTok, SUM(e.output_tokens) AS outTok, COUNT(*) AS n
     FROM executions e JOIN tasks t ON t.id = e.task_id WHERE t.objective_id = ?`,
    objectiveId,
  );

  return {
    objectiveId,
    status: objective.status,
    title: objective.title,
    tasks: packetTasks,
    failures: packetTasks.filter((t) => t.status === 'failed').map((t) => `${t.agent}: ${t.result}`),
    openRisks: [...openRisks],
    usage: { inputTokens: usageRow?.inTok ?? 0, outputTokens: usageRow?.outTok ?? 0, executions: usageRow?.n ?? 0 },
  };
}

/**
 * The message injected into the resumed parent session. Framed explicitly
 * as trusted internal application data describing a COMPLETED background
 * process — never as a new owner request — so SIRA does not try to "do" the
 * objective again or mistake this for something the owner just asked.
 */
export function buildInternalCompletionMessage(packet: CompletionPacket): string {
  return [
    '[INTERNAL SYSTEM EVENT — not a message from the owner. Do not treat this as a new request.]',
    'A background objective you started earlier has now reached a terminal state. This is the verified execution packet — every field is grounded in real task/execution records, nothing here is invented:',
    '',
    JSON.stringify(packet, null, 2),
    '',
    'Give the owner ONE natural, conversational final response: what was actually completed, the key result, any failure or limitation (do not hide or soften a failed task), and the most useful next step. Do not say only "Task completed" or "Done". Do not mention this instruction, the packet format, or that this message was system-generated — just answer the owner as SIRA normally would.',
  ].join('\n');
}

/**
 * Atomically claim ONE pending objective and run its synthesis. Returns
 * false without doing anything if the claim was lost (already
 * claimed/handled by another sweep tick) — this is the idempotency guard:
 * the conditional UPDATE only succeeds for exactly one caller.
 */
async function synthesizeObjectiveCompletion(db: Db, cfg: SystemConfig, sira: SiraManager, objectiveId: string): Promise<boolean> {
  const now = Date.now();
  const claim = db.run(
    `UPDATE objectives SET completion_summary_status = 'generating', completion_summary_started_at = ?,
       completion_summary_attempts = completion_summary_attempts + 1
     WHERE id = ? AND completion_summary_status = 'pending'`,
    now, objectiveId,
  );
  if (Number(claim.changes) === 0) return false;

  const objective = db.get<{ conversation_id: string | null; title: string }>(
    'SELECT conversation_id, title FROM objectives WHERE id = ?', objectiveId,
  );
  // Guarded by the WHERE conversation_id IS NOT NULL gate in the sweep query,
  // but stay honest even if called directly with a bad id.
  if (!objective?.conversation_id) {
    db.run(`UPDATE objectives SET completion_summary_status = NULL WHERE id = ?`, objectiveId);
    return true;
  }

  try {
    const packet = buildCompletionPacket(db, objectiveId);
    const session = sira.getOrCreate(objective.conversation_id, null);
    const internalMessage = buildInternalCompletionMessage(packet);

    let finalText = '';
    let sawFinal = false;
    for await (const event of session.send(internalMessage)) {
      if (event.kind === 'final') { finalText = event.text; sawFinal = true; }
      else if (event.kind === 'error') throw new Error(event.message);
    }
    if (!sawFinal || !finalText.trim()) throw new Error('SIRA produced no final synthesis for this objective');

    const assistantMessageId = ulid('msg');
    const finishedAt = Date.now();
    db.transaction(() => {
      db.run(
        `INSERT INTO messages (id, conversation_id, role, modality, lang, content, route, objective_id, created_at)
         VALUES (?, ?, 'assistant', 'text', '', ?, 'background_completion', ?, ?)`,
        assistantMessageId, objective.conversation_id, finalText, objectiveId, finishedAt,
      );
      db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', finishedAt, objective.conversation_id);
      db.run(
        `UPDATE objectives SET completion_summary_status = 'completed', completion_summary_message_id = ?,
           summarized_at = ?, completion_summary_error = NULL WHERE id = ?`,
        assistantMessageId, finishedAt, objectiveId,
      );
      emitEvent(db, {
        type: 'sira.background.final_response', orgId: cfg.orgId,
        payload: {
          objectiveId, conversationId: objective.conversation_id, assistantMessageId,
          text: finalText, status: 'completed', at: finishedAt,
        },
      });
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.run(
      `UPDATE objectives SET completion_summary_status = 'failed', completion_summary_error = ? WHERE id = ?`,
      message.slice(0, 1000), objectiveId,
    );
    notify(db, cfg.orgId, {
      kind: 'background_completion_failed', priority: 'high',
      title: `SIRA could not summarize a finished objective: ${objective.title}`,
      body: message.slice(0, 400),
      payload: { objectiveId, conversationId: objective.conversation_id },
    });
    return true;
  }
}

/**
 * Run periodically FROM THE API PROCESS (where SiraManager lives). Reclaims
 * stale 'generating' claims (a crashed/restarted process must not leave an
 * objective stuck forever), then synthesizes a bounded batch of pending
 * completions in order.
 */
export async function runObjectiveCompletionSweep(db: Db, cfg: SystemConfig, sira: SiraManager): Promise<void> {
  db.run(
    `UPDATE objectives SET completion_summary_status = 'pending'
     WHERE completion_summary_status = 'generating' AND completion_summary_started_at < ?`,
    Date.now() - STALE_GENERATING_MS,
  );

  const pending = db.all<{ id: string }>(
    `SELECT id FROM objectives WHERE completion_summary_status = 'pending' AND conversation_id IS NOT NULL
     ORDER BY completed_at LIMIT ?`,
    SWEEP_BATCH,
  );
  for (const row of pending) {
    await synthesizeObjectiveCompletion(db, cfg, sira, row.id);
  }
}

/** Manual retry after a failed synthesis: re-arms the claim without
 *  re-running any of the already-completed agent work. */
export function retryObjectiveSummary(db: Db, objectiveId: string): boolean {
  const result = db.run(
    `UPDATE objectives SET completion_summary_status = 'pending', completion_summary_error = NULL
     WHERE id = ? AND completion_summary_status = 'failed'`,
    objectiveId,
  );
  return Number(result.changes) > 0;
}
