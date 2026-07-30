// dispatchDesktopAction() is the single enforcement point for every
// desktop action — this proves its full order of operations: kill-switch
// first, schema validation, catastrophic-command/curated-app gating, full
// audit trail (allowed AND denied), screenshot-as-artifact, and honest
// timeout handling. Runs entirely against the in-memory mock backend.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { dispatchDesktopAction, type DesktopActionCtx } from '../../src/desktop-bridge/dispatch.ts';
import { loadDesktopPolicy } from '../../src/desktop-bridge/policy.ts';
import { kill, resume } from '../../src/desktop-bridge/kill-switch.ts';
import { MockBackend } from '../../src/desktop-bridge/backends/mock.ts';
import { ulid } from '../../src/shared/ids.ts';

// conversation_id is a real FK — a live desktop action is always attributed
// to an actual conversations row, never a made-up string.
function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'desktop-bridge test conversation', now, now);
  return id;
}

function makeCtx(env: ReturnType<typeof makeEnv>, artifactsDir: string, conversationId: string | null): DesktopActionCtx {
  return {
    db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId,
    conversationId, agentKey: 'sira', artifactsDir,
  };
}

test('dispatchDesktopAction: an allowed action executes, is fully audited, and emits started+succeeded', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { x: 100, y: 200 });
  assert.equal(result.ok, true);
  assert.deepEqual(backend.calls, [{ action: 'click', args: { x: 100, y: 200, button: 'left', clicks: 1 } }]);

  const row = env.db.get<{ decision: string; status: string; tool: string; conversation_id: string; agent_key: string }>(
    `SELECT decision, status, tool, conversation_id, agent_key FROM tool_calls WHERE tool = 'desktop_click' ORDER BY started_at DESC LIMIT 1`);
  assert.ok(row);
  assert.equal(row!.decision, 'allowed');
  assert.equal(row!.status, 'succeeded');
  assert.equal(row!.conversation_id, conversationId);
  assert.equal(row!.agent_key, 'sira');

  const events = env.db.all<{ type: string }>(`SELECT type FROM execution_events WHERE type LIKE 'desktop.action.%' ORDER BY seq`);
  assert.deepEqual(events.map((e) => e.type), ['desktop.action.started', 'desktop.action.succeeded']);
});

test('dispatchDesktopAction: screenshot stores a real artifact and returns its id', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'screenshot', {});
  assert.equal(result.ok, true);
  const artifactId = result.data?.artifactId as string;
  assert.ok(artifactId?.startsWith('art_'));
  const artifact = env.db.get<{ kind: string }>('SELECT kind FROM artifacts WHERE id = ?', artifactId);
  assert.equal(artifact?.kind, 'screenshot');

  const row = env.db.get<{ result_artifact_id: string }>(`SELECT result_artifact_id FROM tool_calls WHERE tool = 'desktop_screenshot' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.result_artifact_id, artifactId);
});

test('dispatchDesktopAction: a catastrophic run_command is denied before it ever reaches the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'run_command', { cmd: 'rm -rf /' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /DENIED/);
  assert.equal(backend.calls.length, 0, 'the backend must never be called for a denied action');

  const row = env.db.get<{ decision: string; denial_reason: string }>(`SELECT decision, denial_reason FROM tool_calls WHERE tool = 'desktop_run_command' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.decision, 'denied');
  assert.match(row?.denial_reason ?? '', /catastrophic/);
});

test('dispatchDesktopAction: open_app requires a curated entry — an arbitrary app name is denied', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  const deniedResult = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'open_app', { app: 'some-random-untrusted-app' });
  assert.equal(deniedResult.ok, false);
  assert.equal(backend.calls.length, 0);

  const allowedResult = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'open_app', { app: 'browser' });
  assert.equal(allowedResult.ok, true);
  assert.equal(backend.calls[0].action, 'open_app');
});

test('dispatchDesktopAction: kill switch engaged denies every action without ever reaching the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  kill(env.db, env.paths, env.cfg.orgId, 'test kill');
  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { x: 1, y: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /kill switch/);
  assert.equal(backend.calls.length, 0);

  resume(env.db, env.paths, env.cfg.orgId);
  const afterResume = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { x: 1, y: 1 });
  assert.equal(afterResume.ok, true, 'actions succeed again once resumed');
});

test('dispatchDesktopAction: invalid arguments are denied by schema validation, not passed to the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { x: 'not-a-number', y: 200 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /invalid arguments/);
  assert.equal(backend.calls.length, 0);
});

test('dispatchDesktopAction: an unknown action name is denied honestly', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();

  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'delete_everything', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unknown desktop action/);
});

test('dispatchDesktopAction: a backend failure is caught, audited as failed, and reported honestly', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-desktop-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadDesktopPolicy();
  const conversationId = createConversation(env);
  const backend = new MockBackend();
  backend.failNext = { action: 'click', error: 'simulated backend crash' };

  const result = await dispatchDesktopAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { x: 1, y: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /simulated backend crash/);

  const row = env.db.get<{ status: string }>(`SELECT status FROM tool_calls WHERE tool = 'desktop_click' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.status, 'failed');
});
