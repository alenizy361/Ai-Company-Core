// The desktop-bridge daemon's /atspi/* HTTP surface — /health reporting,
// POST /atspi/:name routing into dispatchAtspiAction, and the enabled-gate.
// Same real-in-process-daemon + real fetch() pattern as
// desktop-bridge-daemon.test.ts, against SIRA_ATSPI_BACKEND=fake (no real
// Python helper or AT-SPI bus touched here).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
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
    id, env.cfg.orgId, 'atspi daemon test conversation', now, now);
  return id;
}

async function enableAtspiBridge(env: ReturnType<typeof makeEnv>, t: import('node:test').TestContext): Promise<void> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const policyPath = join(env.paths.configDir, 'atspi-bridge.json');
  const original = readFileSync(policyPath, 'utf8');
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
  t.after(() => writeFileSync(policyPath, original));
}

test('atspi bridge daemon: /health reports honest fake-backend state alongside the desktop backend', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_ATSPI_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14640;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { atspi: { kind: string; ready: boolean; enabled: boolean } };
    assert.equal(body.atspi.kind, 'fake');
    assert.equal(body.atspi.ready, true);
    assert.equal(body.atspi.enabled, false, 'config/atspi-bridge.json is enabled:false by default');
  });
});

test('atspi bridge daemon: POST /atspi/:name dispatches through the real enforcement point', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_ATSPI_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14641;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const conversationId = createConversation(env);
    await enableAtspiBridge(env, t);

    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/atspi/click`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { name_pattern: 'Save' }, agentKey: 'sira', conversationId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);

    const row = env.db.get<{ tool: string; conversation_id: string }>(
      `SELECT tool, conversation_id FROM tool_calls WHERE tool = 'atspi_click' ORDER BY started_at DESC LIMIT 1`);
    assert.equal(row?.tool, 'atspi_click');
    assert.equal(row?.conversation_id, conversationId);
  });
});

test('atspi bridge daemon: POST /atspi/:name is refused when the feature is disabled', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_ATSPI_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14642;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/atspi/click`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: { name_pattern: 'Save' } }),
    });
    assert.equal(res.status, 403);
  });
});

test('atspi bridge daemon: the shared kill switch also blocks /atspi/:name', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_ATSPI_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14643;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    await enableAtspiBridge(env, t);

    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const killRes = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/kill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(killRes.status, 200);

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/atspi/click`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: { name_pattern: 'Save' } }),
    });
    const body = await res.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /kill switch engaged/);
  });
});
