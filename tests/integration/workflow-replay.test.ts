// replayWorkflow() against FakeBrowserBackend/FakeAtspiBackend — signature
// checking, param substitution, per-step audit via the SAME dispatch
// functions a live call uses, and abort-on-first-failure.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { ulid } from '../../src/shared/ids.ts';
import { saveWorkflow, getWorkflow } from '../../src/desktop-bridge/workflows/store.ts';
import { replayWorkflow } from '../../src/desktop-bridge/workflows/replay.ts';
import { FakeBrowserBackend } from '../../src/desktop-bridge/browser/backends/fake.ts';
import { FakeAtspiBackend } from '../../src/desktop-bridge/atspi/backends/fake.ts';

function createConversation(env: ReturnType<typeof makeEnv>): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'workflow replay test conversation', now, now);
  return id;
}

function browserActionCtx(env: ReturnType<typeof makeEnv>, conversationId: string) {
  return { db: env.db, cfg: env.cfg, paths: env.paths, orgId: env.cfg.orgId, conversationId, agentKey: 'sira', artifactsDir: env.paths.artifactsDir };
}

test('replayWorkflow: browser workflow with no signature runs all steps in order, fully audited', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);

  const { id } = saveWorkflow(env.db, {
    orgId: env.cfg.orgId, name: 'search', kind: 'browser', signature: {},
    steps: [
      { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      { tool: 'browser_fill', args: { selector: '#q', value: 'hello' } },
    ],
  });
  const workflow = getWorkflow(env.db, env.cfg.orgId, 'search')!;
  const backend = new FakeBrowserBackend();

  const result = await replayWorkflow(env.db, workflow, {}, {
    browserActionCtx: browserActionCtx(env, conversationId),
    browserPolicy: { enabled: true, deniedUrlPatterns: [] },
    browserBackend: backend,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stepsCompleted, 2);
  assert.deepEqual(backend.calls.map((c) => c.action), ['navigate', 'fill']);

  const rows = env.db.all<{ tool: string }>(`SELECT tool FROM tool_calls WHERE conversation_id = ? ORDER BY started_at`, conversationId);
  assert.deepEqual(rows.map((r) => r.tool), ['browser_navigate', 'browser_fill']);

  const updated = getWorkflow(env.db, env.cfg.orgId, 'search');
  assert.equal(updated?.run_count, 1);
  assert.equal(updated?.id, id);
});

test('replayWorkflow: a signature mismatch runs ZERO steps', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);

  saveWorkflow(env.db, {
    orgId: env.cfg.orgId, name: 'needs-tab', kind: 'browser',
    signature: { urlPattern: 'this-will-never-match\\.example' },
    steps: [{ tool: 'browser_click', args: { selector: '#x' } }],
  });
  const workflow = getWorkflow(env.db, env.cfg.orgId, 'needs-tab')!;
  const backend = new FakeBrowserBackend(); // only tab-1, about:blank — never matches the pattern

  const result = await replayWorkflow(env.db, workflow, {}, {
    browserActionCtx: browserActionCtx(env, conversationId),
    browserPolicy: { enabled: true, deniedUrlPatterns: [] },
    browserBackend: backend,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stepsCompleted, 0);
  assert.match(result.error ?? '', /signature mismatch/);
  assert.equal(backend.calls.length, 1, 'only the listTabs() signature check touched the backend — click never ran');
  assert.equal(backend.calls[0].action, 'list_tabs');
});

test('replayWorkflow: a step failure aborts the rest and reports how far it got', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);

  saveWorkflow(env.db, {
    orgId: env.cfg.orgId, name: 'flaky', kind: 'browser', signature: {},
    steps: [
      { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      { tool: 'browser_click', args: { selector: '#will-fail' } },
      { tool: 'browser_click', args: { selector: '#never-reached' } },
    ],
  });
  const workflow = getWorkflow(env.db, env.cfg.orgId, 'flaky')!;
  const backend = new FakeBrowserBackend();
  backend.failNext = { action: 'click', error: 'element not found' };

  const result = await replayWorkflow(env.db, workflow, {}, {
    browserActionCtx: browserActionCtx(env, conversationId),
    browserPolicy: { enabled: true, deniedUrlPatterns: [] },
    browserBackend: backend,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stepsCompleted, 1, 'navigate succeeded, click failed, third step never ran');
  assert.match(result.error ?? '', /step 1.*failed/);
  // navigate, the failing click, then a best-effort failure screenshot
  // (click is in SCREENSHOT_ON_FAILURE_ACTIONS) — but never the third click.
  assert.deepEqual(backend.calls.map((c) => c.action), ['navigate', 'click', 'screenshot_page']);
});

test('replayWorkflow: {{param}} placeholders are substituted before dispatch', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);

  saveWorkflow(env.db, {
    orgId: env.cfg.orgId, name: 'parametric', kind: 'browser', signature: {},
    steps: [{ tool: 'browser_fill', args: { selector: '#q', value: 'search for {{term}}' } }],
  });
  const workflow = getWorkflow(env.db, env.cfg.orgId, 'parametric')!;
  const backend = new FakeBrowserBackend();

  const result = await replayWorkflow(env.db, workflow, { term: 'ulid' }, {
    browserActionCtx: browserActionCtx(env, conversationId),
    browserPolicy: { enabled: true, deniedUrlPatterns: [] },
    browserBackend: backend,
  });

  assert.equal(result.ok, true);
  assert.equal(backend.calls[0].args.value, 'search for ulid');
});

test('replayWorkflow: atspi workflow checks appName via listApps and runs when it matches', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const conversationId = createConversation(env);

  saveWorkflow(env.db, {
    orgId: env.cfg.orgId, name: 'files-open', kind: 'atspi',
    signature: { appName: 'Files' }, // FakeAtspiBackend.listApps() always includes 'Files'
    steps: [{ tool: 'atspi_click', args: { name_pattern: 'Open' } }],
  });
  const workflow = getWorkflow(env.db, env.cfg.orgId, 'files-open')!;
  const backend = new FakeAtspiBackend();

  const result = await replayWorkflow(env.db, workflow, {}, {
    atspiActionCtx: browserActionCtx(env, conversationId),
    atspiPolicy: { enabled: true },
    atspiBackend: backend,
  });

  assert.equal(result.ok, true);
  // list_apps for the signature (appName) check, then the actual click step.
  assert.deepEqual(backend.calls.map((c) => c.action), ['list_apps', 'click']);
});
