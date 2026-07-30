// buildWorkflowToolServer().callTool — save/list are DB-direct (no daemon
// needed), run goes through a REAL running daemon (fake browser backend —
// this dev environment never launches a real browser) over real HTTP, same
// directness as tests/integration/desktop-bridge-tools.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { startDesktopDaemon } from '../../src/desktop-bridge/daemon.ts';
import { buildWorkflowToolServer, WORKFLOW_TOOL_NAMES } from '../../src/tools/workflow-tools.ts';
import { ulid } from '../../src/shared/ids.ts';

function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'workflow tools test conversation', now, now);
  return id;
}

function enableBrowserBridge(env: ReturnType<typeof makeEnv>, t: import('node:test').TestContext): void {
  const policyPath = join(env.paths.configDir, 'browser-bridge.json');
  const original = readFileSync(policyPath, 'utf8');
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), enabled: true }));
  t.after(() => writeFileSync(policyPath, original));
}

test('buildWorkflowToolServer: registers exactly the documented tool set', () => {
  assert.deepEqual(WORKFLOW_TOOL_NAMES.slice().sort(), ['workflow_save', 'workflow_list', 'workflow_run'].sort());
});

test('workflow tool server: save then list round-trips without touching the daemon', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);
  const { callTool } = buildWorkflowToolServer({ db: env.db, cfg: env.cfg, orgId: env.cfg.orgId, agentKey: 'sira', conversationId });

  const saveResult = await callTool('save', {
    name: 'my-workflow', kind: 'browser', signature: { urlPattern: 'example\\.com' },
    steps: [{ tool: 'browser_navigate', args: { url: 'https://example.com' } }],
  });
  assert.equal(saveResult.ok, true);
  assert.ok(typeof saveResult.data?.id === 'string');

  const listResult = await callTool('list', {});
  assert.equal(listResult.ok, true);
  const workflows = listResult.data?.workflows as { name: string; kind: string }[];
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].name, 'my-workflow');
  assert.equal(workflows[0].kind, 'browser');
});

test('workflow tool server: save rejects a desktop_* step', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);
  const { callTool } = buildWorkflowToolServer({ db: env.db, cfg: env.cfg, orgId: env.cfg.orgId, agentKey: 'sira', conversationId });

  const result = await callTool('save', {
    name: 'bad', kind: 'browser', signature: {},
    steps: [{ tool: 'desktop_click', args: { x: 1, y: 2 } }],
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not a browser_\* tool/);
});

test('workflow tool server: run routes through the real daemon and replays the saved steps', async (t) => {
  const prevBackend = process.env.SIRA_BROWSER_BACKEND;
  process.env.SIRA_BROWSER_BACKEND = 'fake';
  t.after(() => { if (prevBackend === undefined) delete process.env.SIRA_BROWSER_BACKEND; else process.env.SIRA_BROWSER_BACKEND = prevBackend; });
  delete process.env.DESKTOP_BRIDGE_TOKEN;

  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14680;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14680';
  enableBrowserBridge(env, t);
  const conversationId = createConversation(env);

  const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
  t.after(() => daemon.close());
  await new Promise((r) => setTimeout(r, 100));

  const { callTool } = buildWorkflowToolServer({ db: env.db, cfg: env.cfg, orgId: env.cfg.orgId, agentKey: 'sira', conversationId });
  const saveResult = await callTool('save', {
    name: 'go-to-example', kind: 'browser', signature: {},
    steps: [{ tool: 'browser_navigate', args: { url: 'https://example.com' } }],
  });
  assert.equal(saveResult.ok, true);

  const runResult = await callTool('run', { name: 'go-to-example' });
  assert.equal(runResult.ok, true);
  assert.equal(runResult.data?.stepsCompleted, 1);

  const row = env.db.get<{ tool: string }>(`SELECT tool FROM tool_calls WHERE tool = 'browser_navigate' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.tool, 'browser_navigate');
});

test('workflow tool server: run against an unknown workflow name is reported honestly', async (t) => {
  process.env.SIRA_BROWSER_BACKEND = 'fake';
  t.after(() => { delete process.env.SIRA_BROWSER_BACKEND; });
  delete process.env.DESKTOP_BRIDGE_TOKEN;

  const env = makeEnv();
  t.after(() => env.cleanup());
  env.cfg.desktopBridgePort = 14681;
  env.cfg.desktopBridgeUrl = 'http://127.0.0.1:14681';
  enableBrowserBridge(env, t);
  const conversationId = createConversation(env);

  const daemon = startDesktopDaemon({ db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId });
  t.after(() => daemon.close());
  await new Promise((r) => setTimeout(r, 100));

  const { callTool } = buildWorkflowToolServer({ db: env.db, cfg: env.cfg, orgId: env.cfg.orgId, agentKey: 'sira', conversationId });
  const result = await callTool('run', { name: 'does-not-exist' });
  assert.equal(result.ok, false);
});
