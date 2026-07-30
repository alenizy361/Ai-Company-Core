// SIRA Agent SDK engine units: the message router maps SDK messages to
// application events correctly (TaskCompleted-style events NEVER become the
// final response), and the speakable transformer strips unspeakable content
// while preserving prose — including fences split across stream deltas.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, activateAgents } from '../helpers/fixtures.ts';
import { SdkMessageRouter } from '../../src/sira/router.ts';
import { SpeakableStream, speakableSentence } from '../../src/sira/speakable.ts';
import { buildSiraAgents, SIRA_AGENT_KEYS } from '../../src/sira/agents.ts';
import { isSensitivePath, isContainedIn } from '../../src/sira/session.ts';

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

test('agent definitions: ONE activation truth — only roster-active agents exist for the SDK', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  // Nothing activated: the SDK session has NO specialists — an inactive
  // agent cannot think anywhere (this was the "agents reply before they are
  // even activated" incoherence).
  assert.equal(Object.keys(buildSiraAgents(env.db, env.cfg, env.paths, env.dir, 'cnv_x').agents).length, 0);

  activateAgents(env.db, ['pm', 'backend']);
  const { agents } = buildSiraAgents(env.db, env.cfg, env.paths, env.dir, 'cnv_x');
  assert.deepEqual(Object.keys(agents).sort(), ['backend', 'pm'], 'exactly the active roster keys, nothing else');
  assert.ok(!SIRA_AGENT_KEYS.includes('ceo'), 'the parent SIRA session is the orchestrator — no CEO subagent');
  assert.ok(SIRA_AGENT_KEYS.every((key) => env.db.get('SELECT key FROM agents WHERE key = ?', key)),
    'every SDK agent key exists in the company roster (no ghost identities)');
  // Security boundary: no SIRA agent — live or delegated — is ever granted
  // the SDK's native Bash / unrestricted Write / unrestricted Edit. Every
  // write/execute capability is a policy-gated mcp__sira-<role>__* tool.
  for (const def of Object.values(agents)) {
    assert.ok(!def.tools?.includes('Bash'), 'no subagent ever gets raw Bash');
    assert.ok(!def.tools?.includes('Write'), 'no subagent ever gets unrestricted Write');
    assert.ok(!def.tools?.includes('Edit'), 'no subagent ever gets unrestricted Edit');
  }
  assert.ok(agents.pm.tools?.some((t) => t.startsWith('mcp__sira-pm__')), 'pm gets its own policy-gated tool server');
  assert.ok(!agents.pm.tools?.some((t) => t.includes('run_command')), 'analysis roles do not get run_command');
  assert.ok(agents.backend.tools?.some((t) => t === 'mcp__sira-backend__edit_file'), 'engineering roles get the policy-gated edit_file, not native Edit');
  assert.ok(agents.backend.tools?.some((t) => t === 'mcp__sira-backend__run_command'), 'engineering roles get the policy-gated run_command');
  for (const def of Object.values(agents)) {
    assert.ok(def.description.length > 20 && def.prompt.includes('never speak to the owner'));
  }
});

// Phase 2 security: native Read/Glob/Grep bypass dispatchTool entirely (SDK
// built-ins), so session.ts's canUseTool enforces sensitive-path denial and
// workspace containment directly. These are the same two checks — unit
// tested in isolation from a live SDK session.
test('isSensitivePath: credential/system paths denied regardless of workspace containment', () => {
  assert.ok(isSensitivePath('/home/owner/.ssh/id_rsa'));
  assert.ok(isSensitivePath('/home/owner/.aws/credentials'));
  assert.ok(isSensitivePath('/home/owner/.config/gcloud/legacy_credentials'));
  assert.ok(isSensitivePath('/home/owner/.docker/config.json'));
  assert.ok(isSensitivePath('/home/owner/.kube/config'));
  assert.ok(isSensitivePath('/home/owner/.gnupg/secring.gpg'));
  assert.ok(isSensitivePath('/workspace/repo/.env'));
  assert.ok(isSensitivePath('/workspace/repo/.env.production'));
  assert.ok(isSensitivePath('/home/owner/.netrc'));
  assert.ok(isSensitivePath('/home/owner/.npmrc'));
  assert.ok(isSensitivePath('/etc/shadow'));
  assert.ok(isSensitivePath('/etc/passwd'));
  assert.ok(isSensitivePath('/etc/sudoers'));
  assert.ok(isSensitivePath('/proc/1/environ'));
  assert.ok(isSensitivePath('/sys/class/net'));
  assert.ok(isSensitivePath('/dev/mem'));
  assert.ok(!isSensitivePath('/workspace/repo/src/index.ts'), 'ordinary source files are not sensitive');
  assert.ok(!isSensitivePath('/workspace/repo/README.md'));
  // A filename that merely CONTAINS "env" as a substring must not false-positive
  // (the pattern requires .env to be the actual basename or a .env.* suffix).
  assert.ok(!isSensitivePath('/workspace/repo/src/environment.ts'));
});

test('isContainedIn: realpath containment defeats traversal and symlink escapes', (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const root = join(env.dir, 'workspace');
  const outside = join(env.dir, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'inside.txt'), 'ok');
  writeFileSync(join(outside, 'secret.txt'), 'nope');

  assert.ok(isContainedIn(join(root, 'inside.txt'), root), 'a real file inside the root is contained');
  assert.ok(isContainedIn(root, root), 'the root itself is contained');
  assert.ok(!isContainedIn(join(outside, 'secret.txt'), root), 'a path outside the root is rejected');
  assert.ok(!isContainedIn(join(root, '..', 'outside', 'secret.txt'), root), 'traversal via .. is rejected');

  symlinkSync(outside, join(root, 'escape-link'));
  assert.ok(!isContainedIn(join(root, 'escape-link', 'secret.txt'), root), 'a symlink inside the root pointing outside is rejected');

  // A not-yet-existing path (e.g. a file about to be written) still resolves
  // via its nearest existing ancestor.
  assert.ok(isContainedIn(join(root, 'not-yet-created.txt'), root), 'a nonexistent path under a contained ancestor is still contained');
  assert.ok(!isContainedIn(join(outside, 'not-yet-created.txt'), root), 'a nonexistent path under an uncontained ancestor is still rejected');
});
