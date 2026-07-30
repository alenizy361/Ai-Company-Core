// buildAtspiToolServer().callTool against a REAL desktop-bridge daemon
// (started in-process, fake AT-SPI backend — this dev environment never
// spawns real Python/AT-SPI) reached over real HTTP, same directness as
// tests/integration/desktop-bridge-tools.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
import { buildAtspiToolServer, ATSPI_TOOL_NAMES } from '../../src/tools/atspi-tools.ts';
import { ulid } from '../../src/shared/ids.ts';

function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'atspi tools test conversation', now, now);
  return id;
}

function enableAtspiBridge(env: ReturnType<typeof makeEnv>, t: import('node:test').TestContext): void {
  const policyPath = join(env.paths.configDir, 'atspi-bridge.json');
  const original = readFileSync(policyPath, 'utf8');
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
  t.after(() => writeFileSync(policyPath, original));
}

test('buildAtspiToolServer: registers exactly the documented tool set', () => {
  assert.deepEqual(ATSPI_TOOL_NAMES.slice().sort(), [
    'atspi_list_apps', 'atspi_find', 'atspi_click', 'atspi_set_text', 'atspi_get_text', 'atspi_wait_for',
  ].sort());
});

test('atspi tool server: callTool routes through the real daemon and returns a real result', async (t) => {
  const prevBackend = process.env.SIRA_ATSPI_BACKEND;
  process.env.SIRA_ATSPI_BACKEND = 'fake';
  t.after(() => { if (prevBackend === undefined) delete process.env.SIRA_ATSPI_BACKEND; else process.env.SIRA_ATSPI_BACKEND = prevBackend; });
  delete process.env.DESKTOP_BRIDGE_TOKEN;

  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14660;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14660';
  enableAtspiBridge(env, t);
  const conversationId = createConversation(env);

  const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
  t.after(() => daemon.close());
  await new Promise((r) => setTimeout(r, 100));

  const { callTool } = buildAtspiToolServer({ cfg: env.cfg, agentKey: 'sira', conversationId });
  const result = await callTool('click', { name_pattern: 'Save' });
  assert.equal(result.ok, true);

  const row = env.db.get<{ tool: string; agent_key: string; conversation_id: string }>(
    `SELECT tool, agent_key, conversation_id FROM tool_calls WHERE tool = 'atspi_click' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.tool, 'atspi_click');
  assert.equal(row?.agent_key, 'sira');
  assert.equal(row?.conversation_id, conversationId);
});

test('atspi tool server: unreachable daemon is reported honestly, never thrown', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  // Point at a port nothing is listening on.
  env.cfg.desktopBridgePort = 14661;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14661';
  const conversationId = createConversation(env);

  const { callTool } = buildAtspiToolServer({ cfg: env.cfg, agentKey: 'sira', conversationId });
  const result = await callTool('list_apps', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unreachable/);
});
