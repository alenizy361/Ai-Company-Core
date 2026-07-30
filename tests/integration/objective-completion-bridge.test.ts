// Background Objective Completion Bridge: a background objective opened FROM
// a conversation must return its real result to that SAME persistent SIRA
// session — not stop at a generic "Objective completed" notification. These
// tests drive tasks through the REAL worker pipeline (claimNextTask,
// runExecution, maybeCompleteObjective) to a genuine terminal state, then
// exercise the bridge itself against a stub SiraManager (no real Claude
// Agent SDK call in tests — the contract under test is the bridge's own
// packet-building, resume, persistence, idempotency, and failure handling).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv, activateAgents, createConfirmedPlan, MOCK, completeTurn, failTurn } from '../helpers/fixtures.ts';
import { claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { maybeCompleteObjective } from '../../src/worker/handoff.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import {
  buildCompletionPacket, runObjectiveCompletionSweep, retryObjectiveSummary,
} from '../../src/sira/objective-bridge.ts';
import type { SiraManager, SiraSession } from '../../src/sira/session.ts';
import type { TurnEvent } from '../../src/sira/router.ts';

const SPEC_PAD = 'A complete executable specification with enough detail to satisfy the plan validator minimum.';

/** Records exactly what text the bridge sent for resume, and answers with a
 * scripted final result — the bridge's only real dependency on the SDK.
 * isFailed mirrors the REAL SiraSession's meaning: true only for a session
 * that is itself dead (a crashed pump loop / dead resume), NOT for an
 * ordinary turn-level {kind:'error'} event — those are ordinary turn
 * outcomes a healthy session can still produce (e.g. hit its turn cap). */
class StubSiraSession {
  sentTexts: string[] = [];
  script: { text?: string; errorMessage?: string; isFailed?: boolean };
  constructor(script: { text?: string; errorMessage?: string; isFailed?: boolean }) {
    this.script = script;
  }
  get isFailed(): boolean {
    return this.script.isFailed ?? false;
  }
  async *send(text: string): AsyncGenerator<TurnEvent> {
    this.sentTexts.push(text);
    if (this.script.errorMessage) {
      yield { kind: 'error', message: this.script.errorMessage };
      return;
    }
    yield { kind: 'final', text: this.script.text ?? '', usage: { input: 10, output: 20 }, costUsd: 0, numTurns: 1 };
  }
}
class StubSiraManager {
  calls: { conversationId: string; replyLang: 'en' | 'ar' | null }[] = [];
  sessions = new Map<string, StubSiraSession>();
  script: { text?: string; errorMessage?: string; isFailed?: boolean };
  constructor(script: { text?: string; errorMessage?: string; isFailed?: boolean }) {
    this.script = script;
  }
  getOrCreate(conversationId: string, replyLang: 'en' | 'ar' | null): SiraSession {
    this.calls.push({ conversationId, replyLang });
    let s = this.sessions.get(conversationId);
    if (!s) { s = new StubSiraSession(this.script); this.sessions.set(conversationId, s); }
    return s as unknown as SiraSession;
  }
}

function makeConversation(env: ReturnType<typeof makeEnv>): string {
  const id = 'cnv_test_bridge';
  const now = Date.now();
  env.db.run(
    `INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, 'test', ?, ?)`,
    id, env.cfg.orgId, now, now,
  );
  return id;
}

async function runTaskToCompletion(env: ReturnType<typeof makeEnv>, expectStatus: 'completed' | 'failed' = 'completed'): Promise<void> {
  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.ok(task, 'a task was claimable');
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.equal(outcome, expectStatus);
}

