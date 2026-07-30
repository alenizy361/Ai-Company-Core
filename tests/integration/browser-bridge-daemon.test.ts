// The desktop-bridge daemon's /browser/* HTTP surface — /health reporting,
// POST /browser/:name routing into dispatchBrowserAction, and the
// enabled-gate. Same real-in-process-daemon + real fetch() pattern as
// desktop-bridge-daemon.test.ts, against SIRA_BROWSER_BACKEND=fake (this dev
// environment never launches a real browser).
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
    id, env.cfg.orgId, 'browser daemon test conversation', now, now);
  return id;
}

async function enableBrowserBridge(env: ReturnType<typeof makeEnv>, t: import('node:test').TestContext): Promise<void> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const policyPath = join(env.paths.configDir, 'browser-bridge.json');
  const original = readFileSync(policyPath, 'utf8');
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
  t.after(() => writeFileSync(policyPath, original));
}

test('browser bridge daemon: /health reports honest fake-backend state alongside the desktop backend', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_BROWSER_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14630;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { browser: { kind: string; ready: boolean; enabled: boolean } };
    assert.equal(body.browser.kind, 'fake');
    assert.equal(body.browser.ready, true);
    assert.equal(body.browser.enabled, false, 'config/browser-bridge.json is enabled:false by default');
  });
});

test('browser bridge daemon: POST /browser/:name dispatches through the real enforcement point', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_BROWSER_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14631;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const conversationId = createConversation(env);
    await enableBrowserBridge(env, t);

    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/browser/navigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { url: 'https://example.com' }, agentKey: 'sira', conversationId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; data: { url: string } };
    assert.equal(body.ok, true);
    assert.equal(body.data.url, 'https://example.com');

    const row = env.db.get<{ tool: string; conversation_id: string }>(
      `SELECT tool, conversation_id FROM tool_calls WHERE tool = 'browser_navigate' ORDER BY started_at DESC LIMIT 1`);
    assert.equal(row?.tool, 'browser_navigate');
    assert.equal(row?.conversation_id, conversationId);
  });
});

test('browser bridge daemon: POST /browser/:name is refused when the feature is disabled', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_BROWSER_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14632;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/browser/navigate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: { url: 'https://example.com' } }),
    });
    assert.equal(res.status, 403);
  });
});

test('browser bridge daemon: the shared kill switch also blocks /browser/:name', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock', SIRA_BROWSER_BACKEND: 'fake' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    env.cfg.desktopBridgePort = 14633;
    delete process.env.DESKTOP_BRIDGE_TOKEN;
    await enableBrowserBridge(env, t);

    const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
    t.after(() => daemon.close());
    await new Promise((r) => setTimeout(r, 100));

    const killRes = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/kill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(killRes.status, 200);

    const res = await fetch(`http://127.0.0.1:${env.cfg.desktopBridgePort}/browser/navigate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: { url: 'https://example.com' } }),
    });
    const body = await res.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /kill switch engaged/);
  });
});
