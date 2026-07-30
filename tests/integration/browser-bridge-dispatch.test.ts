// dispatchBrowserAction() is the single enforcement point for every
// browser action — this proves its full order of operations: kill-switch
// first (SHARED with the desktop bridge), schema validation, denied-URL
// gating on navigate, full audit trail (allowed AND denied), and honest
// failure handling. Runs entirely against the in-memory fake backend.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { dispatchBrowserAction, type BrowserActionCtx } from '../../src/desktop-bridge/browser/dispatch.ts';
import { loadBrowserPolicy } from '../../src/desktop-bridge/browser/policy.ts';
import { kill, resume } from '../../src/desktop-bridge/kill-switch.ts';
import { FakeBrowserBackend } from '../../src/desktop-bridge/browser/backends/fake.ts';
import { ulid } from '../../src/shared/ids.ts';

// conversation_id is a real FK — a live browser action is always attributed
// to an actual conversations row, never a made-up string.
function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'browser-bridge test conversation', now, now);
  return id;
}

function makeCtx(env: ReturnType<typeof makeEnv>, artifactsDir: string, conversationId: string | null): BrowserActionCtx {
  return {
    db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId,
    conversationId, agentKey: 'sira', artifactsDir,
  };
}

test('dispatchBrowserAction: a successful navigate executes, is fully audited, and emits started+succeeded', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-browser-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadBrowserPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeBrowserBackend();

  const result = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'navigate', { url: 'https://example.com' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { tabId: 'tab-1', url: 'https://example.com', title: 'https://example.com' });
  assert.deepEqual(backend.calls, [{ action: 'navigate', args: { url: 'https://example.com', tabId: undefined } }]);

  const row = env.db.get<{ decision: string; status: string; tool: string; conversation_id: string; agent_key: string }>(
    `SELECT decision, status, tool, conversation_id, agent_key FROM tool_calls WHERE tool = 'browser_navigate' ORDER BY started_at DESC LIMIT 1`);
  assert.ok(row);
  assert.equal(row!.decision, 'allowed');
  assert.equal(row!.status, 'succeeded');
  assert.equal(row!.conversation_id, conversationId);
  assert.equal(row!.agent_key, 'sira');

  const events = env.db.all<{ type: string }>(`SELECT type FROM execution_events WHERE type LIKE 'browser.action.%' ORDER BY seq`);
  assert.deepEqual(events.map((e) => e.type), ['browser.action.started', 'browser.action.succeeded']);
});

test('dispatchBrowserAction: invalid arguments are denied by schema validation, not passed to the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-browser-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadBrowserPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeBrowserBackend();

  // navigate requires "url" — omitting it must be denied before the backend ever sees it.
  const result = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'navigate', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /invalid arguments/);
  assert.equal(backend.calls.length, 0);

  const row = env.db.get<{ decision: string }>(`SELECT decision FROM tool_calls WHERE tool = 'browser_navigate' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.decision, 'denied');
});

test('dispatchBrowserAction: navigate to a denied URL is denied via policy, never reaching the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-browser-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadBrowserPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeBrowserBackend();

  const result = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'navigate', { url: 'file:///etc/passwd' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /DENIED/);
  assert.equal(backend.calls.length, 0, 'the backend must never be called for a denied action');

  const row = env.db.get<{ decision: string; denial_reason: string }>(`SELECT decision, denial_reason FROM tool_calls WHERE tool = 'browser_navigate' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.decision, 'denied');
  assert.match(row?.denial_reason ?? '', /denied pattern/);
});

test('dispatchBrowserAction: kill switch engaged denies every browser action type without reaching the backend', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-browser-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadBrowserPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeBrowserBackend();

  kill(env.db, env.paths, env.cfg.orgId, 'test kill');

  const navigateResult = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'navigate', { url: 'https://example.com' });
  assert.equal(navigateResult.ok, false);
  assert.match(navigateResult.error ?? '', /kill switch/);

  const clickResult = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { selector: '#go' });
  assert.equal(clickResult.ok, false);
  assert.match(clickResult.error ?? '', /kill switch/);

  const listTabsResult = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'list_tabs', {});
  assert.equal(listTabsResult.ok, false);
  assert.match(listTabsResult.error ?? '', /kill switch/);

  assert.equal(backend.calls.length, 0);

  resume(env.db, env.paths, env.cfg.orgId);
  const afterResume = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'list_tabs', {});
  assert.equal(afterResume.ok, true, 'actions succeed again once resumed');
});

test('dispatchBrowserAction: a backend failure is caught, audited as failed, and reported honestly', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-browser-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadBrowserPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeBrowserBackend();
  backend.failNext = { action: 'click', error: 'simulated backend crash' };

  const result = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'click', { selector: '#go' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /simulated backend crash/);

  const row = env.db.get<{ status: string }>(`SELECT status FROM tool_calls WHERE tool = 'browser_click' ORDER BY started_at DESC LIMIT 1`);
  assert.equal(row?.status, 'failed');

  // click is a screenshot-on-failure action — the fake's screenshotPage()
  // succeeds, so the failure result should carry a stored screenshot artifact.
  const artifactId = result.data?.screenshotArtifactId as string;
  assert.ok(artifactId?.startsWith('art_'));
  const artifact = env.db.get<{ kind: string }>('SELECT kind FROM artifacts WHERE id = ?', artifactId);
  assert.equal(artifact?.kind, 'browser-failure-screenshot');
});

test('dispatchBrowserAction: an unknown action name is denied honestly', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sira-browser-art-'));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  const policy = loadBrowserPolicy();
  const conversationId = createConversation(env);
  const backend = new FakeBrowserBackend();

  const result = await dispatchBrowserAction(makeCtx(env, artifactsDir, conversationId), policy, backend, 'delete_everything', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unknown browser action/);
  assert.equal(backend.calls.length, 0);
});