test('completion bridge: real terminal objective is picked up, packet is grounded in real rows, SIRA resumes and answers', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['pm', 'ux']);
  const conversationId = makeConversation(env);

  const { objectiveId, taskIds } = createConfirmedPlan(env, 'three improvements', [
    { step_id: 's1', agent: 'pm', spec: `${SPEC_PAD} ${MOCK([completeTurn('Proposed three improvements: A, B, C.')])}`, expected_artifacts: [] },
    { step_id: 's2', agent: 'ux', depends_on: ['s1'], spec: `${SPEC_PAD} ${MOCK([completeTurn('Reviewed A, B, C — B is strongest.')])}`, expected_artifacts: [] },
  ], conversationId);

  await runTaskToCompletion(env); // s1
  await runTaskToCompletion(env); // s2 (depends on s1, now unblocked)

  const objectiveRow = env.db.get<{ status: string; completion_summary_status: string | null; completed_at: number | null }>(
    'SELECT status, completion_summary_status, completed_at FROM objectives WHERE id = ?', objectiveId,
  );
  assert.equal(objectiveRow?.status, 'completed', 'objective reached a real terminal state via the real worker pipeline');
  assert.equal(objectiveRow?.completion_summary_status, 'pending', 'maybeCompleteObjective armed the bridge (conversation_id was set)');
  assert.ok(objectiveRow?.completed_at, 'completed_at recorded');

  // objective.finished carries conversationId so the frontend can suppress
  // the generic line in favor of the real bridged answer.
  const finishedEvent = env.db.get<{ payload: string }>(
    `SELECT payload FROM execution_events WHERE type = 'objective.finished' AND task_id IS NULL ORDER BY seq DESC LIMIT 1`,
  );
  assert.match(finishedEvent!.payload, new RegExp(conversationId));

  // Packet is grounded in real execution_events/verification/artifacts rows.
  const packet = buildCompletionPacket(env.db, objectiveId);
  assert.equal(packet.tasks.length, 2);
  assert.equal(packet.tasks[0].agent, 'pm');
  assert.match(packet.tasks[0].result, /Proposed three improvements/);
  assert.equal(packet.tasks[0].verification, 'passed');
  assert.equal(packet.tasks[1].agent, 'ux');
  assert.match(packet.tasks[1].result, /B is strongest/);
  assert.equal(packet.failures.length, 0);
  assert.ok(packet.usage.executions >= 2);

  const stub = new StubSiraManager({ text: 'I asked Product and UX — option B is the strongest pick, here is why…' });
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);

  // The bridge resumed the SAME conversation, not a fresh one.
  assert.deepEqual(stub.calls, [{ conversationId, replyLang: null }]);
  const session = stub.sessions.get(conversationId)!;
  assert.equal(session.sentTexts.length, 1);
  assert.match(session.sentTexts[0], /INTERNAL SYSTEM EVENT/);
  assert.match(session.sentTexts[0], /not a message from the owner/);
  assert.match(session.sentTexts[0], /Proposed three improvements/, 'the real task result is in the packet SIRA sees');

  // Final answer persisted as a real assistant message in the original conversation.
  const finalObjective = env.db.get<{ completion_summary_status: string; completion_summary_message_id: string | null }>(
    'SELECT completion_summary_status, completion_summary_message_id FROM objectives WHERE id = ?', objectiveId,
  );
  assert.equal(finalObjective?.completion_summary_status, 'completed');
  assert.ok(finalObjective?.completion_summary_message_id);

  const message = env.db.get<{ role: string; content: string; route: string; conversation_id: string; objective_id: string }>(
    'SELECT role, content, route, conversation_id, objective_id FROM messages WHERE id = ?', finalObjective!.completion_summary_message_id,
  );
  assert.equal(message?.role, 'assistant');
  assert.equal(message?.route, 'background_completion');
  assert.equal(message?.conversation_id, conversationId);
  assert.equal(message?.objective_id, objectiveId);
  assert.match(message!.content, /option B is the strongest/);

  // Dedicated SSE-visible event with everything the frontend needs.
  const finalEvent = env.db.get<{ payload: string }>(
    `SELECT payload FROM execution_events WHERE type = 'sira.background.final_response' ORDER BY seq DESC LIMIT 1`,
  );
  assert.ok(finalEvent, 'sira.background.final_response emitted');
  const payload = JSON.parse(finalEvent!.payload) as Record<string, unknown>;
  assert.equal(payload.objectiveId, objectiveId);
  assert.equal(payload.conversationId, conversationId);
  assert.equal(payload.assistantMessageId, finalObjective!.completion_summary_message_id);
  assert.equal(payload.status, 'completed');
  assert.match(String(payload.text), /option B is the strongest/);

  // Idempotency: a second sweep tick must not re-synthesize or duplicate anything.
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);
  assert.equal(session.sentTexts.length, 1, 'no second resume');
  assert.equal(
    env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 1,
    'no duplicate assistant message',
  );
  assert.equal(taskIds.length, 2);
});

