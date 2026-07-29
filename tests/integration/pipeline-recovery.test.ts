// Root-cause regression suite for the pipeline bugs the owner hit in
// production: objectives deadlocked in 'planning', stranded dependents,
// claim-window orphans, silently-mock workers, placeholder "completed" tasks,
// and objectives that never finalize. Every test drives the REAL production
// code paths (no mocks of our own code).
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv, activateAgents, createConfirmedPlan, toolTurn, completeTurn, failTurn, MOCK } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerWriteRoutes } from '../../src/server/routes/writes.ts';
import { registerHealthRoute } from '../../src/server/routes/health.ts';
import type { SseHub } from '../../src/server/sse.ts';
import { createObjective, runPlanningForObjective } from '../../src/planning/plan-service.ts';
import { claimNextPlanningObjective, claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { sweepExpiredLeases } from '../../src/worker/recovery.ts';
import { verifyCompletion } from '../../src/worker/verify.ts';
import { activateBaselineAgentPrompts } from '../../src/promptreg/registry.ts';
import { storeArtifact } from '../../src/tools/impl/artifacts.ts';
import { loadPermissions } from '../../src/shared/config.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import { AdapterError, type CompletionRequest, type CompletionResult, type ModelAdapter } from '../../src/adapters/types.ts';

const SPEC_PAD = 'A complete executable specification with enough detail to satisfy the plan validator minimum.';

class FailingAdapter implements ModelAdapter {
  readonly name = 'mock' as const;
  private retryable: boolean;
  constructor(retryable: boolean) {
    this.retryable = retryable;
  }
  complete(_req: CompletionRequest): Promise<CompletionResult> {
    return Promise.reject(new AdapterError('mock', 'simulated adapter outage', this.retryable));
  }
}

function startServer(router: Router): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const handled = await router.dispatch(req, res);
      if (!handled) errorJson(res, 404, 'NOT_FOUND', 'no route');
    });
    server.listen(0, () => {
      resolve({ base: `http://localhost:${(server.address() as AddressInfo).port}`, close: () => server.close() });
    });
  });
}

test('planning adapter errors release the claim; exhaustion fails the objective WITH a notification', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['ceo']);
  const objective = createObjective(env.db, env.cfg, { title: 'planning outage objective' });

  // Retryable outages: the claim is released each time (never stuck in
  // 'planning' with a renewing lease), bounded by the replan budget.
  for (let i = 0; i < env.cfg.maxReplans; i++) {
    const claimed = claimNextPlanningObjective(env.db, env.cfg, 'w1');
    assert.equal(claimed?.id, objective.id, `attempt ${i + 1} claims the objective`);
    await runPlanningForObjective(env.db, new FailingAdapter(true), objective.id);
    const row = env.db.get<{ status: string; claimed_by: string | null }>(
      'SELECT status, claimed_by FROM objectives WHERE id = ?', objective.id);
    assert.equal(row?.status, 'open', 'objective released back to open, not deadlocked in planning');
    assert.equal(row?.claimed_by, null);
  }
  // Budget exhausted: honest failure + owner notification + finished event.
  claimNextPlanningObjective(env.db, env.cfg, 'w1');
  await runPlanningForObjective(env.db, new FailingAdapter(true), objective.id);
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objective.id)?.status, 'failed');
  const notification = env.db.get<{ kind: string; body: string }>(
    `SELECT kind, body FROM notifications WHERE kind = 'objective_failed' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(notification, 'owner is notified of the planning failure');
  assert.match(notification!.body, /simulated adapter outage/);
  assert.ok(env.db.get(`SELECT id FROM execution_events WHERE type = 'objective.finished'`), 'objective.finished emitted');
});

test('unpromoted CEO (no active prompt) fails the objective honestly instead of deadlocking', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  // No activateAgents: getActiveAgentPrompt('ceo') throws — previously this
  // crashed the branch and left the objective claimed in 'planning' forever.
  const objective = createObjective(env.db, env.cfg, { title: 'no ceo prompt' });
  claimNextPlanningObjective(env.db, env.cfg, 'w1');
  const outcome = await runPlanningForObjective(env.db, new MockAdapter(), objective.id);
  assert.equal(outcome.status, 'error');
  const row = env.db.get<{ status: string; claimed_by: string | null }>(
    'SELECT status, claimed_by FROM objectives WHERE id = ?', objective.id);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.claimed_by, null);
  assert.ok(env.db.get(`SELECT id FROM notifications WHERE kind = 'objective_failed'`), 'owner notified with the reason');
});

test('baseline prompt activation unblocks a fresh install (agents usable before any eval)', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const activated = activateBaselineAgentPrompts(env.db, env.cfg.orgId);
  assert.ok(activated.includes('ceo'), 'ceo baseline activated');
  const inactive = env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE lifecycle != 'active'`);
  assert.equal(inactive?.n, 0, 'every agent is assignable after baseline activation');
  // Planning now runs end-to-end (mock proposes an honest empty plan).
  const objective = createObjective(env.db, env.cfg, { title: 'fresh install planning' });
  claimNextPlanningObjective(env.db, env.cfg, 'w1');
  const outcome = await runPlanningForObjective(env.db, new MockAdapter(), objective.id);
  assert.equal(outcome.status, 'proposed');
  // Idempotent: a second boot activates nothing new.
  assert.equal(activateBaselineAgentPrompts(env.db, env.cfg.orgId).length, 0);
});

