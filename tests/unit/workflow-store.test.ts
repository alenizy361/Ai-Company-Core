// Pure DB logic for saved_workflows — no daemon, no backend, no dispatch.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { saveWorkflow, listWorkflows, getWorkflow, recordWorkflowRun, validateWorkflowSteps } from '../../src/desktop-bridge/workflows/store.ts';

test('validateWorkflowSteps: rejects an empty step list', () => {
  const result = validateWorkflowSteps('browser', []);
  assert.equal(result.ok, false);
});

test('validateWorkflowSteps: rejects a step whose tool does not match the workflow kind', () => {
  const result = validateWorkflowSteps('browser', [{ tool: 'desktop_click', args: { x: 1, y: 2 } }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not a browser_\* tool/);
});

test('validateWorkflowSteps: accepts matching-prefix steps', () => {
  assert.deepEqual(validateWorkflowSteps('browser', [{ tool: 'browser_navigate', args: { url: 'https://x' } }]), { ok: true });
  assert.deepEqual(validateWorkflowSteps('atspi', [{ tool: 'atspi_click', args: { name_pattern: 'Save' } }]), { ok: true });
});

test('saveWorkflow: rejects a desktop_* step even via the DB entry point, never inserts a row', () => {
  const env = makeEnv();
  try {
    assert.throws(() => saveWorkflow(env.db, {
      orgId: env.cfg.orgId, name: 'bad', kind: 'browser',
      signature: { urlPattern: 'example.com' }, steps: [{ tool: 'desktop_click', args: { x: 1, y: 2 } }],
    }), /not a browser_\* tool/);
    assert.equal(listWorkflows(env.db, env.cfg.orgId).length, 0);
  } finally {
    env.cleanup();
  }
});

test('saveWorkflow + getWorkflow + listWorkflows: round-trips a real row', () => {
  const env = makeEnv();
  try {
    const { id } = saveWorkflow(env.db, {
      orgId: env.cfg.orgId, name: 'login-to-example', kind: 'browser',
      signature: { urlPattern: 'example\\.com' },
      steps: [{ tool: 'browser_navigate', args: { url: 'https://example.com' } }, { tool: 'browser_click', args: { selector: '#login' } }],
      createdByAgentKey: 'sira',
    });
    assert.ok(id.startsWith('wf_'));

    const fetched = getWorkflow(env.db, env.cfg.orgId, 'login-to-example');
    assert.equal(fetched?.id, id);
    assert.equal(fetched?.kind, 'browser');
    assert.deepEqual(JSON.parse(fetched!.steps_json), [
      { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      { tool: 'browser_click', args: { selector: '#login' } },
    ]);
    assert.equal(fetched?.run_count, 0);
    assert.equal(fetched?.last_run_at, null);

    const listed = listWorkflows(env.db, env.cfg.orgId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'login-to-example');

    const filtered = listWorkflows(env.db, env.cfg.orgId, 'login');
    assert.equal(filtered.length, 1);
    const missed = listWorkflows(env.db, env.cfg.orgId, 'nope');
    assert.equal(missed.length, 0);
  } finally {
    env.cleanup();
  }
});

test('saveWorkflow: saving the same name again updates the definition in place (upsert), keeps the same id', () => {
  const env = makeEnv();
  try {
    const first = saveWorkflow(env.db, {
      orgId: env.cfg.orgId, name: 'reused', kind: 'browser',
      signature: {}, steps: [{ tool: 'browser_navigate', args: { url: 'https://a.example' } }],
    });
    const second = saveWorkflow(env.db, {
      orgId: env.cfg.orgId, name: 'reused', kind: 'browser',
      signature: {}, steps: [{ tool: 'browser_navigate', args: { url: 'https://b.example' } }],
    });
    assert.equal(second.id, first.id);
    const fetched = getWorkflow(env.db, env.cfg.orgId, 'reused');
    assert.deepEqual(JSON.parse(fetched!.steps_json), [{ tool: 'browser_navigate', args: { url: 'https://b.example' } }]);
    assert.equal(listWorkflows(env.db, env.cfg.orgId).length, 1, 'still exactly one row, not a duplicate');
  } finally {
    env.cleanup();
  }
});

test('recordWorkflowRun: increments run_count and stamps last_run_at/last_result_json', () => {
  const env = makeEnv();
  try {
    const { id } = saveWorkflow(env.db, {
      orgId: env.cfg.orgId, name: 'runme', kind: 'atspi',
      signature: { appName: 'Files' }, steps: [{ tool: 'atspi_click', args: { name_pattern: 'Open' } }],
    });
    recordWorkflowRun(env.db, id, JSON.stringify({ ok: true }));
    const fetched = getWorkflow(env.db, env.cfg.orgId, 'runme');
    assert.equal(fetched?.run_count, 1);
    assert.ok(fetched?.last_run_at);
    assert.equal(fetched?.last_result_json, JSON.stringify({ ok: true }));

    recordWorkflowRun(env.db, id, JSON.stringify({ ok: false, error: 'boom' }));
    const fetchedAgain = getWorkflow(env.db, env.cfg.orgId, 'runme');
    assert.equal(fetchedAgain?.run_count, 2);
  } finally {
    env.cleanup();
  }
});