test('completion bridge: concurrent sweep ticks on the same objective never double-synthesize (atomic claim)', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  const { objectiveId } = createConfirmedPlan(env, 'race', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('done')])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env);
  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'pending');

  const stub = new StubSiraManager({ text: 'backend finished the task.' });
  await Promise.all([
    runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager),
    runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager),
  ]);

  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 1,
    'only ONE of the two concurrent ticks won the atomic claim');
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM execution_events WHERE type = 'sira.background.final_response'`)?.n, 1);
});

/** Fails its first N calls, then answers normally — for exercising automatic
 * retry-with-backoff without needing real wall-clock delays. */
class FlakySiraManager {
  calls = 0;
  failuresLeft: number;
  successText: string;
  constructor(failuresLeft: number, successText: string) {
    this.failuresLeft = failuresLeft;
    this.successText = successText;
  }
  getOrCreate(_conversationId: string, _replyLang: 'en' | 'ar' | null): SiraSession {
    this.calls += 1;
    const shouldFail = this.failuresLeft > 0;
    if (shouldFail) this.failuresLeft -= 1;
    const script = shouldFail ? { errorMessage: 'model runtime unavailable' } : { text: this.successText };
    return new StubSiraSession(script) as unknown as SiraSession;
  }
  recreate(conversationId: string, replyLang: 'en' | 'ar' | null): SiraSession {
    return this.getOrCreate(conversationId, replyLang);
  }
}

test('completion bridge: a transient synthesis failure auto-retries with backoff — never immediately permanent', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  const { objectiveId } = createConfirmedPlan(env, 'flaky synthesis', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('the real work, done and verified')])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env);

  const flaky = new FlakySiraManager(1, 'backend completed the real work, verified.');
  await runObjectiveCompletionSweep(env.db, env.cfg, flaky as unknown as SiraManager);

  const afterFailure = env.db.get<{ status: string; error: string | null; attempts: number; nextRetryAt: number | null }>(
    `SELECT completion_summary_status AS status, completion_summary_error AS error,
            completion_summary_attempts AS attempts, completion_summary_next_retry_at AS nextRetryAt
     FROM objectives WHERE id = ?`, objectiveId,
  );
  assert.equal(afterFailure?.status, 'pending', 'a single transient failure stays pending — not permanently failed');
  assert.match(afterFailure!.error!, /model runtime unavailable/, 'the real error is still recorded, even mid-retry');
  assert.equal(afterFailure?.attempts, 1);
  assert.ok(afterFailure!.nextRetryAt! > Date.now(), 'backoff delay is in the future');
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 0);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'background_completion_failed'`)?.n, 0,
    'no owner notification for a transient blip — that would be noise');
  // The underlying task result is untouched — this was a synthesis failure, not a work failure.
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM tasks WHERE objective_id = ?', objectiveId)?.status, 'completed');

  // Sweeping again before the backoff elapses must NOT retry yet.
  await runObjectiveCompletionSweep(env.db, env.cfg, flaky as unknown as SiraManager);
  assert.equal(flaky.calls, 1, 'backoff window respected — no premature retry');

  // Fast-forward past the backoff window (simulating real elapsed time) and sweep again.
  env.db.run(`UPDATE objectives SET completion_summary_next_retry_at = ? WHERE id = ?`, Date.now() - 1000, objectiveId);
  await runObjectiveCompletionSweep(env.db, env.cfg, flaky as unknown as SiraManager);

  const afterRetry = env.db.get<{ status: string; attempts: number }>(
    'SELECT completion_summary_status AS status, completion_summary_attempts AS attempts FROM objectives WHERE id = ?', objectiveId,
  );
  assert.equal(afterRetry?.status, 'completed', 'auto-retry succeeded — no manual intervention needed');
  assert.equal(afterRetry?.attempts, 2);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 1);
});