test('terminal task failure cascades: dependents cancelled, objective finalized, owner notified', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const { objectiveId, taskIds } = createConfirmedPlan(env, 'cascade', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([failTurn('cannot do this', ['blocked_hard'])])}`, expected_artifacts: ['a.md'] },
    { step_id: 's2', agent: 'backend', depends_on: ['s1'], spec: SPEC_PAD, expected_artifacts: ['b.md'] },
    { step_id: 's3', agent: 'backend', depends_on: ['s2'], spec: SPEC_PAD, expected_artifacts: ['c.md'] },
  ]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.equal(task?.step_id, 's1');
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.equal(outcome, 'failed');

  const statuses = Object.fromEntries(
    taskIds.map((id) => [env.db.get<{ step_id: string; status: string }>('SELECT step_id, status FROM tasks WHERE id = ?', id)!.step_id,
      env.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', id)!.status]),
  );
  assert.equal(statuses.s1, 'failed');
  assert.equal(statuses.s2, 'cancelled', 'direct dependent cancelled (previously stranded forever)');
  assert.equal(statuses.s3, 'cancelled', 'transitive dependent cancelled');
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objectiveId)?.status, 'failed',
    'objective finalized instead of hanging in_progress');
  assert.ok(env.db.get(`SELECT id FROM notifications WHERE kind = 'objective_failed'`));
});

test('claim-window orphan: expired-lease task with NO execution row is swept back to queued', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const { taskIds } = createConfirmedPlan(env, 'orphan', [
    { step_id: 's1', agent: 'backend', spec: SPEC_PAD, expected_artifacts: ['a.md'] },
  ]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.equal(task?.id, taskIds[0], 'claimed to running');
  // Simulate the worker dying between the claim UPDATE and the executions
  // INSERT: status='running', no executions row, lease expired.
  env.db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', Date.now() - 1000, task!.id);
  sweepExpiredLeases(env.db, env.cfg);
  const row = env.db.get<{ status: string; claimed_by: string | null }>('SELECT status, claimed_by FROM tasks WHERE id = ?', task!.id);
  assert.equal(row?.status, 'queued', 'recovered without an execution row (previously stuck running forever)');
  assert.equal(row?.claimed_by, null);
});

test('owner cancel of the last task finalizes the objective as cancelled (with notification)', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const { objectiveId, taskIds } = createConfirmedPlan(env, 'cancel-final', [
    { step_id: 's1', agent: 'backend', spec: SPEC_PAD, expected_artifacts: ['a.md'] },
  ]);
  const router = new Router();
  registerWriteRoutes(router, env.db);
  const srv = await startServer(router);
  t.after(srv.close);

  const res = await fetch(`${srv.base}/api/tasks/${taskIds[0]}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objectiveId)?.status, 'cancelled',
    'objective finalized on the cancel path (previously stayed in_progress forever)');
  assert.ok(env.db.get(`SELECT id FROM notifications WHERE kind = 'objective_cancelled'`));
});

