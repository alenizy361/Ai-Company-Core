// SIRA Phase-1 backend truth extensions: the new real events
// (tool.started, artifact.created, notification.created), the list
// endpoints, and global search.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv, activateAgents, createConfirmedPlan, toolTurn, completeTurn, MOCK } from '../helpers/fixtures.ts';
import { claimNextTask } from '../../src/worker/claims.ts';
import { runExecution } from '../../src/worker/execute.ts';
import { MockAdapter } from '../../src/adapters/mock.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerReadRoutes } from '../../src/server/routes/reads.ts';
import { registerSearchRoutes, searchAll } from '../../src/server/routes/search.ts';
import { ulid } from '../../src/shared/ids.ts';

const SPEC_PAD = 'Complete executable specification with concrete definition of done for the test scenario at hand.';

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

test('new truth events: tool.started precedes terminal, artifact.created, notification.created', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend']);

  const script = [
    toolTurn('write_artifact', { name: 'ev.md', content: '# Events\nDELIVERABLE.' }),
    completeTurn('done', ['ev.md']),
  ];
  createConfirmedPlan(env, 'events', [{
    step_id: 'ev', agent: 'backend', spec: `${SPEC_PAD} ${MOCK(script)}`,
    expected_artifacts: ['ev.md'],
  }]);
  const task = claimNextTask(env.db, env.cfg, 'w1');
  assert.equal(await runExecution(env.db, env.cfg, env.paths, new MockAdapter(), task!, 'w1'), 'completed');

  // tool.started exists for the same toolCallId and precedes the terminal event.
  const started = env.db.all<{ seq: number; payload: string }>(
    `SELECT seq, payload FROM execution_events WHERE type = 'tool.started'`);
  assert.ok(started.length >= 1, 'tool.started emitted');
  for (const s of started) {
    const { toolCallId, tool } = JSON.parse(s.payload) as { toolCallId: string; tool: string };
    assert.ok(tool.length > 0);
    const terminal = env.db.get<{ seq: number }>(
      `SELECT seq FROM execution_events
       WHERE type IN ('tool.succeeded','tool.failed') AND payload LIKE ?`, `%${toolCallId}%`);
    assert.ok(terminal && terminal.seq > s.seq, 'terminal tool event follows tool.started');
  }

  // artifact.created carries the real artifact id.
  const created = env.db.all<{ payload: string }>(`SELECT payload FROM execution_events WHERE type = 'artifact.created'`);
  assert.ok(created.length >= 1);
  const artifactId = (JSON.parse(created[0].payload) as { artifactId: string }).artifactId;
  assert.ok(env.db.get('SELECT id FROM artifacts WHERE id = ?', artifactId), 'artifact row exists');

  // Objective completion produced a notification row AND its SSE event.
  const notifEvents = env.db.all<{ payload: string }>(`SELECT payload FROM execution_events WHERE type = 'notification.created'`);
  assert.ok(notifEvents.length >= 1, 'notification.created emitted');
  const notifId = (JSON.parse(notifEvents[0].payload) as { notificationId: string }).notificationId;
  const row = env.db.get<{ kind: string }>('SELECT kind FROM notifications WHERE id = ?', notifId);
  assert.equal(row?.kind, 'objective_completed');
});

test('list endpoints: /api/tasks, /api/artifacts, /api/conversations', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  activateAgents(env.db, ['backend', 'qa']);
  createConfirmedPlan(env, 'lists', [
    { step_id: 'a', agent: 'backend', spec: `${SPEC_PAD} A` },
    { step_id: 'b', agent: 'qa', depends_on: ['a'], spec: `${SPEC_PAD} B` },
  ]);
  const now = Date.now();
  const convId = ulid('cnv');
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    convId, env.cfg.orgId, 'hello sira', now, now);
  env.db.run(
    `INSERT INTO messages (id, conversation_id, role, modality, lang, content, created_at) VALUES (?, ?, 'user', 'text', 'en', 'hi', ?)`,
    ulid('msg'), convId, now);

  const router = new Router();
  registerReadRoutes(router, env.db);
  const srv = await startServer(router);
  t.after(srv.close);

  const tasks = await (await fetch(`${srv.base}/api/tasks?agent_key=backend`)).json() as { agent_key: string; status: string }[];
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].agent_key, 'backend');
  const queued = await (await fetch(`${srv.base}/api/tasks?status=waiting_for_dependency`)).json() as unknown[];
  assert.equal(queued.length, 1);

  const artifacts = await (await fetch(`${srv.base}/api/artifacts`)).json() as unknown[];
  assert.ok(Array.isArray(artifacts));

  const convs = await (await fetch(`${srv.base}/api/conversations`)).json() as { id: string; message_count: number }[];
  assert.equal(convs.length, 1);
  assert.equal(convs[0].message_count, 1);
});

test('search: tier ranking, LIKE-escape safety, Arabic, validation', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const now = Date.now();
  const orgId = env.cfg.orgId;

  env.db.run(`INSERT INTO objectives (id, org_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'completed', 'test', ?, ?)`,
    ulid('obj'), orgId, 'zzterm finished objective', now - 1000, now - 1000);
  env.db.run(`INSERT INTO objectives (id, org_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'planning', 'test', ?, ?)`,
    ulid('obj'), orgId, 'إطلاق المنتج zzterm', now, now);
  env.db.run(
    `INSERT INTO approvals (id, tool_call_id, execution_id, task_id, summary, requested_at) VALUES (?, NULL, NULL, NULL, ?, ?)`,
    ulid('apr'), 'zzterm pending approval', now);

  const results = searchAll(env.db, 'zzterm', 25);
  assert.ok(results.length >= 3);
  assert.equal(results[0].type, 'approval', 'pending approval ranks first');
  const objIdx = results.findIndex((r) => r.type === 'objective' && r.status === 'planning');
  const doneIdx = results.findIndex((r) => r.type === 'objective' && r.status === 'completed');
  assert.ok(objIdx !== -1 && doneIdx !== -1 && objIdx < doneIdx, 'non-terminal objective outranks terminal');

  // Arabic query matches the Arabic title.
  const ar = searchAll(env.db, 'إطلاق', 25);
  assert.ok(ar.some((r) => r.title.includes('إطلاق')));

  // LIKE metacharacters are literal: 'a%c' must not wildcard-match 'abc'.
  env.db.run(`INSERT INTO objectives (id, org_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, 'abc plain', 'open', 'test', ?, ?)`,
    ulid('obj'), orgId, now, now);
  assert.equal(searchAll(env.db, 'a%c', 25).length, 0, '% is escaped');
  assert.equal(searchAll(env.db, 'a_c', 25).length, 0, '_ is escaped');

  // HTTP validation: q too short.
  const router = new Router();
  registerSearchRoutes(router, env.db);
  const srv = await startServer(router);
  t.after(srv.close);
  assert.equal((await fetch(`${srv.base}/api/search?q=x`)).status, 400);
  const ok = await (await fetch(`${srv.base}/api/search?q=zzterm&limit=2`)).json() as { results: unknown[] };
  assert.equal(ok.results.length, 2, 'limit respected');
});