test('completion bridge: exhausting automatic attempts becomes a PERMANENT failure with a real owner notification, then manual retry still works', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  const { objectiveId } = createConfirmedPlan(env, 'persistently flaky synthesis', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('done')])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env);

  const alwaysFails = new FlakySiraManager(Number.MAX_SAFE_INTEGER, 'unreachable');
  for (let i = 0; i < 5; i++) {
    await runObjectiveCompletionSweep(env.db, env.cfg, alwaysFails as unknown as SiraManager);
    // Skip the real backoff wait between attempts — this test exhausts the
    // attempt budget, it isn't testing the timing itself (already covered above).
    env.db.run(`UPDATE objectives SET completion_summary_next_retry_at = ? WHERE id = ? AND completion_summary_status = 'pending'`, Date.now() - 1000, objectiveId);
  }

  const final = env.db.get<{ status: string; attempts: number }>(
    'SELECT completion_summary_status AS status, completion_summary_attempts AS attempts FROM objectives WHERE id = ?', objectiveId,
  );
  assert.equal(final?.status, 'failed', 'attempt budget exhausted — now permanent');
  assert.equal(final?.attempts, 5);
  assert.ok(env.db.get(`SELECT id FROM notifications WHERE kind = 'background_completion_failed'`), 'owner IS notified once it truly becomes permanent');

  // Sweeping again does nothing further — 'failed' is not 'pending'.
  const callsBefore = alwaysFails.calls;
  await runObjectiveCompletionSweep(env.db, env.cfg, alwaysFails as unknown as SiraManager);
  assert.equal(alwaysFails.calls, callsBefore, 'a permanently failed objective is never auto-retried again');

  // Manual retry (owner-initiated) still works and is idempotent.
  assert.equal(retryObjectiveSummary(env.db, objectiveId), true);
  const workingStub = new StubSiraManager({ text: 'backend finished, here is the result.' });
  await runObjectiveCompletionSweep(env.db, env.cfg, workingStub as unknown as SiraManager);
  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'completed');
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 1);
});

test('completion bridge: a dead SDK resume falls back to a fresh session with recovered context — the owner still gets an answer', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  env.db.run(
    `INSERT INTO messages (id, conversation_id, role, modality, lang, content, created_at) VALUES (?, ?, 'user', 'text', 'en', 'earlier owner question', ?)`,
    'msg_earlier', conversationId, Date.now() - 5000,
  );
  const { objectiveId } = createConfirmedPlan(env, 'resume is dead', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('done')])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env);

  class DeadResumeManager {
    recreateCalled = false;
    getOrCreate(): SiraSession {
      return new StubSiraSession({ errorMessage: 'session id not found (expired)', isFailed: true }) as unknown as SiraSession;
    }
    recreate(): SiraSession {
      this.recreateCalled = true;
      return new StubSiraSession({ text: 'Backend finished the task — here is what happened.' }) as unknown as SiraSession;
    }
  }
  const stub = new DeadResumeManager();
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);

  assert.equal(stub.recreateCalled, true, 'fell back to a fresh session instead of losing the result');
  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'completed');
  const message = env.db.get<{ content: string }>(`SELECT content FROM messages WHERE objective_id = ? AND role = 'assistant'`, objectiveId);
  assert.match(message!.content, /Backend finished the task/);
  assert.ok(env.db.get(`SELECT id FROM execution_events WHERE type = 'sira.session.fallback_recovered'`), 'the fallback is recorded, not silent');
});

