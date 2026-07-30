// buildBrowserToolServer().callTool against a REAL desktop-bridge daemon
// (started in-process, fake browser backend — this dev environment never
// launches a real browser) reached over real HTTP, same directness as
// tests/integration/desktop-bridge-tools.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
import { buildBrowserToolServer, BROWSER_TOOL_NAMES } from '../../src/tools/browser-tools.ts';
import { ulid } from '../../src/shared/ids.ts';

function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'browser tools test conversation', now, now);
  return id;
}

function enableBrowserBridge(env: ReturnType<typeof makeEnv>, t: import('node:test').TestContext): void {
  const policyPath = join(env.paths.configDir, 'browser-bridge.json');
  const original = readFileSync(policyPath, 'utf8');
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
  t.after(() => writeFileSync(policyPath, original));
}

test('buildBrowserToolServer: registers exactly the documented tool set', () => {
  assert.deepEqual(BROWSER_TOOL_NAMES.slice().sort(), [
    'browser_navigate', 'browser_click', 'browser_fill', 'browser_fill_form', 'browser_get_text',
    'browser_extract', 'browser_wait_for', 'browser_screenshot', 'browser_list_tabs',
    'browser_new_tab', 'browser_switch_tab', 'browser_close_tab',
  ].sort());
});

test('browser tool server: callTool routes through the real daemon and returns a real result', async (t) => {
  const prevBackend = process.env.SIRA_BROWSER_BACKEND;
  process.env.SIRA_BROWSER_BACKEND = 'fake';
  t.after(() => { if (prevBackend === undefined) delete process.env.SIRA_BROWSER_BACKEND; else process.env.SIRA_BROWSER_BACKEND = prevBackend; });
  delete process.env.DESKTOP_BRIDGE_TOKEN;

  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14650;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14650';
  enableBrowserBridge(env, t);
  const conversationId = createConversation(env);

  const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
  t.after(() => daemon.close());
  await new Promise((r) => setTimeout(r, 100));

  const { callTool } = buildBrowserToolServer({ cfg: env.cfg, agentKey: 'sira', conversationId });
  const result = await callTool('navigate', { url: 'https://example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.data?.url, 'https://example.com');

  const row = env.db.get<{ tool: string; agent_key: string; conversation_id: string }>(
    `SELECT tool, agent_key, conversation_id FROM tool_calls WHERE tool = 'browser_navigate' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.tool, 'browser_navigate');
  assert.equal(row?.agent_key, 'sira');
  assert.equal(row?.conversation_id, conversationId);
});

test('browser tool server: unreachable daemon is reported honestly, never thrown', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  // Point at a port nothing is listening on.
  env.cfg.desktopBridgePort = 14651;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14651';
  const conversationId = createConversation(env);

  const { callTool } = buildBrowserToolServer({ cfg: env.cfg, agentKey: 'sira', conversationId });
  const result = await callTool('screenshot', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unreachable/);
});
