// Per-agent model tiers: role defaults seed once, the owner's override wins
// and is audited, the worker resolves the tier into the actual model passed
// to the adapter, and planning uses the CEO's tier.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv, activateAgents, createConfirmedPlan, completeTurn, MOCK } from '../helpers/fixtures.ts';
import { claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import { modelForTier, resolveAgentModel, converseModel } from '../../src/shared/model-tier.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerWriteRoutes } from '../../src/server/routes/writes.ts';
import type { CompletionRequest, CompletionResult } from '../../src/adapters/types.ts';

const SPEC_PAD = 'Complete executable specification with concrete definition of done for the test scenario at hand.';

test('tier resolution: defaults seeded, override wins, custom carries its model', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());

  // Role defaults from config/agents.json landed at seed time.
  assert.equal(env.db.get<{ model_tier: string }>(`SELECT model_tier FROM agents WHERE key = 'ceo'`)?.model_tier, 'reasoning');
  assert.equal(env.db.get<{ model_tier: string }>(`SELECT model_tier FROM agents WHERE key = 'support'`)?.model_tier, 'fast');

  assert.equal(resolveAgentModel(env.db, env.cfg, 'ceo'), env.cfg.modelTiers.reasoning);
  assert.equal(resolveAgentModel(env.db, env.cfg, 'support'), env.cfg.modelTiers.fast);
  assert.equal(resolveAgentModel(env.db, env.cfg, 'nonexistent'), undefined);

  env.db.run(`UPDATE agents SET model_tier = 'custom', model_custom = 'my-model-x' WHERE key = 'support'`);
  assert.equal(resolveAgentModel(env.db, env.cfg, 'support'), 'my-model-x');

  assert.equal(modelForTier(env.cfg, 'unknown-tier'), undefined);
  assert.equal(converseModel(env.cfg), env.cfg.modelTiers[env.cfg.converseTier]);
});

test('override endpoint: validated, persisted, audited', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerWriteRoutes(router, env.db);
  const server = createServer(async (req, res) => {
    if (!(await router.dispatch(req, res))) errorJson(res, 404, 'NOT_FOUND', 'no route');
  });
  await new Promise<void>((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (key: string, body: object) => fetch(`${base}/api/agents/${key}/model`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post('backend', { tier: 'warp-speed' })).status, 400);
  assert.equal((await post('backend', { tier: 'custom' })).status, 400, 'custom requires customModel');
  assert.equal((await post('ghost', { tier: 'fast' })).status, 404);
  assert.equal((await post('backend', { tier: 'fast' })).status, 200);
  assert.equal(env.db.get<{ model_tier: string }>(`SELECT model_tier FROM agents WHERE key = 'backend'`)?.model_tier, 'fast');
  const auditRow = env.db.get<{ action: string; payload: string }>(
    `SELECT action, payload FROM audit_logs WHERE action = 'agent.model_tier' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(auditRow);
  assert.match(auditRow!.payload, /"to":"fast"/);
});

test('worker passes the resolved model to the adapter', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  env.db.run(`UPDATE agents SET model_tier = 'fast' WHERE key = 'backend'`);

  const captured: (string | undefined)[] = [];
  class CaptureAdapter extends MockAdapter {
    override complete(req: CompletionRequest): Promise<CompletionResult> {
      captured.push(req.model);
      return super.complete(req);
    }
  }
  createConfirmedPlan(env, 'tiers', [{
    step_id: 'tr', agent: 'backend', spec: `${SPEC_PAD} ${MOCK([completeTurn('done', [])])}`,
    expected_artifacts: [],
  }]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  await runExecution(env.db, env.cfg, env.paths, new CaptureAdapter(), task!, 'w1');
  assert.ok(captured.length >= 1);
  assert.equal(captured[0], env.cfg.modelTiers.fast, 'execution used the agent-tier model');
});
