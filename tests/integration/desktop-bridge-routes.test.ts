// Owner-facing API-server routes (src/server/routes/desktop-bridge.ts):
// kill/resume flip the real lock file AND best-effort notify a real running
// daemon; status/actions are honest read-throughs. Same real-HTTP-server
// pattern as tests/integration/health-chatterbox.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv } from '../helpers/fixtures.ts';
import { Router, errorJson } from '../../src/server/router.ts';
import { registerDesktopBridgeRoutes } from '../../src/server/routes/desktop-bridge.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
import { isKilled } from '../../src/desktop-bridge/kill-switch.ts';
import { ulid } from '../../src/shared/ids.ts';

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

function withEnv<T extends Record<string, string>>(overrides: T, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) prev[k] = process.env[k];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'routes test conversation', now, now);
  return id;
}

test('desktop-bridge routes: kill then resume flip the real lock file, no daemon running', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14620; // nothing listens here
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14620';
  const router = new Router();
  registerDesktopBridgeRoutes(router, env.db, env.cfg, env.paths);
  const srv = await startServer(router);
  t.after(srv.close);

  assert.equal(isKilled(env.paths), false);
  const killRes = await fetch(`${srv.base}/api/desktop-bridge/kill`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test kill' }),
  });
  assert.equal(killRes.status, 200);
  const killBody = await killRes.json() as { ok: boolean; armed: boolean; daemonNotified: boolean };
  assert.equal(killBody.ok, true);
  assert.equal(killBody.armed, false);
  assert.equal(killBody.daemonNotified, false, 'honest about the daemon being unreachable');
  assert.equal(isKilled(env.paths), true);

  const resumeRes = await fetch(`${srv.base}/api/desktop-bridge/resume`, { method: 'POST' });
  assert.equal(resumeRes.status, 200);
  const resumeBody = await resumeRes.json() as { ok: boolean; armed: boolean };
  assert.equal(resumeBody.ok, true);
  assert.equal(resumeBody.armed, true);
  assert.equal(isKilled(env.paths), false);
});

test('desktop-bridge routes: status proxies a real running daemon and reports armed from the local lock file', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14621;
    env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14621';
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const router = new Router();
    registerDesktopBridgeRoutes(router, env.db, env.cfg, env.paths);
    const srv = await startServer(router);
    t.after(srv.close);

    const res = await fetch(`${srv.base}/api/desktop-bridge/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; backend: { kind: string }; armed: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.backend.kind, 'mock');
    assert.equal(body.armed, true);
  });
});

test('desktop-bridge routes: status is honest when the daemon is unreachable', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14622; // nothing listens here
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14622';
  const router = new Router();
  registerDesktopBridgeRoutes(router, env.db, env.cfg, env.paths);
  const srv = await startServer(router);
  t.after(srv.close);

  const res = await fetch(`${srv.base}/api/desktop-bridge/status`);
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; unreachable?: boolean };
  assert.equal(body.ok, false);
  assert.equal(body.unreachable, true);
});

test('desktop-bridge routes: actions lists recent desktop_ tool_calls, newest first, optionally filtered by conversation', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new Router();
  registerDesktopBridgeRoutes(router, env.db, env.cfg, env.paths);
  const srv = await startServer(router);
  t.after(srv.close);

  const convA = createConversation(env);
  const convB = createConversation(env);
  const insert = (id: string, tool: string, conversationId: string, startedAt: number): void => {
    env.db.run(
      `INSERT INTO tool_calls (id, execution_id, task_id, conversation_id, agent_key, turn_index, tool, args_json, decision, status, started_at)
       VALUES (?, NULL, NULL, ?, 'sira', 0, ?, '{}', 'allowed', 'succeeded', ?)`,
      id, conversationId, tool, startedAt,
    );
  };
  insert('tc_1', 'desktop_click', convA, 1000);
  insert('tc_2', 'desktop_screenshot', convB, 2000);
  insert('tc_3', 'desktop_type', convA, 3000);
  // Non-desktop tool call must never appear in this feed.
  env.db.run(
    `INSERT INTO tool_calls (id, execution_id, task_id, conversation_id, agent_key, turn_index, tool, args_json, decision, status, started_at)
     VALUES ('tc_other', NULL, NULL, ?, 'sira', 0, 'read_file', '{}', 'allowed', 'succeeded', 4000)`,
    convA,
  );

  const all = await (await fetch(`${srv.base}/api/desktop-bridge/actions`)).json() as { actions: { id: string; tool: string }[] };
  assert.deepEqual(all.actions.map((a) => a.id), ['tc_3', 'tc_2', 'tc_1']);
  assert.ok(all.actions.every((a) => a.tool.startsWith('desktop_')));

  const filtered = await (await fetch(`${srv.base}/api/desktop-bridge/actions?conversationId=${convA}`)).json() as { actions: { id: string }[] };
  assert.deepEqual(filtered.actions.map((a) => a.id), ['tc_3', 'tc_1']);
});
