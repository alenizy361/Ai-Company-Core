// Self-development mode: with SIRA_SELF_DEV=1 the objective workspace is the
// repository (test-overridable root) and merged grants let the frontend agent
// modify the interface — while everything outside its grants stays denied by
// the same single enforcement point.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, activateAgents, createConfirmedPlan, toolTurn, completeTurn, MOCK } from '../helpers/fixtures.ts';
import { loadPermissions } from '../../src/shared/config.ts';
import { claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';

const SPEC_PAD = 'Complete executable specification with concrete definition of done for the test scenario at hand.';

function withSelfDev(root: string): () => void {
  process.env.SIRA_SELF_DEV = '1';
  process.env.SIRA_SELF_DEV_ROOT = root;
  return () => {
    delete process.env.SIRA_SELF_DEV;
    delete process.env.SIRA_SELF_DEV_ROOT;
  };
}

test('permission merge: self-dev grants exist only when the flag is on', () => {
  const off = loadPermissions();
  assert.ok(!off.frontend.paths.write.includes('tests/ui/**'), 'no self-dev grants by default');
  assert.ok(!off.backend.commands.some((c) => c.bin === 'git'));

  const restore = withSelfDev('/tmp');
  try {
    const on = loadPermissions();
    assert.ok(on.frontend.paths.write.includes('web/**'));
    assert.ok(on.frontend.paths.write.includes('tests/ui/**'));
    assert.ok(on.backend.paths.write.includes('src/**'));
    assert.ok(on.backend.commands.some((c) => c.bin === 'git' && c.argsPrefix?.[0] === 'commit'));
    assert.ok(on.ux.tools.includes('write_file'), 'ux gains write_file for design work');
  } finally {
    restore();
  }
});

test('frontend agent edits the interface in the repo workspace; out-of-grant writes stay denied', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sira-selfdev-'));
  const restore = withSelfDev(repoRoot);
  t.after(() => {
    restore();
    rmSync(repoRoot, { recursive: true, force: true });
  });
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['frontend']);

  const script = [
    toolTurn('write_file', { path: 'web/js/self-dev-probe.js', content: 'export const improved = true;\n' }),
    toolTurn('write_file', { path: 'src/worker/execute.ts', content: 'sabotage' }), // outside frontend grants
    toolTurn('run_command', { cmd: 'node --check web/js/self-dev-probe.js' }),
    completeTurn('interface change applied and syntax-verified', []),
  ];
  createConfirmedPlan(env, 'self-dev: adjust the interface', [{
    step_id: 'ui-change', agent: 'frontend',
    spec: `${SPEC_PAD} ${MOCK(script)}`,
    verification: [{ type: 'command', cmd: 'node --check web/js/self-dev-probe.js', expect_exit: 0 }],
  }]);

  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.ok(task);
  const outcome = await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');
  assert.equal(outcome, 'completed');

  // The interface edit landed in the (self-dev) repo root and is valid JS.
  const written = join(repoRoot, 'web', 'js', 'self-dev-probe.js');
  assert.ok(existsSync(written), 'interface file written into the repo workspace');
  assert.match(readFileSync(written, 'utf8'), /improved = true/);

  // The out-of-grant write was denied by the single enforcement point.
  const denied = env.db.get<{ denial_reason: string }>(
    `SELECT denial_reason FROM tool_calls WHERE decision = 'denied' AND args_json LIKE '%execute.ts%'`);
  assert.ok(denied, 'src/ write denied for frontend even in self-dev mode');
  assert.ok(!existsSync(join(repoRoot, 'src', 'worker', 'execute.ts')), 'no sabotage file');
});