test('completion bridge: a stale generating claim (crashed/restarted API process) is reclaimed, not stuck forever', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  const { objectiveId } = createConfirmedPlan(env, 'stale claim', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('finished')])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env);

  // Simulate a process that claimed the objective 20 minutes ago and then died.
  env.db.run(
    `UPDATE objectives SET completion_summary_status = 'generating', completion_summary_started_at = ? WHERE id = ?`,
    Date.now() - 20 * 60_000, objectiveId,
  );
  const stub = new StubSiraManager({ text: 'backend is done.' });
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);

  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'completed');
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 1);
});

test('maybeCompleteObjective: a duplicate finalization call (two workers, or worker+API racing) never re-arms an already-completed bridge', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  const { objectiveId } = createConfirmedPlan(env, 'duplicate finalize', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('done')])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env);
  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'pending');

  // Run the bridge to full completion first (this objective's real answer already exists).
  const stub = new StubSiraManager({ text: 'backend finished the work.' });
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);
  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'completed');

  const notificationsBefore = env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'objective_completed'`)?.n;
  const eventsBefore = env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM execution_events WHERE type = 'objective.finished'`)?.n;

  // A late/duplicate call to maybeCompleteObjective for the SAME objective
  // (e.g. a second worker process reaching the same conclusion) must be a
  // total no-op — not just for its own status field, but for re-arming the
  // bridge that already produced the owner's real answer.
  maybeCompleteObjective(env.db, env.cfg, objectiveId);

  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'completed',
    'still completed — NOT reset to pending');
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'objective_completed'`)?.n, notificationsBefore,
    'no duplicate notification');
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM execution_events WHERE type = 'objective.finished'`)?.n, eventsBefore,
    'no duplicate objective.finished event');

  // And running the sweep again still produces exactly one assistant message.
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE objective_id = ?`, objectiveId)?.n, 1);
});

test('completion bridge: objectives with no conversation (e.g. autopilot) are never armed and never touched by the sweep', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const { objectiveId } = createConfirmedPlan(env, 'autopilot cycle', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('done')])}`, expected_artifacts: [] },
  ]); // no conversationId
  await runTaskToCompletion(env);

  assert.equal(
    env.db.get<{ s: string | null }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, null,
    'not applicable — nothing to bridge back to',
  );
  const stub = new StubSiraManager({ text: 'should never be called' });
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);
  assert.equal(stub.calls.length, 0);
});

test('completion bridge: a failed task is reported honestly, not hidden — packet result comes from the real blocker', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const conversationId = makeConversation(env);
  const { objectiveId } = createConfirmedPlan(env, 'partial failure', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([failTurn('could not access the required system', ['blocked_hard'])])}`, expected_artifacts: [] },
  ], conversationId);
  await runTaskToCompletion(env, 'failed');

  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objectiveId)?.status, 'failed');
  assert.equal(env.db.get<{ s: string }>('SELECT completion_summary_status AS s FROM objectives WHERE id = ?', objectiveId)?.s, 'pending',
    'the bridge fires for a failed objective too — SIRA still owes the owner an honest answer');

  const packet = buildCompletionPacket(env.db, objectiveId);
  assert.equal(packet.tasks[0].status, 'failed');
  assert.match(packet.tasks[0].result, /could not access the required system/);
  assert.equal(packet.failures.length, 1);
  assert.match(packet.failures[0], /could not access the required system/);

  const stub = new StubSiraManager({ text: 'The task failed because backend could not access the required system — here is what I recommend next.' });
  await runObjectiveCompletionSweep(env.db, env.cfg, stub as unknown as SiraManager);
  assert.match(stub.sessions.get(conversationId)!.sentTexts[0], /could not access the required system/);
  const message = env.db.get<{ content: string }>(
    `SELECT content FROM messages WHERE objective_id = ? AND role = 'assistant'`, objectiveId,
  );
  assert.match(message!.content, /failed because backend could not access/);
});
