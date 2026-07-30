// buildDesktopToolServer().callTool against a REAL desktop-bridge daemon
// (started in-process, mock backend — this dev environment has no real
// GNOME session) reached over real HTTP, same directness as
// tests/integration/sdk-bridge.test.ts for the worker-pipeline tool bridge.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
import { buildDesktopToolServer, DESKTOP_TOOL_NAMES, toCallToolResult } from '../../src/tools/desktop-bridge-tools.ts';
import { ulid } from '../../src/shared/ids.ts';

function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'desktop tools test conversation', now, now);
  return id;
}

function enableDesktopBridge(env: ReturnType<typeof makeEnv>, t: import('node:test').TestContext): void {
  const policyPath = join(env.paths.configDir, 'desktop-bridge.json');
  const original = readFileSync(policyPath, 'utf8');
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
  t.after(() => writeFileSync(policyPath, original));
}

test('buildDesktopToolServer: registers exactly the documented tool set', () => {
  assert.deepEqual(DESKTOP_TOOL_NAMES.slice().sort(), [
    'desktop_click', 'desktop_key', 'desktop_move_mouse', 'desktop_open_app',
    'desktop_run_command', 'desktop_scroll', 'desktop_screenshot', 'desktop_type',
  ].sort());
});

test('desktop tool server: callTool routes through the real daemon and returns a real result', async (t) => {
  const prevBackend = process.env.SIRA_DESKTOP_BACKEND;
  process.env.SIRA_DESKTOP_BACKEND = 'mock';
  t.after(() => { if (prevBackend === undefined) delete process.env.SIRA_DESKTOP_BACKEND; else process.env.SIRA_DESKTOP_BACKEND = prevBackend; });
  delete process.env.DESKTOP_BRIDGE_TOKEN;

  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14610;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14610';
  enableDesktopBridge(env, t);
  const conversationId = createConversation(env);

  const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
  t.after(() => daemon.close());
  await new Promise((r) => setTimeout(r, 100));

  const { callTool } = buildDesktopToolServer({ cfg: env.cfg, agentKey: 'sira', conversationId });
  const result = await callTool('click', { x: 5, y: 6 });
  assert.equal(result.ok, true);

  const row = env.db.get<{ tool: string; agent_key: string; conversation_id: string }>(
    `SELECT tool, agent_key, conversation_id FROM tool_calls WHERE tool = 'desktop_click' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.tool, 'desktop_click');
  assert.equal(row?.agent_key, 'sira');
  assert.equal(row?.conversation_id, conversationId);
});

test('desktop tool server: unreachable daemon is reported honestly, never thrown', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  // Point at a port nothing is listening on.
  env.cfg.desktopBridgePort = 14611;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14611';
  const conversationId = createConversation(env);

  const { callTool } = buildDesktopToolServer({ cfg: env.cfg, agentKey: 'sira', conversationId });
  const result = await callTool('screenshot', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unreachable/);
});

test('toCallToolResult: a screenshot ToolResult maps to a real MCP image content block', () => {
  const result = toCallToolResult({ ok: true, data: { base64Png: 'ZmFrZQ==', width: 1920, height: 1080, artifactId: 'art_123' } });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content[0], { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' });
  const meta = JSON.parse((result.content[1] as { text: string }).text);
  assert.deepEqual(meta, { width: 1920, height: 1080, artifactId: 'art_123' });
});

test('toCallToolResult: a non-screenshot success maps to a plain text block', () => {
  const result = toCallToolResult({ ok: true, data: { exit_code: 0, stdout: 'hi' } });
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1);
  assert.equal((result.content[0] as { type: string }).type, 'text');
});

test('toCallToolResult: a failure maps to isError:true with the error message', () => {
  const result = toCallToolResult({ ok: false, error: 'DENIED: kill switch engaged' });
  assert.equal(result.isError, true);
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(body.error, 'DENIED: kill switch engaged');
});
