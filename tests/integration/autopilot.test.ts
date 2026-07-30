// Autopilot — the always-working company. Auto-confirmation of proposed
// plans, self-directed work cycles from the owner's standing directive, the
// token-budget pause, and the owner-facing settings API. All against real
// production code paths.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv, activateAgents } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerWriteRoutes } from '../../src/server/routes/writes.ts';
import { runAutopilotSweep } from '../../src/worker/autopilot.ts';
import { createObjective } from '../../src/planning/plan-service.ts';
import { setSetting, getSetting } from '../../src/shared/settings.ts';
import { ulid } from '../../src/shared/ids.ts';

const SPEC = 'A complete executable specification with enough detail to satisfy the plan validator minimum.';

function insertProposedPlan(env: ReturnType<typeof makeEnv>, objectiveId: string): string {
  const planId = ulid('pln');
  const parsed = {
    reply: 'plan ready', team: ['backend'],
    plan: [{
      step_id: 's1', agent: 'backend', title: 'do the work', spec: SPEC,
      depends_on: [], required_inputs: [], expected_artifacts: ['out.md'],
      acceptance_criteria: ['deliverable exists'], verification: [], priority: 3, status: 'queued',
    }],
  };
  env.db.run(
    `INSERT INTO plans (id, objective_id, version, raw_json, reply, status, created_at) VALUES (?, ?, 1, ?, 'plan ready', 'proposed', ?)`,
    planId, objectiveId, JSON.stringify(parsed), Date.now(),
  );
  env.db.run(`UPDATE objectives SET status = 'plan_proposed', updated_at = ? WHERE id = ?`, Date.now(), objectiveId);
  return planId;
}

test('autopilot OFF: proposed plans wait for the owner (nothing auto-confirms)', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  const objective = createObjective(env.db, env.cfg, { title: 'waits for owner' });
  const planId = insertProposedPlan(env, objective.id);
  runAutopilotSweep(env.db, env.cfg);
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM plans WHERE id = ?', planId)?.status, 'proposed');
});

test('autopilot ON: proposed plans confirm automatically, tasks start, owner is notified', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);
  setSetting(env.db, 'autopilot', 'on');
  const objective = createObjective(env.db, env.cfg, { title: 'auto-confirmed objective' });
  const planId = insertProposedPlan(env, objective.id);

  runAutopilotSweep(env.db, env.cfg);

  assert.equal(env.db.get<{ status: string }>('SELECT status FROM plans WHERE id = ?', planId)?.status, 'confirmed');
  assert.equal(env.db.get<{ status: string }>('SELECT status FROM objectives WHERE id = ?', objective.id)?.status, 'in_progress');
  assert.equal(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE objective_id = ?', objective.id)?.n, 1);
  const note = env.db.get<{ title: string }>(`SELECT title FROM notifications WHERE kind = 'autopilot_confirmed'`);
  assert.ok(note, 'auto never means silent — the owner is told what started');
  assert.ok(env.db.get(`SELECT id FROM audit_logs WHERE actor = 'autopilot'`), 'audited as autopilot');
});

test('standing directive: idle board opens a new cycle; gates prevent duplicates', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  setSetting(env.db, 'autopilot', 'on');
  setSetting(env.db, 'autopilot.directive', 'Improve product quality continuously and expand test coverage.');

  runAutopilotSweep(env.db, env.cfg);
  const created = env.db.all<{ id: string; created_by: string; title: string }>(
    `SELECT id, created_by, title FROM objectives WHERE created_by = 'autopilot'`);
  assert.equal(created.length, 1, 'one cycle objective opened from the directive');
  assert.match(created[0].title, /Autopilot cycle/);
  assert.ok(env.db.get(`SELECT id FROM notifications WHERE kind = 'autopilot_cycle'`));

  // Second sweep: the active objective + the time gate both block a duplicate.
  runAutopilotSweep(env.db, env.cfg);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM objectives WHERE created_by = 'autopilot'`)?.n, 1);
});

test('token budget: a hot 5h usage window pauses autopilot with one notification', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  setSetting(env.db, 'autopilot', 'on');
  setSetting(env.db, 'autopilot.directive', 'Anything at all — should NOT start while over budget.');
  const now = Date.now();
  env.db.run(
    `INSERT INTO usage_windows (id, kind, window_start, window_end, input_tokens, output_tokens, request_count, updated_at)
     VALUES (?, 'session_5h', ?, ?, 5000000, 1000000, 1, ?)`,
    ulid('uw'), now - 3600_000, now + 3600_000, now,
  );

  runAutopilotSweep(env.db, env.cfg);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM objectives WHERE created_by = 'autopilot'`)?.n, 0,
    'no new work while the quota window is hot');
  assert.ok(env.db.get(`SELECT id FROM notifications WHERE kind = 'autopilot_paused'`), 'owner told exactly why');
  runAutopilotSweep(env.db, env.cfg);
  assert.equal(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'autopilot_paused'`)?.n, 1,
    'pause notification is not spammed every sweep');
});

test('settings API: allowlisted keys, validation, and readback', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerWriteRoutes(router, env.db);
  const server = createServer(async (req, res) => {
    const handled = await router.dispatch(req, res);
    if (!handled) errorJson(res, 404, 'NOT_FOUND', 'no route');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  t.after(() => server.close());

  assert.equal((await fetch(`${base}/api/settings/autopilot`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'maybe' }),
  })).status, 400, 'autopilot only accepts on/off');
  assert.equal((await fetch(`${base}/api/settings/evil.key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }),
  })).status, 400, 'non-allowlisted keys rejected');

  await fetch(`${base}/api/settings/autopilot`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'on' }),
  });
  await fetch(`${base}/api/settings/autopilot.directive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'ship great software' }),
  });
  assert.equal(getSetting(env.db, 'autopilot'), 'on');
  const settings = await (await fetch(`${base}/api/settings`)).json() as Record<string, unknown>;
  assert.equal(settings.autopilot, 'on');
  assert.equal(settings['autopilot.directive'], 'ship great software');
});
