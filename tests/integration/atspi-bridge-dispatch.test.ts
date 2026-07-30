// dispatchAtspiAction() is the single enforcement point for every AT-SPI
// action — this proves its full order of operations: kill-switch first,
// schema validation, full audit trail (allowed AND denied), and honest
// failure handling (including the best-effort failure screenshot). Runs
// entirely against the in-memory fake backend.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { dispatchAtspiAction, type AtspiActionCtx, type AtspiActionName } from '../../src/desktop-bridge/atspi/dispatch.ts';
import { loadAtspiPolicy } from '../../src/desktop-bridge/atspi/policy.ts';
import { FakeAtspiBackend } from '../../src/desktop-bridge/atspi/backends/fake.ts';
import { kill, resume } from '../../src/desktop-bridge/kill-switch.ts';
import { ulid } from '../../src/shared/ids.ts';

// conversation_id is a real FK — a live atspi action is always attributed to
// an actual conversations row, never a made-up string.
function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'atspi-bridge test conversation', now, now);
  return id;
}

function makeCtx(env: ReturnType<typeof makeEnv>, artifactsDir: string, conversationId: string | null): AtspiActionCtx {
  return {
    db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId,
    conversationId, agentKey: 'sira', artifactsDir,
  };
}

// Minimal args satisfying each action's schema — used by the kill-switch
// test, which needs every action type to reach the schema-valid stage so
// the kill switch (not schema validation) is what's actually being proven.
const MINIMAL_ARGS: Record<AtspiActionName, Record<string, unknown>> = {
  list_apps: {},
  find: {},
  click: { name_pattern: 'OK' },
  set_text: { name_pattern: 'Field', text: 'hello' },
  get_text: { name_pattern: 'Field' },
  wait_for: { name_pattern: 'Field' },
};

function withEnv<T extends Record<string, string>>(overrides: T, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) prev[k] = process.env[k];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  });
}

test('dispatchAtspiAction: an allowed click executes, is fully audited, and emits started+succeeded', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-atspi-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadAtspiPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeAtspiBackend();

  const result = await dispatchAtspiAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { app: 'Settings', role: 'push button', name_pattern: 'Save' });
  assert.equal(result.ok, true);
  assert.deepEqual(backend.calls, [{ action: 'click', args: { app: 'Settings', role: 'push button', namePattern: 'Save' } }]);

  const row = env.db.get<{ decision: string; status: string; tool: string; conversation_id: string; agent_key: string }>(
    `SELECT decision, status, tool, conversation_id, agent_key FROM tool_calls WHERE tool = 'atspi_click' ORDER BY started_at DESC LIMIT 1`);
  assert.ok(row);
  assert.equal(row!.decision, 'allowed');
  assert.equal(row!.status, 'succeeded');
  assert.equal(row!.conversation_id, conversationId);
  assert.equal(row!.agent_key, 'sira');

  const events = env.db.all<{ type: string }>(`SELECT type FROM execution_events WHERE type LIKE 'atspi.action.%' ORDER BY seq`);
  assert.deepEqual(events.map((e) => e.type), ['atspi.action.started', 'atspi.action.succeeded']);
});

test('dispatchAtspiAction: click with no name_pattern is denied by schema validation, not passed to the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-atspi-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadAtspiPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeAtspiBackend();

  const result = await dispatchAtspiAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { app: 'Settings' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /invalid arguments/);
  assert.equal(backend.calls.length, 0, 'the backend must never be called for a denied action');

  const row = env.db.get<{ decision: string; denial_reason: string }>(`SELECT decision, denial_reason FROM tool_calls WHERE tool = 'atspi_click' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.decision, 'denied');
  assert.match(row?.denial_reason ?? '', /name_pattern/);
});

test('dispatchAtspiAction: kill switch engaged denies every atspi action type without ever reaching the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-atspi-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadAtspiPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeAtspiBackend();

  kill(env.db, env.paths, env.cfg.orgId, 'test kill');
  for (const [actionName, args] of Object.entries(MINIMAL_ARGS) as [AtspiActionName, Record<string, unknown>][]) {
    const result = await dispatchAtspiAction(makeCtx(env, artifactsDir, conversationId), policy, backend, actionName, args);
    assert.equal(result.ok, false, `${actionName} should be denied`);
    assert.match(result.error ?? '', /kill switch/, `${actionName} should cite the kill switch`);
  }
  assert.equal(backend.calls.length, 0);

  resume(env.db, env.paths, env.cfg.orgId);
  const afterResume = await dispatchAtspiAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'list_apps', {});
  assert.equal(afterResume.ok, true, 'actions succeed again once resumed');
});

test('dispatchAtspiAction: a backend failure is caught, audited as failed, and reported honestly (not thrown)', async (t) => {
  await withEnv({ SIRA_DESKTOP_BACKEND: 'mock' }, async () => {
    const env = makeEnv();
    t.after(() => env.cleanup());
    const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-atspi-art-'));
    t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
    const policy = loadAtspiPolicy();
    const conversationId = createConversation(env);
    const backend = new FakeAtspiBackend();
    backend.failNext = { action: 'click', error: 'simulated atspi backend crash' };

    const result = await dispatchAtspiAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { name_pattern: 'Save' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /simulated atspi backend crash/);
    // The desktop-bridge mock backend is ready under SIRA_DESKTOP_BACKEND=mock,
    // so the best-effort whole-screen failure screenshot succeeds too.
    assert.ok((result.data?.screenshotArtifactId as string | undefined)?.startsWith('art_'));

    const row = env.db.get<{ status: string }>(`SELECT status FROM tool_calls WHERE tool = 'atspi_click' ORDER BY started_at DESC LIMIT 1`);
    assert.equal(row?.status, 'failed');
  });
});
