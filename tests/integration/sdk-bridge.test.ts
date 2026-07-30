// Phase 2 security boundary: the live SDK conversation's custom tools
// (write_file/edit_file/run_command/etc, built by src/tools/sdk-bridge.ts's
// buildRoleToolServer) must run through the EXACT SAME enforcement as the
// worker pipeline — policy denial, approval-required blocking-poll, and
// full audit — proven here directly against callTool, independent of any
// live SDK session.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv } from '../helpers/fixtures.ts';
import { loadPermissions } from '../../src/shared/config.ts';
import { buildRoleToolServer } from '../../src/tools/sdk-bridge.ts';
import { ulid } from '../../src/shared/ids.ts';
import type { TestEnv } from '../helpers/fixtures.ts';

// conversation_id is a real FK (migration 008) — a live SDK conversation is
// always attributed to an actual conversations row, never a made-up string.
function createConversation(env: TestEnv): string {
  const id = ulid('cnv');
  const now = Date.now();
  env.db.run('INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, env.cfg.orgId, 'sdk-bridge test conversation', now, now);
  return id;
}

function decideApproval(db: import('../../src/shared/db.ts').Db, approvalId: string, decision: 'approved' | 'rejected'): void {
  db.run(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`, decision, Date.now(), approvalId);
}

function latestApprovalFor(db: import('../../src/shared/db.ts').Db, toolCallId: string): { id: string; status: string } {
  const row = db.get<{ id: string; status: string }>(
    `SELECT id, status FROM approvals WHERE tool_call_id = ? ORDER BY requested_at DESC LIMIT 1`, toolCallId);
  assert.ok(row, 'expected an approval row for this tool call');
  return row!;
}

test('sdk-bridge callTool: denied write is enforced and fully audited with conversation_id', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const cwd = mkdtempSync(join(tmpdir(), 'sira-bridge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const permissions = loadPermissions();
  const conversationId = createConversation(env);

  const { callTool } = buildRoleToolServer({
    db: env.db, cfg: env.cfg, policy: permissions.backend, agentKey: 'backend',
    workspaceRoot: cwd, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId, conversationId,
  });

  const result = await callTool('write_file', { path: 'docs/hack.md', content: 'unauthorized' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /writable paths/);
  assert.ok(!existsSync(join(cwd, 'docs', 'hack.md')), 'denied write never touches disk');

  const row = env.db.get<{ decision: string; conversation_id: string; agent_key: string; tool: string; denial_reason: string }>(
    `SELECT decision, conversation_id, agent_key, tool, denial_reason FROM tool_calls WHERE tool = 'write_file' ORDER BY started_at DESC LIMIT 1`);
  assert.ok(row, 'a tool_calls audit row exists for the denied call');
  assert.equal(row!.decision, 'denied');
  assert.equal(row!.conversation_id, conversationId, 'the live conversation is attributable, unlike a worker execution');
  assert.equal(row!.agent_key, 'backend');
  assert.match(row!.denial_reason, /writable paths/);
});

test('sdk-bridge callTool: allowed write executes for real and is audited as succeeded', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const cwd = mkdtempSync(join(tmpdir(), 'sira-bridge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const permissions = loadPermissions();
  const conversationId = createConversation(env);

  const { callTool } = buildRoleToolServer({
    db: env.db, cfg: env.cfg, policy: permissions.backend, agentKey: 'backend',
    workspaceRoot: cwd, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId, conversationId,
  });

  const result = await callTool('write_file', { path: 'src/probe.ts', content: 'export const probe = 1;\n' });
  assert.equal(result.ok, true);
  const written = join(cwd, 'src', 'probe.ts');
  assert.ok(existsSync(written), 'allowed write actually lands on disk');
  assert.match(readFileSync(written, 'utf8'), /probe = 1/);

  const row = env.db.get<{ decision: string; status: string; conversation_id: string }>(
    `SELECT decision, status, conversation_id FROM tool_calls WHERE tool = 'write_file' AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1`);
  assert.ok(row, 'audit row recorded the successful execution');
  assert.equal(row!.decision, 'allowed');
  assert.equal(row!.conversation_id, conversationId);
});

test('sdk-bridge callTool: approval-required tool blocks until the owner approves, then executes for real', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const cwd = mkdtempSync(join(tmpdir(), 'sira-bridge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const permissions = loadPermissions();
  const conversationId = createConversation(env);

  const { callTool } = buildRoleToolServer({
    db: env.db, cfg: env.cfg, policy: permissions.operations, agentKey: 'operations',
    workspaceRoot: cwd, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId, conversationId,
  });

  const pending = callTool('write_file', { path: 'config/settings.json', content: '{"k":1}' });
  await new Promise((r) => setTimeout(r, 100));
  const toolCallId = env.db.get<{ id: string }>(
    `SELECT id FROM tool_calls WHERE tool = 'write_file' AND status = 'pending_approval' ORDER BY started_at DESC LIMIT 1`)?.id;
  assert.ok(toolCallId, 'the call is parked pending approval, not executed yet');
  assert.ok(!existsSync(join(cwd, 'config', 'settings.json')), 'nothing is written before the owner decides');

  const approval = latestApprovalFor(env.db, toolCallId!);
  assert.equal(approval.status, 'pending');
  decideApproval(env.db, approval.id, 'approved');

  const result = await pending;
  assert.equal(result.ok, true, 'approval unblocks the SAME call — it does not need to be re-issued');
  assert.ok(existsSync(join(cwd, 'config', 'settings.json')), 'the approved write executes for real after the decision');
});

test('sdk-bridge callTool: owner rejection is honored and never executes the tool', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const cwd = mkdtempSync(join(tmpdir(), 'sira-bridge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const permissions = loadPermissions();
  const conversationId = createConversation(env);

  const { callTool } = buildRoleToolServer({
    db: env.db, cfg: env.cfg, policy: permissions.operations, agentKey: 'operations',
    workspaceRoot: cwd, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId, conversationId,
  });

  const pending = callTool('write_file', { path: 'config/rejected.json', content: '{}' });
  await new Promise((r) => setTimeout(r, 100));
  const toolCallId = env.db.get<{ id: string }>(
    `SELECT id FROM tool_calls WHERE tool = 'write_file' AND status = 'pending_approval' ORDER BY started_at DESC LIMIT 1`)?.id;
  assert.ok(toolCallId);
  const approval = latestApprovalFor(env.db, toolCallId!);
  decideApproval(env.db, approval.id, 'rejected');

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /declined/);
  assert.ok(!existsSync(join(cwd, 'config', 'rejected.json')), 'a rejected approval never executes the tool');
});

test('sdk-bridge callTool: an undecided approval times out honestly instead of hanging forever', async (t) => {
  const env = makeEnv();
  t.after(() => env.cleanup());
  const cwd = mkdtempSync(join(tmpdir(), 'sira-bridge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const permissions = loadPermissions();
  const shortTimeoutCfg = { ...env.cfg, approvalTimeoutMs: 200 };
  const conversationId = createConversation(env);

  const { callTool } = buildRoleToolServer({
    db: env.db, cfg: shortTimeoutCfg, policy: permissions.operations, agentKey: 'operations',
    workspaceRoot: cwd, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId, conversationId,
  });

  const result = await callTool('write_file', { path: 'config/never-decided.json', content: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out/);
  assert.ok(!existsSync(join(cwd, 'config', 'never-decided.json')));

  const approval = env.db.get<{ status: string }>(
    `SELECT status FROM approvals WHERE task_id IS NULL AND execution_id IS NULL AND summary LIKE '%never-decided.json%' ORDER BY requested_at DESC LIMIT 1`);
  assert.ok(approval);
  assert.equal(approval!.status, 'expired', 'the abandoned approval is marked expired, not left pending forever');
});

test('sdk-bridge callTool: an approval only ever authorizes the EXACT command it was requested for, never a different or later one', async (t) => {
  // Security property required by the Phase 2 directive: "an approval for
  // one command must not authorize a modified command." args_json is
  // written once at approval-request time and never updated afterward (no
  // UPDATE tool_calls SET args_json anywhere in the codebase) — each
  // approvalId is 1:1 bound to the frozen args snapshot dispatchTool
  // resolved at request time (outcome.args), not re-derived at decision
  // time. Proven concretely here: two DIFFERENT pending approvals exist at
  // once; approving ONE executes only ITS OWN content at ITS OWN path —
  // the other stays untouched and pending.
  const env = makeEnv();
  t.after(() => env.cleanup());
  const cwd = mkdtempSync(join(tmpdir(), 'sira-bridge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const permissions = loadPermissions();
  const conversationId = createConversation(env);

  const { callTool } = buildRoleToolServer({
    db: env.db, cfg: env.cfg, policy: permissions.operations, agentKey: 'operations',
    workspaceRoot: cwd, artifactsDir: env.paths.artifactsDir, orgId: env.cfg.orgId, conversationId,
  });

  const pendingA = callTool('write_file', { path: 'config/a.json', content: '{"who":"a"}' });
  const pendingB = callTool('write_file', { path: 'config/b.json', content: '{"who":"b"}' });
  await new Promise((r) => setTimeout(r, 100));

  const rowA = env.db.get<{ id: string }>(`SELECT id FROM tool_calls WHERE args_json LIKE '%a.json%' AND status = 'pending_approval'`);
  const rowB = env.db.get<{ id: string }>(`SELECT id FROM tool_calls WHERE args_json LIKE '%b.json%' AND status = 'pending_approval'`);
  assert.ok(rowA && rowB, 'two independent pending approvals exist, one per call');
  const approvalA = latestApprovalFor(env.db, rowA!.id);

  // Approve ONLY A's approval row, then wait for A's own call to observe it
  // and finish (its internal poll loop, not a fixed sleep — avoids a race).
  decideApproval(env.db, approvalA.id, 'approved');
  const resultA = await pendingA;
  assert.equal(resultA.ok, true);

  assert.ok(existsSync(join(cwd, 'config', 'a.json')), 'the approved call executed at its own exact path');
  assert.equal(JSON.parse(readFileSync(join(cwd, 'config', 'a.json'), 'utf8')).who, 'a');
  assert.ok(!existsSync(join(cwd, 'config', 'b.json')), 'the UNAPPROVED call never executed — a distinct approval id was required for it');

  const approvalB = latestApprovalFor(env.db, rowB!.id);
  assert.equal(approvalB.status, 'pending', 'B is still awaiting its OWN decision, unaffected by A being approved');

  // Clean up B so it doesn't hang the test process.
  decideApproval(env.db, approvalB.id, 'rejected');
  await pendingB;
});

test('sdk-bridge callTool: parent-session policy (config/permissions.json sira role) has no write/execute tools', () => {
  const permissions = loadPermissions();
  assert.deepEqual(permissions.sira.tools.slice().sort(), ['memory_search', 'memory_write', 'read_artifact', 'task_note', 'write_artifact'].sort());
  assert.ok(!permissions.sira.tools.includes('write_file'));
  assert.ok(!permissions.sira.tools.includes('edit_file'));
  assert.ok(!permissions.sira.tools.includes('run_command'));
  assert.equal(permissions.sira.paths.write.length, 0);
});
