// Worker-pipeline approval resume: a write_file/edit_file call that requires
// owner approval must, once approved, execute against the SAME resolved
// path dispatchTool checked — not silently miss it. Regression test for a
// real bug found while building the Phase 2 SDK bridge: dispatchTool only
// ever mutates its OWN internal copy of args with __abs/__rel (added during
// path resolution); a caller that resumes execution via executeToolCall
// using its own original args object (e.g. action.args straight from the
// model) loses __abs/__rel entirely, so the write lands at `undefined`
// instead of the approved path. Fixed by having dispatchTool return the
// resolved args on DispatchOutcome and having callers use outcome.args.
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, activateAgents, createConfirmedPlan, toolTurn, completeTurn, MOCK } from '../helpers/fixtures.ts';
import { claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';

const SPEC_PAD = 'Complete executable specification with concrete definition of done for the test scenario at hand.';

async function waitForPendingApproval(env: ReturnType<typeof makeEnv>, tool: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const row = env.db.get<{ id: string }>(
      `SELECT id FROM tool_calls WHERE tool = ? AND status = 'pending_approval' ORDER BY started_at DESC LIMIT 1`, tool);
    if (row) return row.id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no pending_approval tool_calls row appeared in time');
}

test('worker pipeline: an approved write_file executes at the ACTUAL approved path, not a lost/undefined one', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['operations']);

  const script = [
    toolTurn('write_file', { path: 'config/settings.json', content: '{"enabled":true}' }),
    completeTurn('config updated after approval', []),
  ];
  createConfirmedPlan(env, 'operations: adjust a gated config file', [{
    step_id: 'op-change', agent: 'operations',
    spec: `${SPEC_PAD} ${MOCK(script)}`,
  }]);

  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.ok(task);
  const execPromise = runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1');

  const toolCallId = await waitForPendingApproval(env, 'write_file');
  const approval = env.db.get<{ id: string }>(`SELECT id FROM approvals WHERE tool_call_id = ?`, toolCallId);
  assert.ok(approval, 'an approvals row was created for the gated write');
  env.db.run(`UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?`, Date.now(), approval!.id);

  const outcome = await execPromise;
  assert.equal(outcome, 'completed');

  const workspaceRoot = join(env.paths.workspaceDir, task!.objective_id);
  const written = join(workspaceRoot, 'config', 'settings.json');
  assert.ok(existsSync(written), 'the approved write landed at the real, approved path');
  assert.match(readFileSync(written, 'utf8'), /"enabled":true/);

  // The bug this guards against would have written a file literally named
  // "undefined" instead (dirname('undefined') === '.', so it would appear
  // relative to the worker process's actual cwd, never inside the sandbox).
  assert.ok(!existsSync(join(process.cwd(), 'undefined')), 'no stray "undefined" file was created in the process cwd');

  const finalRow = env.db.get<{ status: string; result_summary: string }>(
    `SELECT status, result_summary FROM tool_calls WHERE id = ?`, toolCallId);
  assert.equal(finalRow?.status, 'succeeded');
});
