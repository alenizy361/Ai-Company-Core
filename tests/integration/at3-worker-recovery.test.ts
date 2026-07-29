// AT3: kill a real worker process mid-execution. The board must never show
// fake progress (stale heartbeat => offline), the task must stay accurate,
// and a restarted worker must resume it exactly once.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { makeEnv, activateAgents, createConfirmedPlan, toolTurn, completeTurn, MOCK } from '../helpers/fixtures.ts';
import { deriveAgentStatuses } from '../../src/shared/derive.ts';
import { REPO_ROOT } from '../../src/shared/config.ts';

const SPEC_PAD = 'Complete executable specification with concrete definition of done for the recovery scenario.';

function spawnWorker(varDir: string): ChildProcess {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO_ROOT, 'src', 'worker', 'index.ts')], {
    env: {
      ...process.env,
      SIRA_VAR: varDir,
      ADAPTER: 'mock',
      MOCK_TURN_DELAY_MS: '2500',
      SIRA_LEASE_MS: '2000',
      SIRA_HEARTBEAT_MS: '500',
      SIRA_SWEEP_MS: '800',
      SIRA_STALE_WORKER_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('AT3: worker death mid-execution -> honest state -> safe resume without duplication', { timeout: 90000 }, async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const script = [
    toolTurn('write_artifact', { name: 'recovered.md', content: '# DELIVERABLE recovered' }),
    completeTurn('done', ['recovered.md']),
  ];
  const { taskIds } = createConfirmedPlan(env, 'AT3', [{
    step_id: 'slow', agent: 'backend', spec: `${SPEC_PAD} ${MOCK(script)}`,
    expected_artifacts: ['recovered.md'],
    verification: [{ type: 'artifact_exists', artifact: 'recovered.md' }],
  }]);

  // Worker A claims and begins the (slow) first turn.
  const workerA = spawnWorker(env.dir);
  t.after(() => { try { workerA.kill('SIGKILL'); } catch { /* gone */ } });
  let claimed = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const status = env.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', taskIds[0])?.status;
    if (status === 'running') { claimed = true; break; }
  }
  assert.ok(claimed, 'worker A claimed the task');
  await sleep(400); // inside the first slow model turn — before any artifact exists

  workerA.kill('SIGKILL');
  await sleep(300);

  // Task state stays accurate (running under a lease — no invented progress),
  // and the BOARD honestly shows offline because heartbeats stopped.
  const midStatus = env.db.get<{ status: string; attempt_count: number }>(
    'SELECT status, attempt_count FROM tasks WHERE id = ?', taskIds[0]);
  assert.equal(midStatus?.status, 'running');
  assert.equal(midStatus?.attempt_count, 1);
  assert.equal(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts')?.n, 0);
  await sleep(1600); // > stale threshold since last heartbeat
  const derived = deriveAgentStatuses(env.db, env.db.all('SELECT key, lifecycle FROM agents'), 1500);
  assert.equal(derived.backend.status, 'offline', 'dead worker must not show active progress');

  // Worker B restarts: sweeper reaps the expired lease, requeues, re-executes.
  const workerB = spawnWorker(env.dir);
  t.after(() => { try { workerB.kill('SIGKILL'); } catch { /* gone */ } });
  let completed = false;
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    const status = env.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', taskIds[0])?.status;
    if (status === 'completed') { completed = true; break; }
    if (status === 'failed') break;
  }
  assert.ok(completed, 'task completed after worker restart');
  workerB.kill('SIGTERM');

  const executions = env.db.all<{ status: string }>('SELECT status FROM executions ORDER BY started_at');
  assert.deepEqual(executions.map((e) => e.status), ['abandoned', 'completed'], 'first abandoned, second completed — no duplication');
  const finalTask = env.db.get<{ attempt_count: number }>('SELECT attempt_count FROM tasks WHERE id = ?', taskIds[0]);
  assert.equal(finalTask?.attempt_count, 2);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifacts WHERE name = 'recovered.md'`)?.n, 1, 'exactly one artifact');
});
