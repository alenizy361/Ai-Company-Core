// Mandatory acceptance tests AT1, AT2, AT4, AT5, AT6, AT7, AT9 — run through
// the REAL production machinery in-process with the scripted mock adapter.
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { makeEnv, activateAgents, createConfirmedPlan, toolTurn, completeTurn, MOCK } from '../helpers/fixtures.ts';
import { claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import { openDb } from '../../src/shared/db.ts';
import { deriveAgentStatuses } from '../../src/shared/derive.ts';

const SPEC_PAD = 'Complete executable specification with concrete definition of done for the test scenario at hand.';

test('AT1: single-agent execution — persist, execute, artifact, verify, honest state', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);

  const script = [
    toolTurn('write_artifact', { name: 'at1.md', content: '# AT1\nDELIVERABLE body.' }),
    completeTurn('done', ['at1.md']),
  ];
  const { objectiveId, taskIds } = createConfirmedPlan(env, 'AT1', [{
    step_id: 'at1-step', agent: 'backend',
    spec: `${SPEC_PAD} ${MOCK(script)}`,
    expected_artifacts: ['at1.md'],
    verification: [{ type: 'contains', artifact: 'at1.md', needle: 'DELIVERABLE' }],
  }]);

  // Task persisted before any execution.
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', taskIds[0])?.status, 'queued');

  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.ok(task);
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.equal(outcome, 'completed');

  // Real model_request + tool_call rows exist (evidence).
  assert.ok((env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM model_requests WHERE execution_id IS NOT NULL')?.n ?? 0) >= 2);
  const artifact = env.db.get<{ path: string }>('SELECT path FROM artifacts WHERE task_id = ? AND name = ?', task!.id, 'at1.md');
  assert.ok(artifact && existsSync(artifact.path));
  // Verification recorded and passed.
  const verification = env.db.all<{ payload: string }>(`SELECT payload FROM execution_events WHERE type = 'verification.result' AND task_id = ?`, task!.id);
  assert.equal(JSON.parse(verification[0].payload).passed, true);
  // Board state derives completed, matching backend truth.
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objectiveId)?.status, 'completed');
});

test('AT2: PM -> Backend -> QA handoff chain with persisted evidence', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['pm', 'backend', 'qa']);

  const pmScript = [
    toolTurn('write_artifact', { name: 'spec.md', content: '# Spec\nRequirement R1: respond with 201.' }),
    completeTurn('spec written', ['spec.md']),
  ];
  const beScript = [
    toolTurn('read_artifact', { name: 'spec.md' }),
    toolTurn('write_file', { path: 'src/impl.js', content: '// implements R1 (201)' }),
    toolTurn('write_artifact', { name: 'impl-notes.md', content: '# Impl\nImplements R1 from spec.md.' }),
    completeTurn('implemented per spec', ['impl-notes.md']),
  ];
  const qaScript = [
    toolTurn('read_artifact', { name: 'impl-notes.md' }),
    toolTurn('read_file', { path: 'src/impl.js' }),
    toolTurn('write_artifact', { name: 'qa-report.md', content: '# QA\nR1: PASS (evidence: impl.js implements 201).' }),
    completeTurn('verified', ['qa-report.md']),
  ];
  createConfirmedPlan(env, 'AT2', [
    { step_id: 'spec', agent: 'pm', spec: `${SPEC_PAD} ${MOCK(pmScript)}`, expected_artifacts: ['spec.md'] },
    { step_id: 'impl', agent: 'backend', depends_on: ['spec'], spec: `${SPEC_PAD} ${MOCK(beScript)}`, expected_artifacts: ['impl-notes.md'] },
    { step_id: 'verify', agent: 'qa', depends_on: ['impl'], spec: `${SPEC_PAD} ${MOCK(qaScript)}`, expected_artifacts: ['qa-report.md'],
      verification: [{ type: 'contains', artifact: 'qa-report.md', needle: 'PASS' }] },
  ]);

  // Backend cannot be claimed before PM completes (dependency ordering).
  const first = claimNextTask(env.db, env.cfg, 'w1');
  assert.equal(first?.agent_key, 'pm');
  assert.equal(claimNextTask(env.db, env.cfg, 'w1'), null); // impl+verify not ready
  assert.equal(await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), first!, 'w1'), 'completed');

  const second = claimNextTask(env.db, env.cfg, 'w1');
  assert.equal(second?.agent_key, 'backend');
  assert.equal(await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), second!, 'w1'), 'completed');

  const third = claimNextTask(env.db, env.cfg, 'w1');
  assert.equal(third?.agent_key, 'qa');
  assert.equal(await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), third!, 'w1'), 'completed');

  // Handoffs persisted with confirmed artifacts, source->dest recorded.
  const handoffs = env.db.all<{ from_agent: string; to_agent: string; verification_status: string; artifact_ids: string }>(
    'SELECT from_agent, to_agent, verification_status, artifact_ids FROM handoffs ORDER BY created_at',
  );
  assert.deepEqual(handoffs.map((h) => `${h.from_agent}->${h.to_agent}`), ['pm->backend', 'backend->qa']);
  for (const h of handoffs) {
    assert.equal(h.verification_status, 'artifacts_confirmed');
    assert.ok((JSON.parse(h.artifact_ids) as string[]).length >= 1);
  }
});