test('verification substance: placeholders and unclaimed artifacts do not complete tasks', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const { taskIds } = createConfirmedPlan(env, 'substance', [
    { step_id: 's1', agent: 'backend', spec: SPEC_PAD, expected_artifacts: ['report.md'] },
  ]);
  const policy = loadPermissions().backend;
  const base = { taskId: taskIds[0], objectiveId: 'obj', checks: [], workspaceRoot: env.dir, policy, commandTimeoutMs: 5000 };

  // 1-char placeholder: previously PASSED (existence-only check).
  storeArtifact({ db: env.db, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId },
    { taskId: taskIds[0], executionId: null, agentKey: 'backend', name: 'report.md', kind: 'document', content: 'x' });
  const placeholder = verifyCompletion(env.db, { ...base, expectedArtifacts: ['report.md'], claimedArtifacts: ['report.md'] });
  assert.equal(placeholder.passed, false, 'a 1-character artifact must never complete a task');

  // Substantive content but the claim does not list it: still not a pass.
  storeArtifact({ db: env.db, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId },
    { taskId: taskIds[0], executionId: null, agentKey: 'backend', name: 'report.md', kind: 'document', content: '# Report\nReal substantive deliverable content here.' });
  const unclaimed = verifyCompletion(env.db, { ...base, expectedArtifacts: ['report.md'], claimedArtifacts: [] });
  assert.equal(unclaimed.passed, false, 'the completion claim must own its deliverables');

  const honest = verifyCompletion(env.db, { ...base, expectedArtifacts: ['report.md'], claimedArtifacts: ['report.md'] });
  assert.equal(honest.passed, true);

  // Degenerate checks are refused, not vacuously green.
  const empty = verifyCompletion(env.db, {
    ...base, expectedArtifacts: [], claimedArtifacts: [],
    checks: [{ type: 'contains', artifact: 'report.md', needle: ' ' }, { type: 'json_schema', artifact: 'report.md' }],
  });
  assert.equal(empty.passed, false, 'empty needle + missing schema are vacuous checks and must fail');
});

test('write_file satisfies an expected artifact end-to-end (honest work no longer fails verification)', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const script = [
    toolTurn('write_file', { path: 'src/report.md', content: '# Report\nGenuine deliverable written with write_file, substantive content.' }),
    completeTurn('wrote the report', ['report.md']),
  ];
  const { taskIds, objectiveId } = createConfirmedPlan(env, 'write-file-artifact', [
    { step_id: 's1', agent: 'backend', spec: `${SPEC_PAD} ${MOCK(script)}`, expected_artifacts: ['report.md'] },
  ]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.equal(outcome, 'completed', 'write_file deliverable passes verification');
  assert.ok(env.db.get(`SELECT id FROM artifacts WHERE task_id = ? AND name = 'report.md'`, taskIds[0]),
    'workspace file registered as the expected artifact');
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objectiveId)?.status, 'completed');
});

test('health reports the LIVE worker adapter over the server-side probe', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  const hubStub = { clientCount: () => 0, lastSeq: () => 0 } as unknown as SseHub;
  // Server-side probe claims a real adapter — the live worker knows better.
  registerHealthRoute(router, env.db, hubStub, env.cfg, () => ({ name: 'claude-cli', reason: 'server probe' }));
  const srv = await startServer(router);
  t.after(srv.close);

  env.db.run(
    `INSERT INTO workers (id, pid, hostname, started_at, last_heartbeat_at, status, adapter, adapter_reason)
     VALUES ('wrk_test', 1, 'test', ?, ?, 'online', 'mock', 'claude-cli refused by safety canary: PATH')`,
    Date.now(), Date.now(),
  );
  const health = await (await fetch(`${srv.base}/api/health`)).json() as { adapter: { name: string; reason: string } };
  assert.equal(health.adapter.name, 'mock', 'the UI banner must reflect what actually executes tasks');
  assert.match(health.adapter.reason, /reported by the live worker/);

  // Worker gone stale: fall back to the server probe.
  env.db.run(`UPDATE workers SET last_heartbeat_at = ? WHERE id = 'wrk_test'`, Date.now() - env.cfg.staleWorkerMs * 10);
  const after = await (await fetch(`${srv.base}/api/health`)).json() as { adapter: { name: string } };
  assert.equal(after.adapter.name, 'claude-cli');
});
