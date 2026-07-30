// The desktop-bridge daemon's HTTP surface — auth enforcement, /health
// honesty, /actions/:name routing into dispatchDesktopAction, and
// /kill+/resume. Runs the real startDesktopDaemon() in-process against the
// mock backend (SIRA_DESKTOP_BACKEND=mock — this dev environment has no
// real GNOME session) with real fetch() calls, same pattern as this repo's
// existing sidecar-service tests.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
import { isKilled } from '../../src/desktop-bridge/kill-switch.ts';
import { ulid } from '../../src/shared/ids.ts';

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
    id, env.cfg.orgId, 'daemon test conversation', now, now);
  return id;
}

test('desktop-bridge daemon: /health reports honest backend/armed state, no auth token configured', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14601;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; backend: { kind: string }; armed: boolean };
    assert.equal(body.backend.kind, 'mock');
    assert.equal(body.ok, true);
    assert.equal(body.armed, true, 'a fresh env is armed (not killed)');
  });
});

test('desktop-bridge daemon: requires the bearer token when DESKTOP_BRIDGE_TOKEN is set', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', DESKTOP_BRIDGE_TOKEN: 'secret-token' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14602;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const noAuth = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`);
    assert.equal(noAuth.status, 401);

    const wrongAuth = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(rightAuth.status, 200);
  });
});

test('desktop-bridge daemon: POST /actions/:name dispatches through the real enforcement point and returns the result', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14603;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const conversationId = createConversation(env);
    // Enable the feature for this test (file-level config, restored after).
    const { writeFileSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const policyPath = join(env.paths.configDir, 'desktop-bridge.json');
    const original = readFileSync(policyPath, 'utf8');
    writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
    t.after(() => writeFileSync(policyPath, original));

    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/actions/click`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { x: 10, y: 20 }, agentKey: 'sira', conversationId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);

    const row = env.db.get<{ tool: string; conversation_id: string }>(`SELECT tool, conversation_id FROM tool_calls WHERE tool = 'desktop_click' ORDER BY started_at DESC LIMIT 1`);
    assert.equal(row?.tool, 'desktop_click');
    assert.equal(row?.conversation_id, conversationId);
  });
});

test('desktop-bridge daemon: POST /actions/:name is refused when the feature is disabled', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14604;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/actions/click`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: { x: 1, y: 1 } }),
    });
    assert.equal(res.status, 403);
  });
});

test('desktop-bridge daemon: POST /kill then /resume flip the real kill-switch lock file', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14605;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(isKilled(env.paths), false);
    const killRes = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/kill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(killRes.status, 200);
    assert.equal(isKilled(env.paths), true);

    const healthWhileKilled = await (await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`)).json() as { armed: boolean };
    assert.equal(healthWhileKilled.armed, false);

    const resumeRes = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/resume`, { method: 'POST' });
    assert.equal(resumeRes.status, 200);
    assert.equal(isKilled(env.paths), false);
  });
});