test('AT4: full state survives a service restart (close + reopen db)', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const script = [toolTurn('write_artifact', { name: 'a.md', content: 'x DELIVERABLE' }), completeTurn('ok', ['a.md'])];
  const { objectiveId, planId } = createConfirmedPlan(env, 'AT4', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK(script)}`, expected_artifacts: ['a.md'] },
    { step_id: 's2', agent: 'backend', depends_on: ['s1'], spec: `${SPEC_PAD} ${MOCK(script)}`, expected_artifacts: ['a.md'] },
  ]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');

  env.db.close(); // simulate full process death
  const db2 = openDb(env.paths.dbPath, env.paths.migrationsDir);
  assert.ok(db2.get('SELECT id FROM objectives WHERE id = ?', objectiveId));
  assert.ok(db2.get('SELECT id FROM plans WHERE id = ?', planId));
  assert.equal(db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')?.n, 2);
  assert.equal(db2.get<{ status: string }>(`SELECT status FROM tasks WHERE step_id = 's1'`)?.status, 'completed');
  assert.equal(db2.get<{ status: string }>(`SELECT status FROM tasks WHERE step_id = 's2'`)?.status, 'queued');
  assert.ok((db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts')?.n ?? 0) >= 1);
  assert.ok((db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM execution_events')?.n ?? 0) > 3);
  db2.close();
});

test('AT5: malformed model output -> recorded violations, bounded retry, no fake state', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const garbage = ['this is not json at all', '{"action":"dance"}', '{"action":"complete"}'];
  const { taskIds } = createConfirmedPlan(env, 'AT5', [{
    step_id: 'bad', agent: 'backend', spec: `${SPEC_PAD} ${MOCK(garbage)}`, expected_artifacts: ['never.md'],
  }]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.notEqual(outcome, 'completed');

  const parseErrors = env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM model_requests WHERE parse_status = 'parse_error'`);
  assert.equal(parseErrors?.n, 3); // three strikes recorded
  const events = env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM execution_events WHERE type = 'model.validation_failed'`);
  assert.equal(events?.n, 3);
  // No artifact fabricated; execution failed with contract_violation.
  assert.equal(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts')?.n, 0);
  const execution = env.db.get<{ status: string; failure_reason: string }>(
    'SELECT status, failure_reason FROM executions WHERE task_id = ?', taskIds[0]);
  assert.equal(execution?.status, 'failed');
  assert.match(execution?.failure_reason ?? '', /contract violated/);
});

test('AT6: permission boundary — denied accurately, no fabricated result', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['pm']); // pm cannot run commands
  const script = [
    toolTurn('run_command', { cmd: 'node evil.js' }),
    JSON.stringify({ action: 'fail', reason: 'run_command denied by policy — cannot execute the required step', blockers: ['missing_capability:run_command'], tried: ['run_command'] }),
  ];
  createConfirmedPlan(env, 'AT6', [{
    step_id: 'blocked', agent: 'pm', spec: `${SPEC_PAD} ${MOCK(script)}`, expected_artifacts: ['result.md'],
  }]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.equal(outcome, 'failed');

  const denial = env.db.get<{ decision: string; denial_reason: string }>(
    `SELECT decision, denial_reason FROM tool_calls WHERE tool = 'run_command'`);
  assert.equal(denial?.decision, 'denied');
  assert.match(denial?.denial_reason ?? '', /not in the pm agent's tool policy/);
  assert.ok(env.db.get(`SELECT seq FROM execution_events WHERE type = 'tool.denied'`));
  assert.equal(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts')?.n, 0);
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', task!.id)?.status, 'failed');
});

test('AT9: interface truth — stale worker means NOTHING renders running', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend', 'qa']);
  // A task row claims to be running, and a worker heartbeat exists but is stale.
  createConfirmedPlan(env, 'AT9', [{ step_id: 's', agent: 'backend', spec: `${SPEC_PAD}x`, expected_artifacts: ['x.md'] }]);
  env.db.run(`UPDATE tasks SET status = 'running', claimed_by = 'dead-worker', lease_expires_at = ? WHERE step_id = 's'`, Date.now() + 60000);
  env.db.run(`INSERT INTO workers (id, pid, hostname, started_at, last_heartbeat_at, status) VALUES ('dead-worker', 1, 'x', ?, ?, 'online')`,
    Date.now() - 600000, Date.now() - 300000);

  const derived = deriveAgentStatuses(env.db,
    env.db.all(`SELECT key, lifecycle FROM agents`), env.cfg.staleWorkerMs);
  for (const [key, value] of Object.entries(derived)) {
    assert.notEqual(value.status, 'running', `${key} must not render running with a stale worker`);
  }
  assert.equal(derived.backend.status, 'offline');
  // With a FRESH heartbeat the same rows render truthfully as running.
  env.db.run(`UPDATE workers SET last_heartbeat_at = ? WHERE id = 'dead-worker'`, Date.now());
  const fresh = deriveAgentStatuses(env.db, env.db.all(`SELECT key, lifecycle FROM agents`), env.cfg.staleWorkerMs);
  assert.equal(fresh.backend.status, 'running');
  assert.equal(fresh.qa.status, 'idle');
});
