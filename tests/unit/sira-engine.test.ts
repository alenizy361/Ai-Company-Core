// SIRA Agent SDK engine units: the message router maps SDK messages to
// application events correctly (TaskCompleted-style events NEVER become the
// final response), and the speakable transformer strips unspeakable content
// while preserving prose — including fences split across stream deltas.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from '../helpers/fixtures.ts';
import { SdkMessageRouter } from '../../src/sira/router.ts';
import { SpeakableStream, speakableSentence } from '../../src/sira/speakable.ts';
import { buildSiraAgents, SIRA_AGENT_KEYS } from '../../src/sira/agents.ts';

test('router: init -> session id captured and persisted event emitted', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new SdkMessageRouter(env.db, env.cfg, 'cnv_x');
  const out = router.route({ type: 'system', subtype: 'init', session_id: 'sdk-123', model: 'claude-sonnet-5', agents: ['product'] });
  assert.equal(out.length, 0);
  assert.equal(router.sdkSessionId, 'sdk-123');
  assert.equal(router.model, 'claude-sonnet-5');
  assert.ok(env.db.get(`SELECT id FROM execution_events WHERE type = 'sira.session.initialized'`));
});

test('router: parent text deltas stream; subagent deltas never reach the owner', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new SdkMessageRouter(env.db, env.cfg, 'cnv_x');
  const parent = router.route({
    type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
  });
  assert.deepEqual(parent, [{ kind: 'delta', text: 'Hello ' }]);
  const sub = router.route({
    type: 'stream_event', parent_tool_use_id: 'tu_1',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'internal' } },
  });
  assert.equal(sub.length, 0, 'subagent partial output is not the owner stream');
});

test('router: Task tool-use maps to agent lifecycle; its completion is NOT a final response', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new SdkMessageRouter(env.db, env.cfg, 'cnv_x');
  const started = router.route({
    type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'tu_agent', name: 'Task', input: { subagent_type: 'product', description: 'propose improvements' } }] },
  });
  assert.deepEqual(started, [{ kind: 'activity', type: 'sira.agent.started', agentKey: 'product' }]);

  const completed = router.route({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_agent' }] },
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind, 'activity', 'a completed task is an internal event, never kind=final');
  assert.equal((completed[0] as { type: string }).type, 'sira.agent.completed');
  assert.ok(env.db.get(`SELECT id FROM execution_events WHERE type = 'sira.agent.completed' AND agent_key = 'product'`));
  // The ONLY final comes from the result message (the parent's own synthesis).
  const final = router.route({ type: 'result', subtype: 'success', result: 'Here is my recommendation…', num_turns: 4, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20 } });
  assert.equal(final[0].kind, 'final');
  assert.match((final[0] as { text: string }).text, /recommendation/);
});

test('router: plain tool use attributes to sira; nested (subagent) tool use attributes to its agent', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const router = new SdkMessageRouter(env.db, env.cfg, 'cnv_x');
  router.route({
    type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'tu_task', name: 'Task', input: { subagent_type: 'qa' } }] },
  });
  const nested = router.route({
    type: 'assistant', parent_tool_use_id: 'tu_task',
    message: { content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: {} }] },
  });
  assert.deepEqual(nested, [{ kind: 'activity', type: 'sira.tool.started', tool: 'Read', agentKey: 'qa' }]);
});

test('speakable: code blocks, URLs, paths, and long ids never reach TTS', () => {
  assert.equal(speakableSentence('Check https://example.com/deep/path?q=1 for details.'), 'Check example.com for details.');
  assert.equal(speakableSentence('I edited src/server/routes/converse.ts today.'), 'I edited converse.ts today.');
  assert.ok(!speakableSentence('The id is cnv_01HZXW8Q3K9P2M4N6R8T0V.').includes('01HZXW8Q'));
  assert.equal(speakableSentence('Run `npm test` now.'), 'Run npm test now.');
});

test('speakable stream: fenced code is suppressed even when the fence splits across deltas', () => {
  const s = new SpeakableStream();
  let out = '';
  for (const chunk of ['I fixed it. `', '``js\nconst x = 1;\n`', '``', ' All tests pass now.']) out += s.push(chunk);
  out += s.flush();
  assert.ok(!out.includes('const x'), 'code body must not be spoken');
  assert.ok(out.includes('I fixed it.') && out.includes('All tests pass now.'), 'prose around the fence survives');
});

test('agent definitions: full roster, no ceo subagent, minimal tools, tier-resolved models', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const agents = buildSiraAgents(env.db, env.cfg);
  assert.ok(SIRA_AGENT_KEYS.length >= 12);
  assert.ok(!('ceo' in agents), 'the parent SIRA session is the orchestrator — no CEO subagent');
  assert.ok(agents.product.tools && !agents.product.tools.includes('Bash'), 'analysis roles do not get Bash');
  assert.ok(agents.backend.tools?.includes('Edit'), 'engineering roles can edit');
  for (const def of Object.values(agents)) {
    assert.ok(def.description.length > 20 && def.prompt.includes('never speak to the owner'));
  }
});
